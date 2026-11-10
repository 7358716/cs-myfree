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

import { createAdapter, providerRetryPolicy, DEFAULT_CANDIDATES, PROVIDER_ID, providerAliases } from './adapter/index.js'
import { installRequestErrorHandler } from './adapter/request-error.js'
import { mergeChain, normalizeChainAliases } from './adapter/chain-overrides.js'
import { streamWithFallback, PRIORITY as KEYLESS_PRIORITY, DEFAULT_MODEL as KEYLESS_MODEL } from './pools/keyless/index.js'
import { ADAPTERS as KEYLESS_ADAPTERS, resolveSourceId } from './pools/keyless/index.js'
import { keylessSources, SOURCES, buildOrder } from './pools/registry.js'
import { evaluate, DECISION } from './policy/paid-gate.js'
import { shouldEgress, MODE } from './vision/bridge.js'
import { preprocessImages, createDescribeCache } from './vision/pipeline.js'
import { fuseResults, toHostSources } from './search/fuse.js'
import { PARSERS } from './search/sources.js'
import { readJson, atomicWrite, withDefaults, DEFAULTS, stripSensitive } from './config/store.js'
import { guardApply, makeLogger, safeInject, safeEffect, safeProvide, safeRegisterAdapter, safeRegisterSearch, detectHostVersion } from './compat.js'
import { registerCashRoute, CASH_PATH, queryCash, queryArkOfficial, resolveVolcAkSk } from './web/cash.js'
import { judge, sendJson } from './web/guard.js'
import { registerRoutes, PREFIX as API_PREFIX } from './web/routes.js'
import { appendRecord } from './audit/sources.js'
import { createState } from './web/state.js'
import { randomUUID } from 'node:crypto'
import { createAccountStore } from './pools/channels/accounts.js'
import { readCachedModels, channelModelsAsList, parseModelId, makeModelId, refreshAll } from './pools/channels/catalog.js'
import { streamChat as channelStream } from './pools/channels/driver.js'
import { CHANNELS, AUTH } from './pools/channels/protocols.js'
import { createHintRegistry, installGlobalHints, HINTS_VERSION } from './adapter/routing-hints.js'
import { getSharedGate, snapshotStats, DEFAULT_LIMITS } from './adapter/concurrency.js'
import { createRoutingSnapshot } from './web/routing.js'
import { getSharedBlacklist } from './adapter/blacklist.js'
import {
  createCheckinScheduler, createCheckinExecutor, readCheckinState, writeCheckinState,
} from './pools/channels/checkin.js'
import { createRefreshScheduler } from './pools/channels/refresh.js'
import { refreshLogin } from './pools/channels/login/refresh.js'
import { fetchAllCredits } from './pools/channels/credits/index.js'

const NAME = 'cs-myfree'
const VERSION = '1.9.22'

export const name = NAME
export const version = VERSION

/**
 * 从宿主配置组装并发闸门覆盖参数（design/21 §4）。
 * 缺省/非法值一律忽略 ⇒ 走 concurrency.js 默认（fail-open，默认行为零变化）。
 * @param {object} cfg 插件配置（可能无 sources/routing 段）
 * @returns {{limits?:object, busyCooldownMs?:number, rateLimitCooldownMs?:number}}
 */
export function concurrencyGateOpts(cfg = {}) {
  const out = {}
  const limits = cfg?.sources?.limits
  if (limits && typeof limits === 'object' && !Array.isArray(limits)) {
    const entries = Object.entries(limits).filter(([, v]) => Number.isFinite(Number(v)) && Number(v) > 0)
    if (entries.length > 0) {
      // 部分覆盖也安全：基于默认表浅合并（未列的渠道仍走默认上限/default:2）
      out.limits = { ...DEFAULT_LIMITS, ...Object.fromEntries(entries.map(([k, v]) => [k, Number(v)])) }
    }
  }
  const c = Number(cfg?.routing?.cooldownMs)
  if (Number.isFinite(c) && c >= 0) out.busyCooldownMs = c
  const r = Number(cfg?.routing?.rateCooldownMs)
  if (Number.isFinite(r) && r >= 0) out.rateLimitCooldownMs = r
  return out
}

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

/** OpenAI usage → 宿主 TokenUsage（字段名对齐 dsh-llm TokenUsage） */
export function toUsage(u = {}) {
  const out = {
    inputTokens: Number(u.prompt_tokens ?? u.inputTokens ?? u.input_tokens) || 0,
    outputTokens: Number(u.completion_tokens ?? u.outputTokens ?? u.output_tokens) || 0,
  }
  const total = Number(u.total_tokens ?? u.totalTokens)
  if (Number.isFinite(total)) out.totalTokens = total
  const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.cacheReadTokens ?? u.cached_tokens)
  if (Number.isFinite(cached)) out.cacheReadTokens = cached
  return out
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
        // 用量：OpenAI 兼容端点在末帧带顶层 usage（choices 通常为空数组）
        if (obj.usage) yield { type: 'usage', usage: toUsage(obj.usage), at: now() }
      } catch { /* 忽略心跳/注释行 */ }
    }
  }
}

/**
 * 纯函数：一条候选该走「渠道」还是「免密源」，以及规范化后的模型 id。
 *
 * 三种写法都要能走通（profile 的「17 条渠道链」通常写成第 2 种）：
 *   ① model = `codearts/deepseek-v4-pro`（选择器里的规范 id）
 *   ② {provider:'codearts', model:'deepseek-v4-pro'}（渠道 + 裸模型名）
 *   ③ {provider:'kilo', model:'kilo-auto/free'}（免密源）
 */
export function routeTarget({ provider, model } = {}) {
  const parsed = parseModelId(model)
  if (parsed) return { kind: 'channel', channelId: parsed.channelId, modelId: parsed.modelId, model }
  const p = String(provider ?? '')
  if (CHANNELS[p]) {
    return { kind: 'channel', channelId: p, modelId: String(model ?? ''), model: makeModelId(p, model) }
  }
  return { kind: 'keyless', provider: p, model }
}

/**
 * 插件入口（**经 guardApply 包装：任何异常都不会弄坏宿主启动**）
 *
 * 教训：DSH 在插件加载抛错时会报 `N entry did not activate`
 * 并落进恢复模式自动禁用插件 —— 用户表现为「重启就起不来」。
 * 所以这里所有宿主 API 都走 compat 层的安全调用。
 */
/**
 * 宿主 content 块数组 → 纯文本（system / tool 结果用）。
 * 图片/文件等非文本块不进入 tool 结果正文（宿主已把它们投影成文字）。
 */
function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/** 宿主 ToolSchema[] → OpenAI tools[]（不改字段语义，只换外壳） */
export function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const out = []
  for (const t of tools) {
    if (!t || typeof t.name !== 'string' || t.name.trim() === '') continue
    const parameters = (t.parameters && typeof t.parameters === 'object' && !Array.isArray(t.parameters))
      ? t.parameters
      : { type: 'object', properties: {} }
    out.push({
      type: 'function',
      function: {
        name: t.name,
        description: typeof t.description === 'string' ? t.description : '',
        parameters,
      },
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * 宿主 messages → OpenAI 兼容格式。
 *
 * 🔴 这是「模型没法用」的核心根因：旧实现只处理 text/image，
 *    **assistant 的 tool-call 块与 role:'tool' 的结果消息被整体丢弃** ⇒
 *    模型看不到自己上一轮调过什么、工具返回了什么，自然无法继续多轮工具会话。
 *
 * 映射规则（宿主 `dsh-llm/lib/types` 实测）：
 *   system    → { role:'system', content:<文本> }
 *   developer → { role:'system', content:<文本> }（工具增删声明走 tools 全量下发，不进消息）
 *   user      → { role:'user', content:<文本|多模态数组> }
 *   assistant → { role:'assistant', content:<文本|null>, tool_calls:[...] }
 *   tool      → { role:'tool', tool_call_id:<id>, content:<文本> }
 *
 * 纯文本仍压成字符串（很多免费端点对数组形式支持不好）。
 */
export function convertMessages(messages, options = {}) {
  const out = []
  const sys = options?.system ?? options?.systemPrompt
  if (typeof sys === 'string' && sys) out.push({ role: 'system', content: sys })

  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue
    const role = m.role

    // ① 工具结果：必须回放成 role:'tool' + tool_call_id，否则模型不知道调用结果
    if (role === 'tool') {
      const id = m.toolCallId ?? m.source?.callId ?? m.tool_call_id
      if (id === undefined || id === null || String(id) === '') continue
      out.push({ role: 'tool', tool_call_id: String(id), content: contentToText(m.content) })
      continue
    }

    // ② system / developer：只取文本；工具更新块由 options.tools 全量声明覆盖
    if (role === 'system' || role === 'developer') {
      const text = contentToText(m.content)
      if (text) out.push({ role: 'system', content: text })
      continue
    }

    const c = m.content
    if (typeof c === 'string') {
      out.push({ role: role === 'assistant' ? 'assistant' : 'user', content: c })
      continue
    }
    if (!Array.isArray(c)) continue

    const parts = []
    const toolCalls = []
    for (const b of c) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text' && b.text) parts.push({ type: 'text', text: String(b.text) })
      else if (b.type === 'image') {
        const url = b.url || (b.data ? `data:${b.mime || 'image/png'};base64,${b.data}` : null)
        if (url) parts.push({ type: 'image_url', image_url: { url } })
      } else if (b.type === 'tool-call') {
        if (!b.name) continue
        toolCalls.push({
          id: String(b.id ?? `call_${toolCalls.length}`),
          type: 'function',
          function: {
            name: String(b.name),
            arguments: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {}),
          },
        })
      }
      // reasoning 块刻意不回传：多数 OpenAI 兼容端点收到会 400
    }

    if (role === 'assistant') {
      const hasParts = parts.length > 0
      if (!hasParts && toolCalls.length === 0) continue
      const plainText = hasParts && parts.every((x) => x.type === 'text')
      const msg = {
        role: 'assistant',
        content: hasParts ? (plainText ? parts.map((x) => x.text).join('\n') : parts) : null,
      }
      if (toolCalls.length > 0) msg.tool_calls = toolCalls
      out.push(msg)
      continue
    }

    if (parts.length === 0) continue
    if (parts.every((x) => x.type === 'text')) out.push({ role: 'user', content: parts.map((x) => x.text).join('\n') })
    else out.push({ role: 'user', content: parts })
  }
  return out
}

export const apply = guardApply(function applyInner(ctx, rawConfig = {}) {
  const log = makeLogger(ctx, NAME)
  const hostVer = detectHostVersion(ctx)
  log.info(`v${VERSION} 启动（宿主 ${hostVer ?? '版本未知'}）`)

  // ── 配置来源：磁盘 config.json（UI 写的）→ patch 配置覆盖（部署项优先）──
  //
  // 🔴 旧实现只信 rawConfig：UI 通过 POST /config 写盘后，重启就回到默认值
  //    （GET /config 也读不到磁盘值）⇒ 用户看到「保存成功，刷新又变回去」。
  const stateStore = createState(rawConfig?.dshHome)
  let persistedConfig = null
  try { persistedConfig = stripSensitive(stateStore.readConfigSync()) } catch { /* 坏文件不影响启动 */ }

  let cfg
  try { cfg = withDefaults({ ...(persistedConfig ?? {}), ...(rawConfig ?? {}) }) }
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

  // ── 内置链（builtin）：cfg.chainBase 优先，否则免密源（装完即可用，无需账号）──
  const defaultChain = Array.isArray(cfg.chainBase) && cfg.chainBase.length > 0
    ? cfg.chainBase
    : KEYLESS_PRIORITY.map((id, i) => ({
      provider: id,
      model: KEYLESS_MODEL[id],
      tier: i < 2 ? 1 : 2,          // kilo/ovh 优先，pollinations 次之
    }))

  // ── 生效链的**唯一事实来源** = ~/.dsh/cs-myfree/chain-overrides.json ──
  //
  // 旧实现的两个断点（用户看到的「降级链是装饰品」）：
  //   ① 只读 cfg.chainBase，profile 的 cordis.patch.yml 里 `chain:` 从未进入 adapter；
  //   ② UI 的 POST /chain 写 chain-overrides.json，但只有 routes.js 读它显示，
  //      adapter 用的是 cfg.chain.overrides ⇒ 页面显示 ≠ 实际选路。
  //
  // 现在：启动时**同步**读覆盖层（adapter 同步创建，异步读会让首轮请求跑在空链上），
  //       文件不存在才用 profile/config 的 chain 播种并立即落盘（让 UI 与 adapter 同源）。
  const configOverrides = Array.isArray(cfg.chain)
    ? cfg.chain
    : (Array.isArray(cfg.chain?.overrides) ? cfg.chain.overrides : [])

  const persistedChain = stateStore.readChainSync()
  const diskOverrides = Array.isArray(persistedChain?.chain) ? persistedChain.chain : []
  const seeded = diskOverrides.length === 0 && configOverrides.length > 0
  let chainOverrides = normalizeChainAliases(
    diskOverrides.length > 0 ? diskOverrides : configOverrides,
    (id) => resolveSourceId(id),
  )
  if (persistedChain === null || seeded) {
    // 播种/首启：把内存里归一后的链写盘，保证「页面看到的 == adapter 用的」
    stateStore.writeChain({ chain: chainOverrides, at: Date.now() })
      .catch(() => {})
  }

  /** 识图描述缓存（同一张图只转述一次） */
  const visionCache = createDescribeCache(200)

  /**
   * 真实发送：先识图预处理，再分发到对应免密源适配器。
   *
   * 识图采用**专用视觉模型转述**（社区主流做法）：
   *   图片 → OVH Qwen2.5-VL → 文字描述 → 注入主模型
   * 这样主模型不需要是多模态，也不会有「静默丢图」问题。
   */
  /** 渠道模型发送：id 形如 `codearts/xxx`，用该渠道的登录凭证发 */
  /**
   * 插件级稳定的 codearts 会话 ID。
   *
   * 为什么需要：上游按 Session-Id 计并发会话数（上限 3）。
   * 若每次请求都换新 ID，名额会被瞬间打满 ⇒ 连续中断。
   * 用稳定 ID ⇒ 同一插件进程的所有请求复用同一会话槽。
   */
  const codeartsSessionId = (() => {
    let id = null
    return () => {
      if (!id) id = randomUUID().replace(/-/g, '')
      return id
    }
  })()

  const sendToChannel = async ({ model, messages, signal, options }) => {
    const parsed = parseModelId(model)
    if (!parsed) throw Object.assign(new Error('无法解析渠道模型：' + model), { code: 'MODEL_NOT_FOUND' })
    const ch = CHANNELS[parsed.channelId]
    if (!ch) throw Object.assign(new Error('未知渠道：' + parsed.channelId), { code: 'MODEL_NOT_FOUND' })

    // 🔑 结构化凭据：AK/SK 渠道要三元组，单字符串渠道要 token
    const secret = typeof accountStore.secretOf === 'function' ? await accountStore.secretOf(parsed.channelId) : null
    const legacy = secret ? null : await accountStore.credentialOf(parsed.channelId)
    if (!secret && !legacy) throw Object.assign(new Error(`渠道 ${parsed.channelId} 尚未登录`), { code: 'AUTH' })
    const cred = secret ?? { token: legacy, ak: String(legacy).split(':')[0], sig: String(legacy).split(':')[1] }

    // 签名型渠道（codearts）：缺 SK 时给出可操作的错误，而不是发出去吃 401
    const extraHeaders = {}
    if (ch.auth === AUTH.SIGNED_HUAWEI) {
      if (!cred.ak || !cred.sk) {
        throw Object.assign(
          new Error(`渠道 ${parsed.channelId} 需要 AK/SK（当前凭据不完整：请用 AK/SK 两步登录重新保存）`),
          { code: 'AUTH' },
        )
      }
      // 🔴 codearts 的上游按 **Session-Id** 计并发会话（硬上限 3 个）。
      //
      //    真实缺陷（2026-11-04 实测）：此前只在宿主传了 sessionId 时才带该头，
      //    连通性测试等路径**没传** ⇒ 每次请求都算一个新会话 ⇒ 3 个名额被
      //    瞬间耗尽 ⇒ 后续请求全部「并发会话已满」，用户看到「连续中断停摆」。
      //
      //    参考包的做法是**适配器级稳定 sessionId**（一个实例一个），
      //    所有请求复用同一会话槽。这里照做：宿主给了 sessionId 就用它
      //    （同一会话内复用），否则退回**插件级稳定 ID**（绝不再每次随机）。
      if (options?.sessionId) {
        extraHeaders['Session-Id'] = String(options.sessionId)
      } else {
        extraHeaders['Session-Id'] = codeartsSessionId()
      }
      // Chat-Id 是**单次对话**标识，随机是正确的（上游用它做 completion id 种子）
      extraHeaders['Chat-Id'] = randomUUID().replace(/-/g, '')
      extraHeaders.lang = 'en'
    }

    let prepared = messages
    try {
      const r = await preprocessImages(messages, {
        mode: cfg.vision?.mode ?? MODE.OFF,
        consented: cfg.vision?.consented === true,
        cache: visionCache,
      })
      prepared = r.messages
    } catch { /* 识图失败不影响 */ }

    return channelStream({
      channelId: parsed.channelId,
      ch,
      cred,
      model: parsed.modelId,
      messages: convertMessages(prepared, options),
      tools: convertTools(options?.tools),
      extraHeaders,
      sessionId: options?.sessionId,
      signal,
    })
  }

  /**
   * 统一发送入口：渠道模型 vs 免密源，自动分流（判定逻辑见 routeTarget）。
   */
  const sendDispatch = async (o) => {
    const target = routeTarget({ provider: o.provider, model: o.model })
    if (target.kind === 'channel') return sendToChannel({ ...o, model: target.model })
    return sendToKeyless(o)
  }

  const sendToKeyless = async ({ provider, model, messages, signal, options }) => {
    // 🔑 归一别名（kilo-free → kilo），否则用户手填旧名字会报「未知供应源」
    const srcId = resolveSourceId(provider)
    const a = KEYLESS_ADAPTERS[srcId]
    if (!a) {
      throw Object.assign(
        new Error(`未知供应源：${provider}（已知：${Object.keys(KEYLESS_ADAPTERS).join('/')}）`),
        { code: 'MODEL_NOT_FOUND' },
      )
    }

    // ① 识图预处理（档位为 off 时只留占位符，不出网）
    let prepared = messages
    try {
      const r = await preprocessImages(messages, {
        mode: cfg.vision?.mode ?? MODE.OFF,
        consented: cfg.vision?.consented === true,
        cache: visionCache,
        onAudit: (e) => log.debug(`vision ${e.ok ? 'ok' : 'fail'} ${e.ms}ms`),
      })
      prepared = r.messages
      if (r.stats.images > 0) {
        log.info(`识图：${r.stats.images} 张（转述 ${r.stats.described}，缓存 ${r.stats.cached}，跳过 ${r.stats.skipped}，失败 ${r.stats.failed}）`)
      }
    } catch (err) {
      log.warn(`识图预处理失败（降级为原样发送）：${err?.message ?? err}`)
    }

    return a.stream({
      model: model || KEYLESS_MODEL[srcId],
      messages: convertMessages(prepared, options),
      // 🔴 宿主 GenerateOptions.tools → OpenAI tools；不传 = 模型永远无法调用工具
      tools: convertTools(options?.tools),
      toolChoice: options?.tools?.length ? 'auto' : undefined,
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      stop: options?.stop,
      signal,
    })
  }

  // ── 已登录渠道的模型（登录后自动出现在模型选择器里）──
  const accountStore = createAccountStore(cfg.dshHome)

  // 一次性归一：历史数据把 AK、SK 各存成一条账号（codearts 等签名渠道）
  // ⇒ 配对成一条（写盘），UI 才看到 1 个账号、发送才拿得到完整三元组。
  const akSkProviders = new Set(
    Object.entries(CHANNELS).filter(([, c]) => c.auth === AUTH.SIGNED_HUAWEI).map(([id]) => id),
  )
  accountStore.normalizeAkSk(akSkProviders)
    .then((r) => { if (r.changed) log.info(`AK/SK 账号已配对归一：${r.before} → ${r.after} 条`) })
    .catch(() => {})
  // 清理历史重复账号（同一渠道同一凭据被重复保存，页面上会出现同一账号多条）
  accountStore.dedupe?.()
    .then((r) => { if (r && r.changed) log.info(`重复账号已清理：${r.before} → ${r.after} 条`) })
    .catch(() => {})
  let channelModelCache = {}

  /** 重新从磁盘读模型缓存（登录/刷新后调用，让选择器立刻看到新模型） */
  const reloadChannelModels = async () => {
    try {
      channelModelCache = (await readCachedModels(cfg.dshHome)) || {}
      const n = channelModelsAsList(channelModelCache).length
      log.info(`渠道模型缓存已刷新：${n} 个`)
      return n
    } catch { return 0 }
  }
  // 启动时先同步读一次（异步，但很快）
  reloadChannelModels().catch(() => {})

  const extraModels = () => channelModelsAsList(channelModelCache)

  // ── 自动签到 / 续期：真实定时器（setTimeout 链 + unref；**不用 ctx.interval**）──
  //
  // 历史缺陷：checkin.js/refresh.js 曾是纯函数库，页面开关写盘就算「生效」，
  // 但没有任何调用点 ⇒ 「自动领积分」永远不跑。这里真正接线。
  const checkinStateIo = {
    read: () => readCheckinState(cfg.dshHome),
    write: (st) => writeCheckinState(cfg.dshHome, st),
  }
  const checkinScheduler = createCheckinScheduler({
    executor: createCheckinExecutor({ accounts: accountStore }),
    state: checkinStateIo,
    config: () => ({
      enabled: cfg.checkin?.enabled !== false,       // 默认开（用户要求「自动领积分」）；显式 false 才关
      at: cfg.checkin?.at ?? '10:05',
      retryMinutes: cfg.checkin?.retryMinutes ?? 120,
    }),
    logger: log,
    initialDelayMs: 30_000,                          // 不跟启动抢资源
  })
  checkinScheduler.start()

  /** 续期成功后的写回（同一条账号 0600；绝不打印凭据） */
  const saveRefreshedCredential = async (account, credential, expiresAt) => {
    if (!account?.id) return false
    const c = typeof credential === 'string'
      ? (credential.includes(':') ? { ak: credential.split(':')[0], sk: credential.split(':')[1] } : { credential })
      : (credential ?? {})
    try {
      const r = await accountStore.save({
        id: account.id,
        provider: account.provider,
        label: account.label,
        credential: c.credential ?? c.token ?? '',
        ak: c.ak,
        sk: c.sk,
        securityToken: c.securityToken,
        expiresAt: expiresAt ?? account.expiresAt ?? null,
      })
      return r.ok === true
    } catch { return false }
  }
  const refreshScheduler = createRefreshScheduler({
    accounts: accountStore,
    config: () => ({
      enabled: cfg.refresh?.enabled !== false,
      tickMs: cfg.refresh?.tickMs ?? 60_000,
      leadMinutes: cfg.refresh?.leadMinutes ?? 5,
    }),
    refreshAccount: (provider, account) => refreshLogin(provider, account),
    saveCredential: saveRefreshedCredential,
    logger: log,
  })
  refreshScheduler.start()

  if (typeof checkinScheduler.status === 'function') {
    const st = checkinScheduler.status()
    log.info(`自动签到：${st.enabled ? '开启' : '关闭'}（每日 ${st.at}，${st.alive ? '定时器已排程' : '尚未排程'}）`)
  }

  // ── 路由 hint 旁路注册表（授权的唯一实际通道）──
  //
  // 宿主把请求对象 `Object.freeze` 后交给 adapter（只能读），平台侧没法往请求里塞
  // 「这一轮可以付费」。所以走旁路：注册表按 `options.sessionId` 存 hint，
  // adapter 在准入前查一次；同时挂到 globalThis 符号上供 cs-bots 发现。
  // 两者都没有 ⇒ adapter 走 free_only（fail-closed）。
  // 🔴 终态失败黑名单（buddy/qoder 这类 100% 全败渠道不再每次请求都撞一遍）
  const denyList = getSharedBlacklist()

  const hintRegistry = createHintRegistry()
  const hintsInstalled = installGlobalHints(hintRegistry)
  if (!hintsInstalled) {
    // 契约名缺失 ⇒ 明说缺什么（对方按 setRequestHint 探测，缺了就是「未安装」）
    log.warn('routing hints 未能挂到 globalThis（契约方法 setRequestHint/getRequestHint/clearRequestHint 不齐）——将只走 cordis 服务')
  }

  let lastFailure = null
  let adapter

  // ── 并发感知参数（design/21 §4）：「配置覆盖」而非改默认值 ──
  //    cfg.sources.limits.<id>        → 渠道并发上限（人类问法「同时最多几个请求」）
  //    cfg.routing.cooldownMs         → 失败冷却基值（busyCooldownMs，指数退避起点）
  //    cfg.routing.rateCooldownMs     → 429 退避基值（rateLimitCooldownMs）
  //    未配置 ⇒ 完全走 concurrency.js 默认值（fail-open，harness 零回归）。
  //    在 createAdapter 之前预初始化进程级共享闸门，adapter 会复用同一份（getSharedGate 单例）。
  const gateOpts = concurrencyGateOpts(cfg)
  if (Object.keys(gateOpts).length > 0) {
    getSharedGate(gateOpts)
    log.info(`并发感知配置已生效：${JSON.stringify(gateOpts).slice(0, 160)}`)
  }

  try {
    adapter = createAdapter({
      extraModels,
      builtin: defaultChain,
      // 覆盖层 = UI 写的那份（唯一事实来源）；profile 的 chain 只在首启时播种
      overrides: chainOverrides,
      // 请求的模型若不在链/目录里但形如 <渠道>/<模型> ⇒ 允许直连（失败再降级）
      directModel: (id) => {
        const p = parseModelId(id)
        return p ? { provider: p.channelId, model: id, name: id, channelModel: true } : null
      },
      send: cfg.transportBaseUrl ? send : sendDispatch,
      budget: cfg.budgetTurns ?? {},
      // 契约 B：路由配置**必须传函数**而不是快照 —— `cfg` 是热更的 `let` 变量
      //（见下方 applyConfig：`cfg = withDefaults(next)`），函数形态下 adapter 每次请求
      // 重新求值 ⇒ 设置页改完 routing.* **不必重启**就生效。
      routingConfig: () => cfg,
      // 契约 E：子智能体路由策略（三选项 auto/pinned/follow）。
      // 可能为 undefined（老配置文件/未接线时）⇒ adapter 侧按『无配置』兜底（= 今天的行为）。
      // 与 routingConfig 同理传函数而非快照：adapter 的 subagentRoutingOf() 认两种形态，
      // 函数形态 ⇒ 设置改完即时生效（不必重启）。
      subagentRouting: () => cfg.subagentRouting,
      // 旁路授权通道（同一份注册表：cordis 服务与 globalThis 符号指向它）
      routingHints: hintRegistry,
      // 终态失败黑名单（进程级共享：adapter 与 /state 看到同一份）
      blacklist: denyList,
      onEvent: (e) => {
        if (e?.type === 'failure') lastFailure = { kind: e.kind, provider: e.provider, model: e.model, at: Date.now() }
        log.debug(`${e.type}`, e)
      },
      onRecord: (r) => { appendRecord(r, { dshHome: cfg.dshHome }).catch(() => {}) },
    })
    const sc = adapter.selfCheck()
    if (!sc.ok) log.warn(`adapter 契约自检未通过：${sc.problems.join('；')}`)
    else log.info(`adapter 契约自检通过（${sc.modelCount} 个模型，生效链 ${sc.modelCount > 0 ? adapter.describe().chain.length : 0} 条）`)
  } catch (err) {
    log.error(`adapter 创建失败（跳过注册）：${err?.message ?? err}`)
  }

  /**
   * 路由诊断快照（`/state.routing` 与 cs-bots 服务共用**同一份**口径）。
   * 实现见 `web/routing.js`（唯一实现，可单测）：
   *   defaultBillingTier / lastAdmission.stats / chain[] / gate{} / hints
   */
  const buildRoutingSnapshot = createRoutingSnapshot({
    adapterOf: () => adapter,
    hintRegistry,
    gateOf: () => getSharedGate(),
    blacklistSnapshot: () => { try { return denyList.snapshot() } catch { return [] } },
    now: () => Date.now(),
  })

  // cordis 服务（可发现面；契约 §3）。拿不到就靠 globalThis 符号，再拿不到 ⇒ free_only。
  //
  // ⚠️ 命名纪律：这里的 `setRequestHint/getRequestHint/clearRequestHint` 与 globalThis
  //    符号上的 `api` **必须是同一组名字**（直接委托注册表，禁止两套命名）。
  //    cs-bots 两个通道都按契约名探测，名字漂移一次就会让授权链路静默空转。
  const routingApi = {
    version: HINTS_VERSION,
    defaultBillingTier: 'free_only',
    setRequestHint: (sessionId, hint) => hintRegistry.setRequestHint(sessionId, hint),
    getRequestHint: (sessionId) => hintRegistry.getRequestHint(sessionId),
    clearRequestHint: (sessionId) => hintRegistry.clearRequestHint(sessionId),
    // 兼容旧名（同一实现；插件内部/老调用方用）
    set: (sessionId, hint) => hintRegistry.set(sessionId, hint),
    get: (sessionId) => hintRegistry.get(sessionId),
    clear: (sessionId) => hintRegistry.clear(sessionId),
    hintsSnapshot: () => hintRegistry.snapshot(),
    chainSnapshot: () => adapter?.chainSnapshot?.() ?? [],
    admissionSnapshot: () => adapter?.admissionSnapshot?.() ?? null,
    gateSnapshot: () => snapshotStats(getSharedGate()),
    // 黑名单：诊断 + 手动解除（用户点了"重新启用"就走这里）
    blacklistSnapshot: () => denyList.snapshot(),
    // 黑名单是 provider 级：clear(provider) 清掉该渠道的条目（成功自动解除也走同一语义）
    clearBlacklist: (provider) => denyList.clear(provider),
    routingSnapshot: () => buildRoutingSnapshot(),
  }
  const routingProvided = safeProvide(ctx, 'csMyfreeRouting', routingApi)
  if (routingProvided) log.info('路由服务已提供：csMyfreeRouting（hint 注册表 + 准入/闸门快照）')
  else log.debug('宿主无 provide：路由服务未注册（仍可走 globalThis 符号）')

  // ── 注册到宿主（全部走安全调用）──
  //
  // 🔴 P1 修复：渠道名别名注册（NO_ADAPTER 根因）
  //
  // 链内候选 provider 是渠道名（`codearts`/`buddy`/`loomy`…），而 myfree 只注册
  // `cs-myfree` 一个 id。宿主按 provider 精确查注册表（`dsh-llm:2264`），任何
  // "以渠道名发起请求/重放/续跑"的场合必然抛 NO_ADAPTER。
  //
  // 策略：**同时**注册渠道名别名 —— 宿主按任一名字都能查到同一个 adapter。
  // ⚠️ 宿主 `prepareRoutes` 是 all-or-nothing：一个冲突别名会导致整批失败。
  //    所以逐个注册：PROVIDER_ID 独立注册，每个别名单独注册，冲突的跳过并留痕。
  if (adapter) {
    const ok = safeInject(ctx, ['llm'], (scoped) => {
      const ids = [PROVIDER_ID, ...providerAliases()]
      const okIds = []
      const conflicting = []
      const failed = []
      for (const id of ids) {
        const r = safeRegisterAdapter(scoped?.llm, [id], adapter)
        if (r.ok) okIds.push(id)
        else if (String(r.error).includes('DUPLICATE_ADAPTER')) conflicting.push(id)
        else failed.push({ id, err: r.error })
      }
      if (okIds.length > 0) {
        log.info(`✅ adapter 已注册：${okIds.length} 个 id（${okIds.join(', ')}），${adapter.describe().chain.length} 条候选`)
      } else {
        log.error(`❌ adapter 注册全部失败（模型选择器不会出现 ${PROVIDER_ID}）：${JSON.stringify(failed)}`)
      }
      if (conflicting.length > 0) log.debug(`  冲突别名（已由其它插件注册，跳过）：${conflicting.join(', ')}`)
    }, `${NAME}: llm`)
    if (!ok) log.warn('宿主无 inject：跳过 llm 注册')
  }

  // ── P2 修复：注册 `agent/request-error` 瀑布处理器 ──
  //
  // 🔴 为什么需要：宿主 `dsh-agent-loop:1136` 在模型失败时发 `agent/request-error`
  // waterfall，只有返回 `{kind:'retry'}` 才会原地重试。cs-myfree 此前只依赖
  // adapter 内部降级链，未注册宿主层瀑布 ⇒ 宿主级的恢复策略对走 myfree 路由
  // 的请求不生效。本处理器用 `failure-map.classify` 分类，只对真正瞬态的错误
  // （TRANSPORT/TIMEOUT/SERVER/EMPTY_RESPONSE）返回 retry，终态错误交回宿主。
  //
  // ⚠️ 不与 `dsh-llm-retry` 冲突：分类口径一致（同样排除 RATE_LIMIT）。
  const disposeRequestError = installRequestErrorHandler(ctx, {
    onEvent: (e) => log.debug('request-error 分类', e),
  })
  if (disposeRequestError) {
    log.info('✅ agent/request-error 瀑布处理器已注册')
  } else {
    log.debug('宿主无 on 方法：跳过 request-error 注册')
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

  // ── HTTP API（设置页的数据源；全部过 guard）──
  // 启动时规范化一次覆盖层（清理历史错名，避免重复候选）
  stateStore.normalizeChain((id) => resolveSourceId(id))
    .then((r) => {
      if (r.changed) log.info(`覆盖层已规范化：${r.before} → ${r.after} 条（清理了别名与重复）`)
    })
    .catch(() => {})
  const routesOk = safeInject(ctx, ['webServer'], (scoped) => {
    const ws = scoped?.webServer ?? (typeof scoped?.get === 'function' ? scoped.get('webServer', false) : null)
    if (!ws) { log.debug('无 webServer：HTTP API 未注册'); return }

    // 🔴 真实会话校验能力：委托宿主 connection（验 HMAC 签名 + 可信 Host + 会话）。
    //    拿不到 ⇒ judge 会 fail-closed 拒绝非回环请求（绝不按 cookie 名前缀放行）。
    const getConnection = () => {
      try {
        const c = typeof ctx?.get === 'function' ? ctx.get('connection', false) : null
        return c && typeof c.requestRejection === 'function' ? c : null
      } catch { return null }
    }

    // 余额（独立路径，保持与本机 myfree 一致的手感）
    // 契约 D3 接线：默认官方计费查询实现 + 主账号 AK/SK 解析器。
    //   无 AK/SK ⇒ queryArkOfficial 立刻回 {ok:false, code:'NO_AK_SK'}（零网络），
    //   cash.js 落到 estimated 分支（本地账本近 30 天估算，如实标注「估算」）。
    //   🔴 AK/SK 只在内存里传，本文件**不打任何日志、不进响应**。
    const cashRegistered = registerCashRoute(ws, ctx, {
      trustedHosts: cfg.trustedHosts ?? [],
      dshHome: cfg.dshHome,
      logger: log,
      volcBalance: (o) => queryArkOfficial(o),
      resolveVolcAkSk,
      helpers: { judge: (req, o = {}) => judge(req, { ...o, getConnection }), sendJson },
    })
    if (cashRegistered) log.info(`余额路由：${CASH_PATH}`)

    // 完整 API
    let n = 0
    try {
      n = registerRoutes(ws, {
        state: stateStore,
        ctx,
        version: VERSION,
        dshHome: cfg.dshHome,
        reloadChannelModels,   // 登录/刷新后让适配器立刻看到新模型
        accountStore,
        trustedHosts: cfg.trustedHosts ?? [],
        getConnection,
        // 设置页权限（design/19 §1.1）：宿主身份服务；缺省 ⇒ 视为 admin（fail-open 最宽松）
        isAdmin: () => {
          try {
            const auth = ctx?.get?.('auth', false)
            if (auth && typeof auth.isAdmin === 'function') return auth.isAdmin() === true
          } catch { /* 无身份服务 ⇒ fail-open */ }
          return true
        },
        // 设置页「当前上下文」：会话 ID（含可读 label）/ 工作区名 / 团队 ID（尽力而为；拿不到返回 {}，UI 可传 query 覆盖）
        getSettingsContext: () => {
          const out = {}
          try {
            const sess = ctx?.get?.('session', false)
            if (sess && typeof sess.id === 'string' && sess.id) {
              out.sessionId = sess.id
              // 会话的可读名（尽力而为；宿主没给就用 id 本身）
              const label = sess.name || sess.title || sess.id
              out.session = { id: sess.id, label: typeof label === 'string' && label ? label : sess.id }
            }
          } catch { /* ignore */ }
          try {
            const cwd = typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : ''
            if (cwd) {
              const parts = String(cwd).split('/').filter(Boolean)
              out.workspaceId = parts.length ? parts[parts.length - 1] : cwd
            }
          } catch { /* ignore */ }
          try {
            const team = ctx?.get?.('team', false)
            if (team && typeof team.id === 'string' && team.id) out.teamId = team.id
          } catch { /* ignore */ }
          return out
        },
        // 🔴 OAuth 回调必须落在宿主**公网地址**（用户浏览器在另一台机器）
        publicBase: cfg.publicBase ?? (Array.isArray(cfg.trustedHosts) && cfg.trustedHosts.length
          ? `http://${String(cfg.trustedHosts.find((h) => !/^(localhost|127\.|0\.0\.0\.0)/.test(String(h))) ?? cfg.trustedHosts[0]).replace(/:80$/, '')}`
          : null),
        logger: log,
        // 🔴 页面展示的链 = adapter 实际生效的链（同一份内存数据，不是另一份推算）
        getChain: () => defaultChain,
        // /state.routing：授权默认值 + 最近准入 stats + 闸门快照（验证指标口径）
        routingSnapshot: buildRoutingSnapshot,
        // /diag：adapter 注册与派发 + 签到/续期定时器是否活着
        getRuntime: () => ({
          adapterReady: Boolean(adapter),
          modelCount: adapter ? adapter.listModels(PROVIDER_ID).length : 0,
          chainLength: adapter ? adapter.getChain().effective.length : mergeChain(defaultChain, chainOverrides).length,
          lastFailure,
          checkin: checkinScheduler.status(),
          refresh: refreshScheduler.status(),
        }),
        // POST /checkin/run：手动一键签到（显式操作，不受自动开关限制）
        runCheckin: ({ providers } = {}) => checkinScheduler.runNow(providers),
        // GET /credits：各家余额/积分（未实现的渠道返回明确错误）
        getCredits: async () => {
          let list = []
          try { list = await accountStore.list() } catch { list = [] }
          const providers = [...new Set(list.map((a) => a.provider))]
          return fetchAllCredits(providers, (p) => (typeof accountStore.secretOf === 'function' ? accountStore.secretOf(p) : null), {})
        },
        getChainState: () => (adapter
          ? adapter.getChain()
          : { builtin: defaultChain, overrides: chainOverrides, effective: mergeChain(defaultChain, chainOverrides) }),
        // POST /chain 写盘后立刻换链，做到「存了即生效，重启也一致」
        applyChain: (entries) => {
          chainOverrides = Array.isArray(entries) ? entries : []
          if (!adapter) return false          // adapter 创建失败 ⇒ 只能等重启
          adapter.setChain(defaultChain, chainOverrides)
          return true
        },
        getConfig: () => cfg,
        setConfig: async (next) => {
          try {
            const file = `${stateStore.dir}/config.json`
            const r = await atomicWrite(file, next)
            if (r.ok !== true) return false
            // 🔴 写盘后**热更新内存 cfg**：否则 GET /config、/state 与发送路径
            //    （vision/budget 等都从这里读）仍是旧值，页面显示「已保存」但没生效。
            cfg = withDefaults(next ?? {})
            // 🔴 开关必须真实生效：改配置就启停/重排定时器，不是写盘就算
            try {
              checkinScheduler.setEnabled(cfg.checkin?.enabled !== false)
              checkinScheduler.reschedule()
              refreshScheduler.setEnabled(cfg.refresh?.enabled !== false)
              refreshScheduler.reschedule()
            } catch { /* 调度器异常不影响配置保存 */ }
            return true
          } catch { return false }
        },
        ledger: async () => {
          try {
            const { readJson } = await import('./config/store.js')
            const r = await readJson(`${stateStore.dir}/ledger-summary.json`, { records: [], summary: [] })
            return r.value ?? { records: [], summary: [] }
          } catch { return { records: [], summary: [] } }
        },
      })
    } catch (err) {
      log.warn(`API 注册异常：${err?.message ?? err}`)
    }
    if (n > 0) log.info(`HTTP API 已注册 ${n} 条：${API_PREFIX}/*（仅回环或已登录可访问）`)
    else log.warn('HTTP API 注册失败（设置页会显示无数据）')
  }, `${NAME}: webServer`)
  if (!routesOk) log.debug('宿主无 inject：跳过 HTTP API')

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
