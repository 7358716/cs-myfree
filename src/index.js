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

import { createAdapter, providerRetryPolicy, DEFAULT_CANDIDATES, PROVIDER_ID } from './adapter/index.js'
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
import { guardApply, makeLogger, safeInject, safeEffect, safeRegisterAdapter, safeRegisterSearch, detectHostVersion } from './compat.js'
import { registerCashRoute, CASH_PATH, queryCash } from './web/cash.js'
import { judge, sendJson } from './web/guard.js'
import { registerRoutes, PREFIX as API_PREFIX } from './web/routes.js'
import { appendRecord } from './audit/sources.js'
import { createState } from './web/state.js'
import { randomUUID } from 'node:crypto'
import { createAccountStore } from './pools/channels/accounts.js'
import { readCachedModels, channelModelsAsList, parseModelId, makeModelId, refreshAll } from './pools/channels/catalog.js'
import { streamChat as channelStream } from './pools/channels/driver.js'
import { CHANNELS, AUTH } from './pools/channels/protocols.js'
import {
  createCheckinScheduler, createCheckinExecutor, readCheckinState, writeCheckinState,
} from './pools/channels/checkin.js'
import { createRefreshScheduler } from './pools/channels/refresh.js'
import { refreshLogin } from './pools/channels/login/refresh.js'
import { fetchAllCredits } from './pools/channels/credits/index.js'

const NAME = 'cs-myfree'
const VERSION = '1.9.11'

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
      if (options?.sessionId) extraHeaders['Session-Id'] = String(options.sessionId)
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

  let lastFailure = null
  let adapter
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

  // ── 注册到宿主（全部走安全调用）──
  if (adapter) {
    const ok = safeInject(ctx, ['llm'], (scoped) => {
      const r = safeRegisterAdapter(scoped?.llm, [PROVIDER_ID], adapter)
      if (r.ok) {
        log.info(`✅ adapter 已注册：provider="${PROVIDER_ID}"，${adapter.describe().chain.length} 条候选`)
      } else {
        // 🔴 大声报：这是「模型选择器看不到 cs-myfree」的唯一原因
        log.error(`❌ adapter 注册失败（模型选择器不会出现 ${PROVIDER_ID}）：${r.error}`)
      }
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
    const cashRegistered = registerCashRoute(ws, ctx, {
      trustedHosts: cfg.trustedHosts ?? [],
      logger: log,
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
        // 🔴 OAuth 回调必须落在宿主**公网地址**（用户浏览器在另一台机器）
        publicBase: cfg.publicBase ?? (Array.isArray(cfg.trustedHosts) && cfg.trustedHosts.length
          ? `http://${String(cfg.trustedHosts.find((h) => !/^(localhost|127\.|0\.0\.0\.0)/.test(String(h))) ?? cfg.trustedHosts[0]).replace(/:80$/, '')}`
          : null),
        logger: log,
        // 🔴 页面展示的链 = adapter 实际生效的链（同一份内存数据，不是另一份推算）
        getChain: () => defaultChain,
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
