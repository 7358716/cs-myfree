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

import { createAdapter, providerRetryPolicy } from './adapter/index.js'
import { DEFAULT_CANDIDATES } from './adapter/index.js'
import { keylessSources, SOURCES, buildOrder } from './pools/registry.js'
import { evaluate, DECISION } from './policy/paid-gate.js'
import { shouldEgress, MODE } from './vision/bridge.js'
import { fuseResults, toHostSources } from './search/fuse.js'
import { PARSERS } from './search/sources.js'
import { readJson, atomicWrite, withDefaults, DEFAULTS } from './config/store.js'

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

/** 插件入口 */
export function apply(ctx, rawConfig = {}) {
  const log = (m) => ctx.logger?.info?.(m)
  const warn = (m) => ctx.logger?.warn?.(m)
  const cfg = withDefaults(rawConfig)

  // ── 组装 adapter ──
  const send = cfg.transportBaseUrl
    ? createFetchTransport({ baseUrl: cfg.transportBaseUrl, headers: cfg.transportHeaders ?? {} })
    : async () => { throw new Error('尚未配置传输层（transportBaseUrl）') }

  const adapter = createAdapter({
    builtin: cfg.chainBase ?? DEFAULT_CANDIDATES,
    overrides: cfg.chain?.overrides ?? [],
    send,
    budget: cfg.budgetTurns ?? {},
    onEvent: (e) => ctx.logger?.debug?.(`[${NAME}] ${e.type}`, e),
  })

  // ── 注册到宿主（唯一入口）──
  ctx.inject(['llm'], (scoped) => {
    if (typeof scoped.llm?.registerAdapter === 'function') {
      scoped.effect(
        () => scoped.llm.registerAdapter('cs-myfree', adapter),
        `${NAME}: adapter`,
      )
      log(`[${NAME}] adapter 已注册（${adapter.describe().chain.length} 条候选）`)
    } else {
      warn(`[${NAME}] 宿主无 registerAdapter，降级为仅内建能力`)
    }
  })

  // ── 搜索 provider（可选，缺 web 服务不影响其他功能）──
  ctx.inject(['web'], (scoped) => {
    if (typeof scoped.web?.registerSearchProvider !== 'function') return
    scoped.effect(
      () => scoped.web.registerSearchProvider(buildSearchProvider(cfg)),
      `${NAME}: search`,
    )
    log(`[${NAME}] 搜索 provider 已注册`)
  })

  log(`[${NAME}] v${VERSION} 已加载`)
}

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

export { createAdapter, providerRetryPolicy, evaluate, DECISION, shouldEgress, MODE, keylessSources, SOURCES, buildOrder, readJson, atomicWrite }
