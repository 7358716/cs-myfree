/**
 * cs-myfree — 插件入口
 *
 * 设计依据：design/08-架构设计方案-v3终版.md
 *
 * ⚠️ 三条纪律：
 *  1. `inject` 只声明必需服务；webServer 等走嵌套 inject（缺则只掉功能）
 *  2. `@deepseek-ai/*` 的 import 只允许出现在 adapter/kernel.js
 *  3. 内联渠道层必须切断 agent 钩子（验收断言见 test/ci-static.sh）
 *
 * @module cs-myfree
 */

import { createAdapter, providerRetryPolicy, DEFAULT_CANDIDATES } from './adapter/index.js'
import { keylessSources, SOURCES, buildOrder } from './pools/registry.js'
import { evaluate, DECISION } from './policy/paid-gate.js'
import { shouldEgress, MODE } from './vision/bridge.js'
import { fuseResults, toHostSources } from './search/fuse.js'
import { PARSERS } from './search/sources.js'
import { readJson, atomicWrite, withDefaults, DEFAULTS } from './config/store.js'
import { guardApply, makeLogger, safeInject, safeEffect, safeRegisterAdapter, safeRegisterSearch, detectHostVersion } from './compat.js'
import { registerCashRoute, CASH_PATH } from './web/cash.js'
import { judge, sendJson } from './web/guard.js'

const NAME = 'cs-myfree'
const VERSION = '0.2.0'

export const name = NAME
export const version = VERSION

/**
 * 传输层：默认实现用全局 fetch（Node 18+ 内置，零依赖）。
 * 抽出来是为了可测试、也为了将来接号池时替换。
 */
export function createFetchTransport({ baseUrl, headers = {}, now = () => Date.now() } = {}) {
  return async function send({ provider, model, messages, signal }) {
    if (!baseUrl) throw new Error('transport 未配置 baseUrl')
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model, messages, stream: true, provider }),
      signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
      err.status = res.status
      throw err
    }
    return parseSse(res.body, now)
  }
}

/** 极简 SSE 解析（零依赖；不完整帧留到下次） */
export async function* parseSse(body, now = () => Date.now()) {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const obj = JSON.parse(payload)
        const delta = obj?.choices?.[0]?.delta ?? {}
        if (delta.reasoning_content) yield { type: 'reasoning-delta', text: delta.reasoning_content, at: now() }
        if (delta.content) yield { type: 'text-delta', text: delta.content, at: now() }
        if (delta.tool_calls) yield { type: 'tool-call-delta', calls: delta.tool_calls, at: now() }
      } catch { /* 忽略心跳/注释行 */ }
    }
  }
}

/**
 * 插件入口（**经 guardApply 包装：任何异常都不会弄坏宿主启动**）
 *
 * 教训：DSH 在插件加载抛错时会报 `N entry did not activate`
 * 并落进恢复模式自动禁用插件 —— 用户表现为「重启就起不来」。
 * 所以这里所有宿主 API 都走 compat 层的安全调用。
 */
export const apply = guardApply(function applyInner(ctx, rawConfig = {}) {
  const log = makeLogger(ctx, NAME)
  const hostVer = detectHostVersion(ctx)
  log.info(`v${VERSION} 启动（宿主 ${hostVer ?? '版本未知'}）`)

  let cfg
  try { cfg = withDefaults(rawConfig ?? {}) }
  catch { cfg = withDefaults({}); log.warn('配置解析失败，已用默认值') }

  // 传输层：没配就给出「不可用」的明确错误，而不是静默失败
  let send
  try {
    send = cfg.transportBaseUrl
      ? createFetchTransport({ baseUrl: cfg.transportBaseUrl, headers: cfg.transportHeaders ?? {} })
      : async () => { throw new Error('尚未配置传输层（transportBaseUrl）') }
  } catch (err) {
    log.warn(`传输层初始化失败：${err?.message ?? err}`)
    send = async () => { throw new Error('传输层不可用') }
  }

  let adapter
  try {
    adapter = createAdapter({
      builtin: cfg.chainBase ?? DEFAULT_CANDIDATES,
      overrides: cfg.chain?.overrides ?? [],
      send,
      budget: cfg.budgetTurns ?? {},
      onEvent: (e) => log.debug(`${e.type}`, e),
    })
  } catch (err) {
    log.error(`adapter 创建失败（跳过注册）：${err?.message ?? err}`)
  }

  // ── 注册到宿主（全部走安全调用）──
  if (adapter) {
    const ok = safeInject(ctx, ['llm'], (scoped) => {
      const registered = safeRegisterAdapter(scoped?.llm, 'cs-myfree', adapter)
      if (registered) log.info(`adapter 已注册（${adapter.describe().chain.length} 条候选）`)
      else log.warn('宿主无 registerAdapter：adapter 未注册（降级为仅内建能力）')
    }, `${NAME}: llm`)
    if (!ok) log.warn('宿主无 inject：跳过 llm 注册')
  }

  // ── 搜索 provider（可选）──
  const searchOk = safeInject(ctx, ['web'], (scoped) => {
    let provider
    try { provider = buildSearchProvider(cfg) }
    catch (err) { log.warn(`搜索 provider 构造失败：${err?.message ?? err}`); return }
    if (safeRegisterSearch(scoped?.web, provider)) log.info('搜索 provider 已注册')
    else log.warn('宿主无 registerSearchProvider：搜索未注册')
  }, `${NAME}: web`)
  if (!searchOk) log.debug('宿主无 inject：跳过搜索注册')

  // ── 余额路由（左下角 chip 的数据源；外部未登录一律 403）──
  const cashOk = safeInject(ctx, ['webServer'], (scoped) => {
    const ws = scoped?.webServer ?? scoped?.get?.('webServer', false)
    if (!ws) { log.debug('无 webServer：余额路由未注册'); return }
    const registered = registerCashRoute(ws, ctx, {
      trustedHosts: cfg.trustedHosts ?? [],
      logger: log,
      helpers: { judge, sendJson },
    })
    if (registered) log.info(`余额路由已注册：${CASH_PATH}（仅回环/已登录可访问）`)
    else log.warn('余额路由注册失败（功能不影响）')
  }, `${NAME}: cash`)
  if (!cashOk) log.debug('宿主无 inject：跳过余额路由')

  log.info('启动完成')
}, NAME)

/** 构造搜索 provider（供宿主调用） */
export function buildSearchProvider(cfg = DEFAULTS, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const ids = cfg.search?.sources ?? DEFAULTS.search.sources
  const budgetMs = cfg.search?.budgetMs ?? DEFAULTS.search.budgetMs

  return {
    id: 'cs-myfree-search',
    available() { return typeof fetchImpl === 'function' },
    async search(request, signal) {
      const query = String(request?.query ?? '').trim()
      if (!query) return { sources: [], content: '' }
      const max = Number(request?.maxResults) || 8

      const tasks = ids.filter((id) => PARSERS[id]).map(async (id) => {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), budgetMs)
        const onAbort = () => ctrl.abort()
        signal?.addEventListener?.('abort', onAbort)
        try {
          const res = await fetchImpl(PARSERS[id].url(query), { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0' } })
          if (!res.ok) throw new Error(`${id} HTTP ${res.status}`)
          const text = await res.text()
          return { source: id, items: PARSERS[id].parse(text) }
        } catch {
          return { source: id, items: [] }   // 单源失败不影响整体
        } finally {
          clearTimeout(timer)
          signal?.removeEventListener?.('abort', onAbort)
        }
      })

      const batches = await Promise.all(tasks)
      const fused = fuseResults(batches, { max })
      return {
        sources: toHostSources(fused),
        content: fused.length ? `共 ${fused.length} 条结果（来自 ${batches.filter((b) => b.items.length).length} 个源）` : '',
      }
    },
  }
}

// ── 对外导出（供宿主/命令行/UI 使用；彼此无隐式依赖）──
export { createAdapter, providerRetryPolicy, evaluate, DECISION, shouldEgress, MODE,
  keylessSources, SOURCES, buildOrder, readJson, atomicWrite }


// ── 供给层 ──
export * as keyless from './pools/keyless/index.js'
export * as channels from './pools/channels/protocols.js'
export { buildAuthHeaders, joinUrl, streamChat as channelStream } from './pools/channels/driver.js'
export { createPool, STATE as ACCOUNT_STATE } from './pools/channels/pool.js'
export { isDue as checkinDue, summarize as checkinSummary, nextRunAt } from './pools/channels/checkin.js'
export { planRefresh, auditCredentials } from './pools/channels/refresh.js'
export { rankCandidates, buildAggregatePanel, EXPIRY_CAPABLE } from './pools/aggregate.js'

// ── 网关 ──
export { createGateway, DEFAULT_PORT, MAX_BODY_BYTES } from './gateway/server.js'
export { createAuthorizer, generateKey, safeEqual, validateListenHost } from './gateway/auth.js'
export * as formats from './gateway/formats.js'

// ── 省 Token / 运维 / 账本 ──
export { compressToolOutput, createSavingsTracker } from './saver/rtk.js'
export { verifySignature, planAtomicReplace, planRollback, rollbackResult } from './ops/updater.js'
export { check as checkAction, ACTION, VERDICT, DEFAULT_POLICY } from './ops/trust.js'
export { buildBackup, validateBackup, diffImport } from './ops/backup.js'
export { createFeedStore, planReload, RELOAD_SCOPE } from './ops/feed.js'
export { makeRecord, aggregate as aggregateLedger, spentToday, spentThisMonth, failureBreakdown, dateKeyCN } from './audit/ledger.js'
