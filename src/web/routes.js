/**
 * cs-myfree — HTTP API（供设置页调用）
 *
 * 所有路由统一过 guard（见 web/guard.js）。路径前缀 `/cs-myfree`。
 *
 *   GET  /cs-myfree/health    健康检查（也用于诊断「路由通不通」）
 *   GET  /cs-myfree/state     综合状态（源/链/配置/账本）
 *   GET  /cs-myfree/chain     链（内置 + 覆盖 = 生效）
 *   POST /cs-myfree/chain     写覆盖层（整表覆盖）
 *   POST /cs-myfree/probe     探测免密源（**真实推理请求**）
 *   GET  /cs-myfree/models    模型目录（来自最近一次探测缓存）
 *   GET  /cs-myfree/config    读配置
 *   POST /cs-myfree/config    写配置（校验后合并）
 *   POST /cs-myfree/diag      一键体检
 *   GET  /cs-myfree/ledger    用量摘要
 *
 * @module cs-myfree/web/routes
 */

import { validateOverrides, mergeChain, chainSummary } from '../adapter/chain-overrides.js'
import { keylessSources, SOURCES, buildOrder, checkinSources } from '../pools/registry.js'
import { CHANNELS, checkinChannels, manualRefreshChannels, proxyRequiredChannels } from '../pools/channels/protocols.js'
import { probeAll, PRIORITY, DEFAULT_MODEL, resolveSourceId } from '../pools/keyless/index.js'
import { queryCash, CASH_PATH } from './cash.js'
import { judge, sendJson, safeErrorText } from './guard.js'
import { withDefaults, DEFAULTS, findSensitiveKey, stripSensitive } from '../config/store.js'
import { planReload, RELOAD_SCOPE } from '../ops/feed.js'
import { collectLedger } from '../audit/sources.js'
import { createAccountStore } from '../pools/channels/accounts.js'
import { listChannels, LOGIN_GUIDES } from './channels.js'
import { captureCredential, previewCapture, looksLikeCredential } from '../pools/channels/capture.js'
import { readCachedModels, refreshAll, channelModelsAsList } from '../pools/channels/catalog.js'
import { SCOPE, readScope, writeScope, effectiveConfig, listScopes } from '../config/scope.js'
import { startLogin, getSession, pollLogin, cancelLogin, handleCallback } from '../pools/channels/login/index.js'
import { FLOW_MAP } from '../pools/channels/login/flow-map.js'
import { refreshLogin, NO_REFRESH_ERROR } from '../pools/channels/login/refresh.js'
import { classify, explainKind } from '../adapter/failure-map.js'
import { getSharedGate, BUSY_CODE } from '../adapter/concurrency.js'
import { maskCredential } from '../pools/channels/accounts.js'
import { builtinModelsOf } from '../pools/channels/builtin-models.js'
import { chat } from '../pools/channels/driver.js'

export const PREFIX = '/cs-myfree'

/** 探测缓存有效期（5 分钟） */
export const PROBE_TTL_MS = 5 * 60 * 1000

async function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > limit) { req.destroy(); resolve(undefined) }
    })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : undefined) } catch { resolve(undefined) }
    })
    req.on('error', () => resolve(undefined))
  })
}

/**
 * 注册所有路由。
 * @param {object} webServer 宿主 web 服务
 * @param {object} opts
 * @returns {number} 成功注册的条数
 */
export function registerRoutes(webServer, opts = {}) {
  if (!webServer || typeof webServer.register !== 'function') return 0

  const {
    state,
    getChain = () => [],
    getChainState = null,          // () => { builtin, overrides, effective }：adapter 实际生效链
    applyChain = null,             // async (entries) => void：写盘后立刻让 adapter 生效
    getConfig = () => ({}),
    setConfig = async () => false,
    ledger = null,
    trustedHosts = [],
    getConnection = null,          // () => 宿主 connection 服务（真实会话校验；拿不到则 fail-closed）
    getRuntime = null,             // () => { adapterReady, modelCount, chainLength, lastFailure, checkin, refresh }
    runCheckin = null,             // async ({providers}) => { results, coversToday }
    getCredits = null,             // async ({providers}) => [{provider, ok, total, error?}]
    logger = { info: () => {}, warn: () => {} },
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
  } = opts

  /**
   * 链视图：页面展示与实际选路**必须是同一份数据**（铁律2）。
   * 有 getChainState（插件运行时）就用 adapter 的；否则退回读覆盖层文件
   * （纯路由测试/独立使用时的兼容路径）。
   */
  const chainView = async () => {
    if (typeof getChainState === 'function') {
      const v = getChainState() || {}
      const builtin = Array.isArray(v.builtin) ? v.builtin : []
      const overrides = Array.isArray(v.overrides) ? v.overrides : []
      const effective = Array.isArray(v.effective) ? v.effective : mergeChain(builtin, overrides)
      return { builtin, overrides, effective }
    }
    const builtin = getChain()
    const overrides = (await state?.readChain?.({ chain: [] }))?.chain ?? []
    return { builtin, overrides, effective: mergeChain(builtin, overrides) }
  }

  let registered = 0

  /** 统一包装：guard + 错误处理 + no-store */
  const route = (path, handler, { method = 'ANY' } = {}) => {
    try {
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}${path}`,
        handler: async (req, res) => {
          const verdict = judge(req, { trustedHosts, getConnection })
          if (!verdict.ok) return sendJson(res, verdict.status ?? 403, { ok: false, error: verdict.reason })
          if (method !== 'ANY' && req.method !== method) {
            return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          }
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const body = req.method === 'POST' ? await readBody(req) : undefined
            const out = await handler({ req, res, query: url.searchParams, body })
            if (out !== undefined) sendJson(res, 200, out)
          } catch (err) {
            // P2-04：日志必须脱敏（上游错误原文可能含 token/code）
            logger.warn(`${path} 处理失败：${safeErrorText(err)}`)
            sendJson(res, 500, { ok: false, error: String(err?.message ?? err).slice(0, 200) })
          }
        },
      })
      registered++
    } catch (err) {
      logger.warn(`注册 ${path} 失败：${safeErrorText(err)}`)
    }
  }

  // ── 健康检查（最先，用于确认路由通不通）──
  route('/health', async () => ({
    ok: true,
    plugin: 'cs-myfree',
    version: opts.version ?? '1.0.5',
    at: now(),
    prefix: PREFIX,
  }))

  // ── 综合状态 ──
  route('/state', async () => {
    const cfg = withDefaults(getConfig())
    const view = await chainView()
    const builtin = view.builtin
    const overrides = view.overrides
    const merged = view.effective

    const probe = await state?.readProbe?.(null)
    return {
      ok: true,
      at: now(),
      version: opts.version,
      sources: {
        keyless: keylessSources().map((s) => ({ id: s.id, label: s.label, note: s.note })),
        channels: Object.entries(CHANNELS).map(([id, c]) => ({
          id, label: c.label, login: c.login, refresh: c.refresh,
          checkin: c.checkin?.supported === true,
          note: c.note ?? null,
        })),
        counts: {
          keyless: keylessSources().length,
          channels: Object.keys(CHANNELS).length,
          checkin: checkinChannels().length,
          manualRefresh: manualRefreshChannels().length,
          proxyRequired: proxyRequiredChannels().length,
        },
      },
      chain: {
        builtinCount: builtin.length,
        overrideCount: overrides.length,
        effectiveCount: merged.length,
        tiers: chainSummary(merged),
        explain: merged.length === 0
          ? '当前没有候选链（未配置内置链）⇒ 会失败。请至少加一条，或使用免密源。'
          : `共 ${merged.length} 条候选，分 ${chainSummary(merged).length} 层。`,
      },
      config: {
        vision: cfg.vision?.mode ?? 'off',
        search: cfg.search?.sources ?? [],
        budget: cfg.budget,
        paid: { enabled: cfg.paid?.enabled === true },
        disabledSources: cfg.sources?.disabled ?? [],
      },
      probe: probe ? { at: probe.at, anyOk: probe.anyOk, okCount: probe.okCount } : null,
      checkin: {
        supported: checkinSources().map((s) => s.id),
        note: '签到由宿主渠道层执行；本插件只展示可签到渠道',
      },
    }
  })

  // ── 链 ──
  // ── 降级链可选项（给 UI 做下拉，不用手输 provider/model）──
  //
  // 返回三类可入链的候选：
  //   keyless  — 免密源（kilo / ovh …）及其默认模型
  //   channel  — 已登录渠道 + 其可用模型（远端拉取过就用真实清单，否则用内置兜底）
  route('/chain/catalog', async () => {
    const sources = []
    // ① 免密源
    for (const src of keylessSources()) {
      const realId = String(src.id ?? '').replace(/-free$|-vision$/, '')
      const model = DEFAULT_MODEL[realId] ?? DEFAULT_MODEL[src.id] ?? null
      if (!model) continue
      sources.push({
        kind: 'keyless',
        provider: realId,
        label: src.label ?? realId,
        models: [{ id: model, name: model }],
      })
    }
    // ② 已登录渠道（把真实模型清单拌进去；没有就内置兜底）
    const cache = await readCachedModels(opts.dshHome)
    const logged = await accounts.list()
    const loggedProviders = [...new Set(logged.map((a) => a.provider))]
    for (const provider of loggedProviders) {
      const ch = CHANNELS[provider]
      if (!ch) continue
      const cached = Array.isArray(cache?.[provider]?.models) ? cache[provider].models : []
      const models = cached.length > 0
        ? cached.map((m) => ({ id: m.id, name: m.name || m.id }))
        : builtinModelsOf(provider).map((m) => ({ id: m.id, name: m.name || m.id }))
      sources.push({
        kind: 'channel',
        provider,
        label: ch.label ?? provider,
        models,
        accounts: logged.filter((a) => a.provider === provider).length,
      })
    }
    // ③ 未登录但已登记的渠道（允许配置，只是会 AUTH 失败；UI 会提示）
    for (const [id, ch] of Object.entries(CHANNELS)) {
      if (loggedProviders.includes(id)) continue
      const builtin = builtinModelsOf(id)
      if (builtin.length === 0) continue
      sources.push({
        kind: 'channel-unlogged',
        provider: id,
        label: ch.label ?? id,
        models: builtin.map((m) => ({ id: m.id, name: m.name || m.id })),
        accounts: 0,
      })
    }
    return { ok: true, at: now(), sources }
  })

  route('/chain', async ({ body }) => {
    if (body === undefined) {
      const view = await chainView()
      return {
        ok: true,
        builtin: view.builtin,
        overrides: view.overrides,
        effective: view.effective,
        tiers: chainSummary(view.effective),
        applied: true,   // 页面上的「生效链」= adapter 此刻真正会用的链
      }
    }
    // 写覆盖层（整表覆盖）
    // 先把 provider 别名归一（kilo-free → kilo），否则「别名 + 真名」会被当成两条
    // ⇒ UI 显示重复候选、adapter 多花一次失败重试。
    const rawList = Array.isArray(body?.chain) ? body.chain : body?.chain
    const normalizedBody = Array.isArray(rawList)
      ? { ...body, chain: rawList.map((e) => (e && typeof e === 'object' ? { ...e, provider: resolveSourceId(e.provider) } : e)) }
      : body
    const v = validateOverrides(normalizedBody)
    if (!v.ok) return { ok: false, errors: v.errors, entries: v.entries }
    const saved = await state?.writeChain?.({ chain: v.entries, at: now() })
    // 🔴 写盘成功必须**立刻**让 adapter 换链，否则「存了不生效，要重启」
    let applied = false
    let requiresRestart = false
    if (saved !== false && typeof applyChain === 'function') {
      try {
        applied = (await applyChain(v.entries)) !== false
        requiresRestart = !applied
      } catch (err) {
        logger.warn?.(`覆盖层已保存但生效失败：${safeErrorText(err)}`)
        return { ok: false, errno: 'CHAIN_APPLY_FAILED', count: v.entries.length, applied: false, requiresRestart: true, error: String(err?.message ?? err).slice(0, 200) }
      }
    } else {
      applied = saved !== false
      requiresRestart = saved !== false
    }
    return { ok: saved !== false, errors: v.errors, count: v.entries.length, savedAt: now(), applied, requiresRestart, effective: (await chainView()).effective }
  })

  // ── 探测（真实推理）──
  route('/probe', async ({ body }) => {
    const ids = Array.isArray(body?.sources) && body.sources.length ? body.sources : PRIORITY
    const results = []
    for (const id of ids) {
      if (!PRIORITY.includes(id)) { results.push({ id, ok: false, error: '不支持该源' }); continue }
      try {
        const r = await probeAll({ fetchImpl, timeoutMs: 20_000 })
        results.push(...r.results.filter((x) => x.id === id))
      } catch (err) {
        results.push({ id, ok: false, error: String(err?.message ?? err).slice(0, 120) })
      }
    }
    const snap = { at: now(), results, anyOk: results.some((r) => r.ok), okCount: results.filter((r) => r.ok).length }
    await state?.writeProbe?.(snap)
    return { ok: true, ...snap }
  })

  // ── 模型目录（来自探测缓存 + 内置源定义）──
  route('/models', async () => {
    const probe = await state?.readProbe?.(null)
    return {
      ok: true,
      at: now(),
      defaultModels: DEFAULT_MODEL,
      sources: keylessSources().map((s) => ({
        id: s.id,
        label: s.label,
        note: s.note,
        // 🔑 探测结果的 id 是真实源 id（kilo/ovh/…），源注册表里是展示 id
        //    （kilo-free/ovh-vision/…）⇒ 必须归一后再匹配，否则 probed 永远 null。
        probeId: resolveSourceId(s.id),
        probed: probe?.results?.find((r) => r.id === resolveSourceId(s.id)) ?? null,
      })),
      note: '完整模型清单需渠道层登录后由宿主暴露；本页展示免密源可用的默认模型',
    }
  })

  // ── 配置 ──
  route('/config', async ({ body }) => {
    // 🔴 读路径也剔除敏感字段（历史脏数据不得回给 UI）
    if (body === undefined) return { ok: true, config: stripSensitive(withDefaults(getConfig())), defaults: DEFAULTS }
    try {
      const merged = withDefaults({ ...getConfig(), ...body })
      // 安全校验：**递归**禁止任何凭据类字段（含嵌套 transportHeaders.authorization）
      const hit = findSensitiveKey(merged)
      if (hit) return { ok: false, error: `禁止通过 API 写敏感字段：${hit}` }
      const saved = await setConfig(merged)
      const plan = planReload({ changed: ['config.json'] })
      return { ok: saved !== false, config: merged, reload: plan }
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err).slice(0, 200) }
    }
  })

  // ── 一键体检 ──
  route('/diag', async () => {
    const checks = []
    const add = (name, ok, detail) => checks.push({ name, ok, detail })

    // 1) 路由自身
    add('HTTP 路由', true, `${PREFIX} 已注册 ${registered} 条`)

    // 2) 状态目录
    const ov = await state?.overview?.()
    add('状态目录', ov?.exists === true, ov?.exists ? ov.dir : `不存在（首次使用会自动创建）：${ov?.dir ?? '?'}`)

    // 3) 链
    const view = await chainView()
    const builtin = view.builtin
    const overrides = view.overrides
    const merged = view.effective
    add('降级链', merged.length > 0, merged.length > 0 ? `生效 ${merged.length} 条（内置 ${builtin.length} + 覆盖 ${overrides.length}）` : '为空 ⇒ 所有请求必失败')

    // 4) 免密源（看缓存，不打网络）
    const probe = await state?.readProbe?.(null)
    const fresh = probe && (now() - probe.at < PROBE_TTL_MS)
    add('免密源', probe ? probe.anyOk : null,
      probe ? `${probe.okCount}/${PRIORITY.length} 可用${fresh ? '（缓存新鲜）' : '（缓存已过期，建议重新探测）'}`
        : '尚未探测 ⇒ 点「探测」按钮')

    // 5) DeepSeek 余额
    const cash = await queryCash(opts.ctx ?? {}, { fetchImpl })
    add('DeepSeek 余额', cash.deepseek !== null, cash.deepseek ? '可用' : (cash.errors[0] ?? '未知'))

    // 6) 渠道协议表
    add('渠道协议', Object.keys(CHANNELS).length >= 18, `${Object.keys(CHANNELS).length} 个渠道已登记`)

    // 7) adapter 注册与派发（避免「选择器里有但根本派发不了」的假绿）
    const rt = typeof getRuntime === 'function' ? getRuntime() : null
    if (rt) {
      const modelCount = Number(rt.modelCount) || 0
      const okAdapter = rt.adapterReady === true && modelCount > 0
      const lastFail = rt.lastFailure
      add('adapter 注册与派发', okAdapter,
        !rt.adapterReady
          ? 'adapter 未创建 ⇒ 模型选择器看不到 cs-myfree'
          : modelCount === 0
            ? 'adapter 已注册但没有任何模型 ⇒ 无法选择'
            : `已注册 ${modelCount} 个模型 / 生效链 ${rt.chainLength ?? '?'} 条` +
              (lastFail ? `；最近失败：${lastFail.kind}（${lastFail.provider}/${lastFail.model}）` : '；最近无失败'))

      // 8) 签到/续期定时器（避免「页面上有开关但根本没跑」）
      const ck = rt.checkin ?? null
      if (ck) {
        const enabled = ck.enabled === true
        add('签到定时器', enabled ? ck.alive === true : true,
          !enabled ? '自动签到已关闭（开关可随时打开）'
            : ck.alive
              ? `运行中；下次 ${ck.nextAt ? new Date(ck.nextAt).toLocaleString('zh-CN') : '—'}；上次 ${ck.lastDate ?? '—'} ${ck.lastResult ?? ''}`
              : '🔴 开关已开但定时器未排程（不会自动跑）')
      }
      const rf = rt.refresh ?? null
      if (rf) {
        add('续期定时器', rf.enabled === true ? rf.alive === true : true,
          rf.enabled !== true ? '自动续期已关闭'
            : rf.alive ? `${Math.round((rf.tickMs ?? 60000) / 1000)}s 扫描一次` : '🔴 开关已开但定时器未排程')
      }
    }

    const fails = checks.filter((c) => c.ok === false).length
    return {
      ok: fails === 0,
      at: now(),
      checks,
      summary: fails === 0 ? '全部通过' : `${fails} 项异常`,
      cashPath: CASH_PATH,
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 自动签到 / 领积分 / 余额（task-6；本段只依赖 opts 注入的运行时钩子）
  // ═══════════════════════════════════════════════════════════════════════

  // ── 手动一键签到（显式操作：不受「自动签到」开关限制）──
  route('/checkin/run', async ({ body }) => {
    if (typeof runCheckin !== 'function') {
      return { ok: false, error: '签到运行时未注册（插件未激活或无 webServer）' }
    }
    const providers = Array.isArray(body?.providers) && body.providers.length > 0
      ? body.providers.map(String)
      : undefined
    const t0 = now()
    try {
      const out = await runCheckin({ providers })
      const results = Array.isArray(out?.results) ? out.results : []
      return {
        ok: true,
        at: now(),
        takesMs: now() - t0,
        coversToday: out?.coversToday === true,
        results,
        summary: {
          total: results.length,
          claimed: results.filter((r) => r.kind === 'claimed').length,
          alreadyClaimed: results.filter((r) => r.kind === 'already-claimed').length,
          inactive: results.filter((r) => r.kind === 'inactive').length,
          unsupported: results.filter((r) => r.kind === 'unsupported').length,
          failed: results.filter((r) => r.kind === 'failed').length,
        },
        text: results.length === 0
          ? '没有可签到的渠道（未登录，或渠道不支持自动签到）'
          : results.map((r) => `${r.provider}:${r.kind}${r.gain?.amount ? ` +${r.gain.amount}` : ''}`).join('；'),
      }
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err).slice(0, 200) }
    }
  })

  // ── 签到状态（今天是否已领 / 下次运行时间 / 欠账）──
  route('/checkin/status', async () => {
    const rt = typeof getRuntime === 'function' ? getRuntime() : null
    const ck = rt?.checkin ?? null
    if (!ck) return { ok: false, error: '签到运行时未注册' }
    return {
      ok: true,
      at: now(),
      enabled: ck.enabled === true,
      alive: ck.alive === true,
      running: ck.running === true,
      at_time: ck.at ?? null,
      nextAt: ck.nextAt ?? null,
      lastAt: ck.lastAt ?? null,
      lastDate: ck.lastDate ?? null,
      lastResult: ck.lastResult ?? null,
      pending: ck.pending ?? 0,
      lastError: ck.lastError ?? null,
      channels: ck.channels ?? [],
    }
  })

  // ── 余额/积分（走后端实现；不支持的渠道给明确错误而不是 0）──
  route('/credits', async () => {
    if (typeof getCredits !== 'function') {
      return { ok: false, error: '积分查询运行时未注册' }
    }
    try {
      const list = await getCredits({})
      return { ok: true, at: now(), providers: list }
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err).slice(0, 200) }
    }
  })

  // ── 账本（**真实数据**：读 spend.jsonl + token-ledger.json）──
  route('/ledger', async () => {
    try {
      const data = await collectLedger({ dshHome: opts.dshHome })
      return { ok: true, at: now(), ...data }
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err).slice(0, 200) }
    }
  })

  // ── 渠道账号（登录）──
  const accounts = createAccountStore(opts.dshHome)

  /** 登录状态机注入点（测试用 mock flow；默认 = 真实状态机） */
  const loginEngine = opts.loginEngine ?? {
    start: startLogin,
    poll: pollLogin,
    cancel: cancelLogin,
    get: getSession,
    callback: handleCallback,
  }

  /** 渠道 id → flow-map 契约条目（loginVerified / loginNote / flow type） */
  const flowInfoOf = (id) => {
    const e = FLOW_MAP[id]
    return {
      flow: e?.type ?? null,
      loginVerified: e?.loginVerified ?? false,
      loginNote: e?.loginNote ?? '',
    }
  }

  /**
   * 把 flow 返回的 credential 归一成 accounts.save 需要的形状。
   * 🔴 只在本函数内部短暂持有原文，绝不写日志、绝不进响应。
   */
  const normalizeCredential = (cred) => {
    if (cred == null) return null
    if (typeof cred === 'string') {
      const s = cred.trim()
      if (!s) return null
      if (s.includes(':')) {
        const [ak, sk] = s.split(':')
        if (ak && sk) return { ak, sk, credential: '', masked: `${maskCredential(ak)} / ${maskCredential(sk)}` }
      }
      return { credential: s, masked: maskCredential(s) }
    }
    if (typeof cred !== 'object') return null
    const ak = typeof cred.ak === 'string' ? cred.ak.trim() : ''
    const sk = typeof cred.sk === 'string' ? cred.sk.trim() : ''
    const token = String(
      cred.credential ?? cred.token ?? cred.access_token ?? cred.accessToken
      ?? cred.apiKey ?? cred.api_key ?? '',
    ).trim()
    const securityToken = typeof cred.securityToken === 'string' ? cred.securityToken : undefined
    const expiresAt = Number.isFinite(cred.expiresAt)
      ? cred.expiresAt
      : (Number.isFinite(cred.expiresIn) ? Date.now() + cred.expiresIn * 1000 : null)
    const refreshToken = String(cred.refreshToken ?? cred.refresh_token ?? '').trim() || undefined
    const refreshSource = typeof cred.refreshSource === 'string' ? cred.refreshSource : undefined
    if (ak && sk) return { ak, sk, securityToken, credential: token, expiresAt, refreshToken, refreshSource, masked: `${maskCredential(ak)} / ${maskCredential(sk)}` }
    if (token) return { credential: token, expiresAt, refreshToken, refreshSource, masked: maskCredential(token) }
    return null
  }

  /**
   * poll 拿到 credential ⇒ 落盘 accounts.json（复用 accounts.save，0600）。
   * @returns {Promise<string|null>} 掩码（无凭据则 null）
   */
  const persistCredential = async (provider, session, cred) => {
    const norm = normalizeCredential(cred)
    if (!norm) return null
    const r = await accounts.save({
      id: session?.accountId,
      provider,
      label: CHANNELS[provider]?.label || provider,
      credential: norm.credential,
      ak: norm.ak,
      sk: norm.sk,
      refreshToken: norm.refreshToken,
      refreshSource: norm.refreshSource,
      securityToken: norm.securityToken,
      expiresAt: norm.expiresAt ?? null,
    })
    if (r.ok && session) session.accountId = r.id
    if (r.ok) {
      // 登录成功后立刻拉该渠道模型（与 /channels/save 同口径）
      refreshAll(opts.dshHome, accounts, { fetchImpl })
        .then(async () => { if (opts.reloadChannelModels) await opts.reloadChannelModels() })
        .catch(() => {})
    }
    return norm.masked
  }

  const channelList = async () => {
    const list = await listChannels(accounts)
    // 🔴 每个渠道项带上 flow-map 契约（UI 的「已实现/未验证」徽标依据）
    return list.map((c) => ({ ...c, ...flowInfoOf(c.id) }))
  }

  /**
   * 把 {provider} 或 {id} 归一成渠道 id + 账号记录。
   * @returns {Promise<{ok:true, id:string, account:object|null}|{ok:false, error:string}>}
   */
  const resolveProvider = async (body) => {
    const id = String(body?.id ?? '').trim()
    let provider = String(body?.provider ?? '').trim()
    let account = null
    if (id) {
      account = await accounts.get(id)
      if (!account) return { ok: false, error: '账号不存在：' + id }
      provider = provider || account.provider
    }
    if (!provider) return { ok: false, error: '缺少 provider 或 id' }
    if (!CHANNELS[provider]) return { ok: false, error: '未知渠道：' + provider }
    if (!account) {
      // 按 provider 找第一条账号（多账号池场景取第一个）
      const list = await accounts.list()
      const one = list.find((a) => a.provider === provider)
      if (one) account = await accounts.get(one.id)
    }
    return { ok: true, id: provider, account }
  }

  /** 取结构化凭据（内部用；绝不回给 UI） */
  const secretOfProvider = async (provider, account) => {
    if (account) {
      if (account.ak && account.sk) return { ak: account.ak, sk: account.sk, securityToken: account.securityToken }
      if (typeof account.credential === 'string' && account.credential.includes(':')) {
        const [ak, sk] = account.credential.split(':')
        if (ak && sk) return { ak, sk, securityToken: account.securityToken }
      }
      if (account.credential) return { token: account.credential }
    }
    if (typeof accounts.secretOf === 'function') {
      const s = await accounts.secretOf(provider)
      if (s) return s
    }
    const legacy = await accounts.credentialOf(provider)
    return legacy ? { token: legacy } : null
  }

  route('/channels', async () => ({
    ok: true,
    at: now(),
    channels: await channelList(),
    total: Object.keys(CHANNELS).length,
  }))

  // ── 登录状态（每渠道 loginVerified / flow / note；UI 徽标用）──
  route('/login/status', async () => {
    const channels = Object.keys(CHANNELS).map((id) => {
      const info = flowInfoOf(id)
      return {
        id,
        provider: id,
        label: CHANNELS[id]?.label ?? id,
        flow: info.flow,
        loginVerified: info.loginVerified,
        note: info.loginNote,
        refreshable: CHANNELS[id]?.refresh === 'auto',
      }
    })
    return {
      ok: true,
      at: now(),
      total: channels.length,
      verified: channels.filter((c) => c.loginVerified).map((c) => c.id),
      unverified: channels.filter((c) => !c.loginVerified).map((c) => c.id),
      channels,
      note: 'loginVerified=false 表示登录器端点未真机验证，UI 必须显示「未验证」徽标',
    }
  })

  // ── 登录 start ──
  /**
   * 推导公网基址（OAuth 回调必须落在**用户浏览器可达**的地址上）。
   *
   * 🔴 P1-01 修复：`cfg.publicBase ?? trustedHosts[0]` 在云端部署下会失败
   *    （生产 profile 没给插件配 trustedHosts ⇒ 退化成 http://127.0.0.1:0，
   *    用户授权后浏览器跳到自己的机器，必然打不开）。
   *    改为**优先用本次请求的 Host 头**——那正是用户浏览器实际访问的地址，
   *    不需要任何配置；只有拿不到 Host 时才回落到配置。
   */
  const derivePublicBase = (req) => {
    const host = String((req && req.headers && req.headers.host) || '').trim()
    if (host) {
      const proto = String((req.headers['x-forwarded-proto'] || '')).split(',')[0].trim()
        || (req.socket && req.socket.encrypted ? 'https' : 'http')
      // Host 可能是 localhost / 127.x（本机直连）——那种场景回调也能通，照用
      return `${proto}://${host}`.replace(/:80$/, '')
    }
    return opts.publicBase ?? null
  }

  route('/login/start', async ({ req, body }) => {
    const provider = String(body?.provider ?? '').trim()
    if (!provider) return { ok: false, error: '缺少 provider' }
    if (!CHANNELS[provider]) return { ok: false, error: '未知渠道：' + provider }
    try {
      const s = await loginEngine.start(provider, CHANNELS[provider], {
        publicBase: derivePublicBase(req) ?? opts.publicBase ?? null,
        callbackPath: `${PREFIX}/login/callback`,
      })
      const info = flowInfoOf(provider)
      return {
        ok: true,
        sessionId: s.sessionId,
        flow: s.flow ?? info.flow,
        url: s.url ?? null,
        qr: s.qr ?? null,
        shortLink: s.shortLink ?? null,
        userCode: s.userCode ?? null,
        verificationUri: s.verificationUri ?? null,
        interval: s.interval ?? 5,
        instructions: s.instructions ?? [],
        expiresAt: s.expiresAt ?? null,
        callbackUrl: s.callbackUrl ?? null,
        pollingOnly: s.pollingOnly === true || (s.initial && s.initial.pollingOnly === true),
        loginVerified: info.loginVerified,
        loginNote: info.loginNote,
      }
    } catch (err) {
      logger.warn?.(`login/start ${provider} 失败：${safeErrorText(err)}`)
      return { ok: false, error: safeErrorText(err) }
    }
  })

  // ── 登录 poll ──
  route('/login/poll', async ({ query }) => {
    const sessionId = String(query.get('sessionId') ?? '').trim()
    if (!sessionId) return { ok: false, state: 'error', error: '缺少 sessionId', hint: '', maskedAccount: null }
    let r
    try {
      r = await loginEngine.poll(sessionId)
    } catch (err) {
      logger.warn?.(`login/poll 失败：${safeErrorText(err)}`)
      return { ok: false, state: 'error', error: safeErrorText(err), hint: '', maskedAccount: null }
    }
    if (!r) return { ok: false, state: 'error', error: '会话不存在或已过期', hint: '', maskedAccount: null }

    const session = typeof loginEngine.get === 'function' ? loginEngine.get(sessionId) : null
    const state = r.state ?? 'error'

    // 🔴 拿到 credential ⇒ 落盘（只回掩码，原文绝不进响应）
    //
    // 🐛 真实缺陷（2026-11-03 用户实测）：「登录成功但提示未登录（AUTH）」。
    //    根因：`pollLogin()` 的**返回值里没有 credential**（它只把 credential 存在
    //    内部 session 上），这里却判断 `r.credential` ⇒ 落盘分支永远进不去 ⇒
    //    账号根本没保存 ⇒ 一测连通就 AUTH。腾讯/讯飞都是这个表现。
    //    修法：credential 一律从 **session** 取（服务端内存，绝不进 HTTP 响应）。
    let masked = r.maskedAccount ?? null
    // 兼容两种来源：状态机把 credential 挂在内部 session 上（主路径）；
    // 自定义 loginEngine 也可能直接从 poll 返回值给（测试/嵌入场景）。
    // 两者都只在服务端使用，绝不进 HTTP 响应。
    const pendingCredential = session?.credential ?? r.credential ?? null
    if ((state === 'ok' || state === 'success') && pendingCredential && session && !session.persisted) {
      try {
        masked = (await persistCredential(session.provider, session, pendingCredential)) ?? masked
        session.persisted = true
        // 保存成功后立刻刷新渠道模型清单，让模型选择器马上看到
        if (opts.reloadChannelModels) { try { await opts.reloadChannelModels() } catch { /* 非致命 */ } }
      } catch (err) {
        logger.warn?.(`login/poll 落盘失败：${safeErrorText(err)}`)
        return { ok: false, state: 'error', hint: '', maskedAccount: null, error: '登录成功但保存失败：' + safeErrorText(err) }
      }
    }

    // 会话不存在 / 已过期 / 已取消 ⇒ ok:false，但 state 如实回报
    if (state === 'error' && r.hint === '会话不存在或已过期') {
      return { ok: false, state: 'error', hint: r.hint, maskedAccount: null, error: '会话不存在或已过期（可能已取消或超时）' }
    }
    return {
      ok: state === 'ok',
      state,
      hint: r.hint ?? '',
      maskedAccount: masked,
      error: r.error ? safeErrorText(r.error) : null,
    }
  })

  // ── 登录 cancel ──
  route('/login/cancel', async ({ body }) => {
    const sessionId = String(body?.sessionId ?? '').trim()
    if (!sessionId) return { ok: false, error: '缺少 sessionId' }
    const cancelled = loginEngine.cancel(sessionId)
    return { ok: cancelled === true, cancelled: cancelled === true, sessionId, hint: cancelled ? '已取消（会话即销毁）' : '会话不存在或已结束' }
  })

  // ── 连通性测试（真发一条最小推理）──
  route('/login/test', async ({ body }) => {
    const provider = await resolveProvider(body)
    if (!provider.ok) return provider
    const { id: p, account } = provider
    const ch = CHANNELS[p]
    const cred = await secretOfProvider(p, account)
    if (!cred) return { ok: false, provider: p, model: null, ms: 0, error: '该渠道未登录（无可用凭据）', kind: 'AUTH' }

    const model = String(body?.model ?? builtinModelsOf(p)?.[0]?.id ?? '').trim()
    if (!model) return { ok: false, provider: p, model: null, ms: 0, error: '该渠道没有已知模型，请在 body.model 指定', kind: 'MODEL_NOT_FOUND' }

    const started = now()

    // 🔴 连通性测试也必须拿并发名额：它直接调 driver.chat，绕过 adapter；
    //    若不拿名额，测试请求会和真实对话抢上游会话（实测 5 并发全部
    //    「并发会话已满」⇒ 闸门形同虚设）。
    const gate = getSharedGate()
    const slot = await gate.acquire(p)
    if (!slot.ok) {
      return {
        ok: false,
        provider: p,
        model,
        ms: 0,
        at: now(),
        error: `渠道 ${p} 并发已满（${slot.active}/${slot.limit}）——主/子智能体正在用该渠道`,
        kind: BUSY_CODE,
        hint: 'CHANNEL_BUSY — 该渠道并发名额已用完｜建议：稍后重试，或在「降级链」加一个备用渠道',
      }
    }

    // 🔴 连通性测试必须用**流式**：腾讯系（buddy/workbuddy）明确拒绝非流式
    //    （实测 400 code:11101 "Non-stream chat request is currently not supported"）。
    //    流式只读首帧就 abort，不发完整请求 ⇒ 既快又不浪费额度。
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), Math.min(Number(body?.timeoutMs) || 20_000, 40_000))
    try {
      const res = await chat({
        channelId: p,
        ch,
        cred,
        model,
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 8,
        stream: true,
        fetchImpl,
        signal: ctrl.signal,
        timeoutMs: Math.min(Number(body?.timeoutMs) || 20_000, 40_000),
      })
      const ms = now() - started
      // 读一小段流确认「真的开始出数据」（第一个非空 data 帧 = 链路通）
      let gotFrame = false
      let firstBytes = ''
      try {
        if (res.body) {
          for await (const chunk of res.body) {
            firstBytes += Buffer.from(chunk).toString('utf8')
            if (firstBytes.includes('data:')) { gotFrame = true; break }
            if (firstBytes.length > 2048) break
          }
          try { ctrl.abort() } catch { /* 已结束 */ }
        }
      } catch { /* abort 会抛，忽略 */ }
      const msReal = now() - started
      return {
        ok: true,
        provider: p,
        model,
        ms: msReal || ms,
        at: now(),
        hint: gotFrame
          ? `上游已开始流式返回（首帧 ${msReal}ms），链路通`
          : `上游接受请求（HTTP ${res.status}，${msReal}ms），链路通`,
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        return { ok: true, provider: p, model, ms: now() - started, at: now(), hint: '上游接受请求并保持流（已主动断开），链路通' }
      }
      const ms = now() - started
      const v = classify(err)
      return {
        ok: false,
        provider: p,
        model,
        ms,
        error: safeErrorText(err),
        kind: v.kind,
        // 人话说明 + 建议（用户要求「每次中断的提示语要尽量明确」）
        hint: explainKind(v.kind),
        retryable: v.retryable,
        ttlMs: v.ttlMs,
      }
    } finally {
      clearTimeout(timer)
      try { slot.release() } catch { /* ignore */ }
    }
  })

  // ── 续期（refresh）──
  route('/login/refresh', async ({ body }) => {
    const provider = await resolveProvider(body)
    if (!provider.ok) return provider
    const { id: p, account } = provider
    const raw = account ?? null
    const r = await refreshLogin(p, raw)
    if (!r.ok) {
      return {
        ok: false,
        provider: p,
        error: r.error ?? NO_REFRESH_ERROR,
        note: r.note ?? null,
        reloginRequired: r.reloginRequired === true,
      }
    }
    // 续期成功：把新凭证写回同一条账号（0600），只回掩码
    const norm = normalizeCredential(r.credential)
    let masked = null
    if (norm) {
      const saved = await accounts.save({
        id: account?.id,
        provider: p,
        label: account?.label || CHANNELS[p]?.label || p,
        credential: norm.credential,
        ak: norm.ak,
        sk: norm.sk,
        securityToken: norm.securityToken,
        expiresAt: norm.expiresAt ?? r.expiresAt ?? null,
      })
      if (!saved.ok) return { ok: false, provider: p, error: '续期凭证写盘失败' }
      masked = norm.masked
    }
    return { ok: true, provider: p, note: r.note ?? '已续期', maskedAccount: masked, expiresAt: r.expiresAt ?? norm?.expiresAt ?? null }
  })

  route('/channels/save', async ({ body }) => {
    if (!body || !body.provider) return { ok: false, error: '缺少 provider' }
    if (!CHANNELS[body.provider]) return { ok: false, error: '未知渠道：' + body.provider }
    let cred = String(body.credential || '').trim()
    // 🔑 新契约：前端可直接提交**用户原始粘贴文本**（body.text），由后端解析，
    //    避免 /channels/parse 把凭据原文回给前端（红线 #4）。
    if (!cred && typeof body.text === 'string' && body.text.trim()) {
      const parsed = captureCredential(body.text)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      cred = String(parsed.credential || '').trim()
    }
    // AK/SK 结构化提交（签名型渠道需要三元组，单字符串装不下）
    const ak = typeof body.ak === 'string' ? body.ak.trim() : ''
    const sk = typeof body.sk === 'string' ? body.sk.trim() : ''
    const securityToken = typeof body.securityToken === 'string' ? body.securityToken.trim() : ''
    if (!cred && !(ak && sk)) return { ok: false, error: '凭证不能为空（令牌，或 AK+SK 两项）' }
    // 🔴 后端也做一次形态校验（防前端绕过 / 防误存普通网址）
    if (!(ak && sk) && !looksLikeCredential(cred)) {
      return { ok: false, error: '这不像一个有效令牌（可能是普通网址或太短）。请粘贴带 ?code= 的回调链接或真正的令牌。' }
    }
    if (ak && !sk) return { ok: false, error: 'AK/SK 需要成对提交：还缺 SK' }
    if (sk && !ak) return { ok: false, error: 'AK/SK 需要成对提交：还缺 AK' }
    // 🔴 绝不把凭证写日志
    const r = await accounts.save({
      id: body.id,
      provider: body.provider,
      label: body.label || CHANNELS[body.provider].label,
      credential: cred,
      ak: ak || undefined,
      sk: sk || undefined,
      securityToken: securityToken || undefined,
      expiresAt: Number.isFinite(body.expiresAt) ? body.expiresAt : null,
    })
    if (r.ok) {
      // 🔑 保存成功后**立刻拉取该渠道模型**，让模型选择器马上能看到
      refreshAll(opts.dshHome, accounts, { fetchImpl })
        .then(async (res) => {
          const cnt = (res[body.provider]?.models || []).length
          if (opts.reloadChannelModels) await opts.reloadChannelModels()
          logger.info?.(`渠道 ${body.provider} 模型已刷新：${cnt} 个`)
        })
        .catch(() => {})
    }
    return {
      ok: r.ok, id: r.id,
      kind: r.kind ?? (ak && sk ? 'aksk' : 'token'),
      hint: r.ok ? '已保存，正在拉取可用模型…（几秒后刷新模型选择器）' : '保存失败',
    }
  })

  route('/channels/remove', async ({ body }) => {
    if (!body || !body.id) return { ok: false, error: '缺少 id' }
    return accounts.remove(body.id)
  })

  route('/channels/guides', async () => ({ ok: true, guides: LOGIN_GUIDES }))

  // ── 渠道模型（登录后拉取，出现在模型选择器里）──
  route('/channels/models', async ({ body }) => {
    if (body === undefined) {
      const cache = await readCachedModels(opts.dshHome)
      const list = channelModelsAsList(cache)
      return {
        ok: true,
        at: now(),
        total: list.length,
        models: list,
        byChannel: Object.fromEntries(Object.entries(cache).map(([k, v]) => [k, {
          ok: v.ok,
          count: (v.models || []).length,
          error: v.error,
          at: v.at,
          // 🔴 来源必须暴露：remote（远端拉取）/ builtin（内置兜底）/ builtin-after-http-error…
          source: v.source ?? null,
        }])),
      }
    }
    // POST ⇒ 重新拉取
    try {
      const r = await refreshAll(opts.dshHome, accounts, { fetchImpl })
      if (opts.reloadChannelModels) await opts.reloadChannelModels()
      const list = channelModelsAsList(r)
      return { ok: true, refreshed: Object.keys(r).length, total: list.length, models: list }
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err).slice(0, 200) }
    }
  })

  // ── 解析（前端粘贴内容交给后端统一判定，避免两套规则不一致）──
  //
  // 🔴 安全红线 #4：**绝不把凭据原文回给前端**（XSS/日志/DevTools 都会泄漏）。
  //    只回判定结果 + 掩码预览；保存时前端把**原始粘贴文本**再发一次，
  //    后端自己 parse（见 /channels/save 的 body.text 分支）。
  route('/channels/parse', async ({ body }) => {
    const text = String(body?.text ?? '')
    const r = captureCredential(text)
    return {
      ok: r.ok,
      kind: r.kind ?? null,
      field: r.extra?.field ?? null,
      preview: r.ok ? previewCapture(r) : null,
      length: r.ok ? String(r.credential ?? '').length : 0,
      error: r.ok ? null : r.error,
    }
  })

  // ── 作用域 ──
  route('/scope', async ({ body }) => {
    if (body === undefined) {
      const q = new URLSearchParams()
      return {
        ok: true,
        scopes: [SCOPE.GLOBAL, SCOPE.PRESET, SCOPE.SESSION],
        files: await listScopes(opts.dshHome),
        effective: await effectiveConfig({ dshHome: opts.dshHome }),
        hint: '优先级：会话 > 预设 > 全局。会话/预设作用域需传 id。',
      }
    }
    const scope = body.scope
    if (![SCOPE.GLOBAL, SCOPE.PRESET, SCOPE.SESSION].includes(scope)) {
      return { ok: false, error: '未知作用域：' + scope }
    }
    // 🔴 递归拒绝敏感字段（防嵌套绕过），不落盘
    const hit = findSensitiveKey(body.config || {})
    if (hit) return { ok: false, error: `禁止写入敏感字段：${hit}` }
    try {
      const ok = await writeScope(opts.dshHome, scope, body.id, body.config || {})
      const eff = await effectiveConfig({ dshHome: opts.dshHome, presetId: body.presetId, sessionId: body.sessionId })
      return { ok, scope, layers: eff.layers, hint: ok ? '已写入 ' + scope + ' 作用域' : '写入失败' }
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err).slice(0, 200) }
    }
  })

  // ── 一键删除账号（URL 语义更直白；/channels/remove 保留兼容）──
  route('/accounts/remove', async ({ body }) => {
    const id = String(body?.id ?? '').trim()
    if (!id) return { ok: false, error: '缺少 id' }
    const r = await accounts.remove(id)
    const list = await accounts.list()
    return { ok: r?.ok !== false, id, remaining: list.length }
  })

  // ══════════════════════════════════════════════════════════════════
  // OAuth 公网回调（浏览器从厂商站点跳回来）
  // ══════════════════════════════════════════════════════════════════
  //
  // 🔴 云服务器部署的硬约束：插件跑在服务器上，用户浏览器在另一台机器。
  //    若 redirect_uri 用 http://127.0.0.1:<port>/callback，浏览器会跳到
  //    **用户自己的机器**，服务器上的插件永远收不到 ⇒「点去官网拿不到授权」。
  //    因此回调必须落在宿主公网地址：<publicBase>/cs-myfree/login/callback
  //    该路径不用 cookie（浏览器跨站跳转带不上），改用一次性 state 鉴权。
  const CALLBACK_PATH = `${PREFIX}/login/callback`
  try {
    webServer.register({
      kind: 'exact',
      path: CALLBACK_PATH,
      handler: async (req, res) => {
        let url
        try { url = new URL(req.url ?? '/', 'http://localhost') } catch { url = null }
        const state = String(url?.searchParams.get('state') ?? '')
        const code = String(url?.searchParams.get('code') ?? url?.searchParams.get('authorization_code') ?? '')
        // 各渠道回调参数名不同（trae: refreshToken/userJwt；accio: code…）
        const params = {}
        if (url) for (const [k, v] of url.searchParams.entries()) params[k] = v
        const html = (title, detail) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,-apple-system,sans-serif;padding:48px;text-align:center;line-height:1.7">
<h2>${title}</h2><p style="opacity:.7">${detail}</p>
<p style="margin-top:28px"><a href="${PREFIX}">返回设置页</a></p></body>`)
        }
        let r = null
        try { r = typeof loginEngine.callback === 'function' ? await loginEngine.callback({ state, code, params }) : null } catch { r = null }
        if (r && r.ok === false) return html('⚠️ 授权失败', String(r.error ?? '回调参数无效或会话已过期，请回设置页重试'))
        return html(code ? '✅ 授权已收到' : '⚠️ 未拿到授权码', '可以关闭本页，回到 DSH 设置页查看登录结果。')
      },
    })
    registered++
  } catch (err) {
    logger.warn?.(`注册 ${CALLBACK_PATH} 失败：${safeErrorText(err)}`)
  }

  return registered
}
