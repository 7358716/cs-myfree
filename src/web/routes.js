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
import { probeAll, PRIORITY, DEFAULT_MODEL } from '../pools/keyless/index.js'
import { queryCash, CASH_PATH } from './cash.js'
import { judge, sendJson } from './guard.js'
import { withDefaults, DEFAULTS } from '../config/store.js'
import { planReload, RELOAD_SCOPE } from '../ops/feed.js'
import { collectLedger } from '../audit/sources.js'
import { createAccountStore } from '../pools/channels/accounts.js'
import { listChannels, LOGIN_GUIDES } from './channels.js'
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
    getConfig = () => ({}),
    setConfig = async () => false,
    ledger = null,
    trustedHosts = [],
    logger = { info: () => {}, warn: () => {} },
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
  } = opts

  let registered = 0

  /** 统一包装：guard + 错误处理 + no-store */
  const route = (path, handler, { method = 'ANY' } = {}) => {
    try {
      webServer.register({
        kind: 'exact',
        path: `${PREFIX}${path}`,
        handler: async (req, res) => {
          const verdict = judge(req, { trustedHosts })
          if (!verdict.ok) return sendJson(res, 403, { ok: false, error: verdict.reason })
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
    const builtin = getChain()
    const overrides = (await state?.readChain?.({ chain: [] }))?.chain ?? []
    const merged = mergeChain(builtin, overrides)

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
      const builtin = getChain()
      const overrides = (await state?.readChain?.({ chain: [] }))?.chain ?? []
      return {
        ok: true,
        builtin,
        overrides,
        effective: mergeChain(builtin, overrides),
        tiers: chainSummary(mergeChain(builtin, overrides)),
      }
    }
    // 写覆盖层（整表覆盖）
    const v = validateOverrides(body)
    if (!v.ok) return { ok: false, errors: v.errors, entries: v.entries }
    const saved = await state?.writeChain?.({ chain: v.entries, at: now() })
    return { ok: saved !== false, errors: v.errors, count: v.entries.length, savedAt: now() }
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
      sources: keylessSources().map((s) => ({ id: s.id, label: s.label, note: s.note, probed: probe?.results?.find((r) => r.id === s.id) ?? null })),
      note: '完整模型清单需渠道层登录后由宿主暴露；本页展示免密源可用的默认模型',
    }
  })

  // ── 配置 ──
  route('/config', async ({ body }) => {
    if (body === undefined) return { ok: true, config: withDefaults(getConfig()), defaults: DEFAULTS }
    try {
      const merged = withDefaults({ ...getConfig(), ...body })
      // 安全校验：不允许通过 API 写入任何凭据类字段
      for (const k of Object.keys(merged)) {
        if (/key|token|secret|password/i.test(k)) return { ok: false, error: `禁止通过 API 写敏感字段：${k}` }
      }
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
    const builtin = getChain()
    const overrides = (await state?.readChain?.({ chain: [] }))?.chain ?? []
    const merged = mergeChain(builtin, overrides)
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
    const cred = String(body.credential || '').trim()
    if (!cred) return { ok: false, error: '凭证不能为空' }
    // 🔴 绝不把凭证写日志
    const r = await accounts.save({
      id: body.id,
      provider: body.provider,
      label: body.label || CHANNELS[body.provider].label,
      credential: cred,
      expiresAt: Number.isFinite(body.expiresAt) ? body.expiresAt : null,
    })
    return { ok: r.ok, id: r.id, hint: r.ok ? '已保存到本机 ~/.dsh/cs-myfree/accounts.json（权限 0600），不会上传' : '保存失败' }
  })

  route('/channels/remove', async ({ body }) => {
    if (!body || !body.id) return { ok: false, error: '缺少 id' }
    return accounts.remove(body.id)
  })

  route('/channels/guides', async () => ({ ok: true, guides: LOGIN_GUIDES }))

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
