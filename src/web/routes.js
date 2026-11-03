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
import { judge, sendJson } from './guard.js'
import { withDefaults, DEFAULTS, findSensitiveKey, stripSensitive } from '../config/store.js'
import { planReload, RELOAD_SCOPE } from '../ops/feed.js'
import { collectLedger } from '../audit/sources.js'
import { createAccountStore } from '../pools/channels/accounts.js'
import { listChannels, LOGIN_GUIDES } from './channels.js'
import { captureCredential, previewCapture, looksLikeCredential } from '../pools/channels/capture.js'
import { readCachedModels, refreshAll, channelModelsAsList } from '../pools/channels/catalog.js'
import { SCOPE, readScope, writeScope, effectiveConfig, listScopes } from '../config/scope.js'

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
            logger.warn(`${path} 处理失败：${err?.message ?? err}`)
            sendJson(res, 500, { ok: false, error: String(err?.message ?? err).slice(0, 200) })
          }
        },
      })
      registered++
    } catch (err) {
      logger.warn(`注册 ${path} 失败：${err?.message ?? err}`)
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
        logger.warn?.(`覆盖层已保存但生效失败：${err?.message ?? err}`)
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

    const fails = checks.filter((c) => c.ok === false).length
    return {
      ok: fails === 0,
      at: now(),
      checks,
      summary: fails === 0 ? '全部通过' : `${fails} 项异常`,
      cashPath: CASH_PATH,
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

  route('/channels', async () => ({
    ok: true,
    at: now(),
    channels: await listChannels(accounts),
    total: Object.keys(CHANNELS).length,
  }))

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

  return registered
}
