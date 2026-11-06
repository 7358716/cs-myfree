/**
 * cs-myfree — 余额查询（对应本机 myfree 的「左下角实时余额 chip」）
 *
 * 🔴 安全红线（这是最敏感的功能，因为它碰到了真实付费账户）：
 *   1. **绝不返回、绝不记录 API Key 的任何片段**
 *   2. 只返回**余额数字**与「可用」布尔
 *   3. 路由必须过 guard（外部未登录一律 403）
 *   4. 响应 `cache-control: no-store`
 *
 * 数据来源（与本机同款）：
 *   GET https://api.deepseek.com/user/balance
 *   → { is_available, balance_infos: [{currency, total_balance, granted_balance, topped_up_balance}] }
 *
 * 火山方舟（T3a，design/19 §4）：
 *   · 实测（2026-11-05，带 ARK_API_KEY）：
 *       ark.cn-beijing.volces.com/api/v3/models → 200（key 有效）
 *       /api/v3/billing/balance、/balance、/api_keys → 全部 404（方舟 API **没有**余额端点）
 *       billing.volcengineapi.com → 400（计费 OpenAPI 需主账号 AK/SK + SDK-HMAC-SHA256 签名；
 *       ARK_API_KEY 是推理 API Key，**无计费查询权限**）
 *   · 结论：ARK key 查不了真实余额。归一化输出 source:
 *       'live'      — 部署方注入 volcBalance（主账号 AK/SK 签名查询）后才有
 *       'estimated' — 默认回退：本地账本估算（明确标注「估算」）
 *       'error'     — 查询失败（如实返回原因，不静默）
 *
 * 契约 D（design/22 §5，2026-11-05 用户决策：**先做估算展示 + 预留 AK/SK 接口**）：
 *   1. `resolveVolcAkSk()`   —— env VOLC_ACCESS_KEY_ID/SECRET → credentials.yaml 同名键；
 *      **只在内存里用**，返回值里的 ak/sk 绝不进日志、绝不进响应体（对外只给 source/masked）。
 *   2. `queryArkOfficial()`  —— 无 AK/SK ⇒ 立刻 `{ok:false, code:'NO_AK_SK'}`，**一个网络请求都不发**；
 *      有 AK/SK ⇒ 走火山 HMAC-SHA256（SigV4 风格）签名。
 *      ⚠️ 官方计费的 **Action/Version 在无 AK/SK 环境下无法实测确认**（文档站是 SPA、需登录），
 *      所以默认**不猜 endpoint**、如实回 `NOT_IMPLEMENTED`；签名逻辑保留（结构是确定的），
 *      部署方确认 endpoint 后可用 `endpoint` 覆盖参数真正启用。**绝不假装成功**。
 *   3. 三分支顺序不可变：live → estimated（有 ARK_API_KEY，走本地账本近 30 天估算）→ error。
 *
 * @module cs-myfree/web/cash
 */

import { createHash, createHmac } from 'node:crypto'
import { readSpend } from '../audit/sources.js'

export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
export const CASH_PATH = '/cs-myfree/cash'

/**
 * 从凭据解析器取 DeepSeek Key。
 * ⚠️ 只在内存中使用，函数返回后不留引用。
 */
async function resolveDeepSeekKey(ctx) {
  try {
    const envKey = process.env.DEEPSEEK_API_KEY
    if (envKey && envKey !== '') return envKey
  } catch { /* ignore */ }
  try {
    const creds = ctx?.get?.('credentials', false)
    if (creds && typeof creds.resolve === 'function') {
      const r = await creds.resolve('DEEPSEEK_API_KEY')
      if (r && typeof r.value === 'string' && r.value !== '') return r.value
    }
  } catch { /* ignore */ }
  return null
}

/**
 * 从凭据解析器取 ARK_API_KEY（火山方舟推理 API Key）。
 * ⚠️ 只在内存中使用；仅用于探测「key 是否配置」，绝不出现在任何响应里。
 */
async function resolveArkKey(ctx) {
  try {
    const envKey = process.env.ARK_API_KEY
    if (envKey && envKey !== '') return envKey
  } catch { /* ignore */ }
  try {
    const creds = ctx?.get?.('credentials', false)
    if (creds && typeof creds.resolve === 'function') {
      const r = await creds.resolve('ARK_API_KEY')
      if (r && typeof r.value === 'string' && r.value !== '') return r.value
    }
  } catch { /* ignore */ }
  return null
}

/* ══════════════════════════════════════════════════════════════════════════
 * 契约 D：火山主账号 AK/SK 与官方计费查询
 * ══════════════════════════════════════════════════════════════════════════ */

/** 环境变量/凭据键名（两者同名，方便「env 优先、凭据兜底」） */
export const VOLC_ENV_AK = 'VOLC_ACCESS_KEY_ID'
export const VOLC_ENV_SK = 'VOLC_SECRET_ACCESS_KEY'

/** 火山费用中心 OpenAPI 的服务标识（签名 scope 用；endpoint 见下方注释） */
export const VOLC_BILLING_HOST = 'billing.volcengineapi.com'
export const VOLC_BILLING_SERVICE = 'billing'
export const VOLC_BILLING_VERSION = '2022-01-01'
export const VOLC_BILLING_ACTION = 'QueryBalanceAcct'

/**
 * 官方计费 endpoint 是否已实测确认。
 * 🔴 现在保持 false：2026-11-05 实测环境下（只有推理 key ARK_API_KEY）无法确认
 *    Action/Version/返回体结构（文档站 SPA 需登录），猜测 endpoint 只会产出「看起来像
 *    live 的假数据」。因此默认不请求、如实回 NOT_IMPLEMENTED；
 *    部署方拿到主账号 AK/SK 实测确认后，用 `endpoint` 参数覆盖即可启用真查询。
 */
export const VOLC_BILLING_ENDPOINT_CONFIRMED = false

/**
 * AK 掩码（**唯一允许出现在日志/响应里的形态**）。
 * 只露前 4 后 4，中间打码；SK **永不给任何掩码**（露一半也可能被撞库利用）。
 * @param {string|null} ak
 * @returns {string|null}
 */
export function maskAk(ak) {
  const s = typeof ak === 'string' ? ak : ''
  if (s === '') return null
  if (s.length <= 8) return '****'
  return `${s.slice(0, 4)}****${s.slice(-4)}`
}

/**
 * 把 AK/SK 解析结果投影成**可以对外**的形态（日志/响应只能用这个）。
 * @param {{ak?:string|null, sk?:string|null, source?:string|null, masked?:string|null}|null} r
 * @returns {{source:'env'|'credentials'|null, masked:string|null}}
 */
export function volcAkSkPublic(r) {
  return {
    source: r?.source === 'env' || r?.source === 'credentials' ? r.source : null,
    masked: r?.masked ?? null,
  }
}

/**
 * 解析火山主账号 AK/SK（契约 D1）。
 *
 * 优先级：env `VOLC_ACCESS_KEY_ID`/`VOLC_SECRET_ACCESS_KEY`
 *        → `credentials`（credentials.yaml 解析出的**同名键**对象）
 *
 * 🔴 纪律：
 *   1. **绝不打日志**（任何调用方都不得 log 返回值里的 ak/sk）；
 *   2. **绝不进响应体** —— 要对外只能取 `volcAkSkPublic(r)`（只含 source/masked）；
 *   3. ak/sk 必须**成对**才算有值（只有一半等于没有，签名一定会失败）。
 *
 * @param {{credentials?:object|null, env?:object}} [opts]
 * @returns {{ak:string|null, sk:string|null, source:'env'|'credentials'|null, masked:string|null}}
 */
export function resolveVolcAkSk({ credentials = null, env = process.env } = {}) {
  const pick = (src, key) => {
    if (!src || typeof src !== 'object') return ''
    try {
      const v = src[key]
      return typeof v === 'string' ? v.trim() : ''
    } catch { return '' }
  }

  // ① env 优先（部署方用环境变量注入时以它为准）
  const envAk = pick(env, VOLC_ENV_AK)
  const envSk = pick(env, VOLC_ENV_SK)
  if (envAk !== '' && envSk !== '') return { ak: envAk, sk: envSk, source: 'env', masked: maskAk(envAk) }

  // ② credentials.yaml 同名键兜底
  const cAk = pick(credentials, VOLC_ENV_AK)
  const cSk = pick(credentials, VOLC_ENV_SK)
  if (cAk !== '' && cSk !== '') return { ak: cAk, sk: cSk, source: 'credentials', masked: maskAk(cAk) }

  // ③ 都没有（或只有一半）⇒ 如实空值，由上层落 estimated 分支
  return { ak: null, sk: null, source: null, masked: null }
}

/** SHA-256 十六进制 */
function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/** HMAC-SHA256（返回 Buffer，便于链式派生） */
function hmac256(key, s) {
  return createHmac('sha256', key).update(s, 'utf8').digest()
}

/** RFC1123 之外的火山/SigV4 风格时间戳：20261105T153700Z（UTC） */
function sigDate(ms) {
  return new Date(Number(ms) || Date.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/** canonical query / URI 的转义（RFC3986 严格版） */
function uriEncode(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/**
 * 火山引擎 OpenAPI 签名（HMAC-SHA256 / SigV4 结构，无 AK/SK 无法端到端实测）。
 *
 * 结构说明（写清楚是为了后来人能对文档逐条核）：
 *   CanonicalRequest = method\nuri\nquery\ncanonicalHeaders\nsignedHeaders\nsha256(body)
 *   参与签名的头：content-type / host / x-content-sha256 / x-date
 *   StringToSign     = HMAC-SHA256\n{xDate}\n{date}/{region}/{service}/request\nsha256(CanonicalRequest)
 *   派生密钥          = HMAC(sk,date) → HMAC(_,region) → HMAC(_,service) → HMAC(_,'request')
 *
 * ⚠️ 本函数是**纯函数**（不联网、不读全局），单测直接对固定输入断言签名串稳定性。
 *
 * @param {{ak:string, sk:string, region?:string, service?:string, method?:string,
 *          path?:string, query?:object, body?:string, headers?:object, atMs?:number}} o
 * @returns {{headers:object, canonicalRequest:string, stringToSign:string, signature:string,
 *            authorization:string, xDate:string, dateStamp:string, payloadHash:string}}
 */
export function volcSignV4({
  ak, sk, region = 'cn-beijing', service = VOLC_BILLING_SERVICE,
  method = 'POST', path: reqPath = '/', query = {}, body = '', headers = {}, atMs = Date.now(),
} = {}) {
  const xDate = sigDate(atMs)
  const dateStamp = xDate.slice(0, 8)
  const payloadHash = sha256Hex(body)

  // canonical query：键排序 + 严格转义
  const canonicalQuery = Object.keys(query)
    .filter((k) => query[k] !== undefined && query[k] !== null)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join('&')

  // canonical headers：小写键、按键名排序、值为去首尾空白的单行
  const base = {
    'content-type': headers['content-type'] ?? 'application/x-www-form-urlencoded',
    host: headers.host ?? VOLC_BILLING_HOST,
    'x-content-sha256': payloadHash,
    'x-date': xDate,
  }
  for (const [k, v] of Object.entries(headers)) {
    const key = String(k).toLowerCase()
    if (key === 'host' || key === 'content-type' || key === 'x-content-sha256' || key === 'x-date') continue
    base[key] = String(v).trim()
  }
  const signedHeaderNames = Object.keys(base).sort()
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${base[k]}\n`).join('')
  const signedHeaders = signedHeaderNames.join(';')

  const canonicalRequest = [
    String(method).toUpperCase(), reqPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n')

  const stringToSign = [
    'HMAC-SHA256', xDate, `${dateStamp}/${region}/${service}/request`, sha256Hex(canonicalRequest),
  ].join('\n')

  const kDate = hmac256(sk, dateStamp)
  const kRegion = hmac256(kDate, region)
  const kService = hmac256(kRegion, service)
  const kSigning = hmac256(kService, 'request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  const authorization = `HMAC-SHA256 Credential=${ak}/${dateStamp}/${region}/${service}/request, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    headers: { ...base, authorization },
    canonicalRequest, stringToSign, signature, authorization, xDate, dateStamp, payloadHash,
  }
}

/**
 * 从官方计费返回体里**防御性**提取总额（结构未实测，取不到就如实报错，不瞎凑数）。
 * @param {any} payload
 * @returns {{ok:true, totalCNY:number, items:Array} | {ok:false}}
 */
function parseVolcBilling(payload) {
  try {
    const r = payload?.ResponseMetadata ?? {}
    if (r.Error) return { ok: false, error: String(r.Error.Message ?? r.Error.Code ?? 'API 返回错误'), code: String(r.Error.Code ?? 'API_ERROR') }
    const res = payload?.Result ?? payload?.result ?? payload ?? {}
    const candidates = [
      res.AvailableBalance, res.availableBalance, res.Balance, res.balance,
      res.TotalAmount, res.totalAmount, res.TotalBalance, res.totalBalance,
    ]
    const total = candidates.map(Number).find((n) => Number.isFinite(n))
    if (total === undefined) return { ok: false, code: 'UNPARSEABLE', error: '官方计费返回体无法解析（结构待确认）' }
    const rawItems = Array.isArray(res.Items) ? res.Items : (Array.isArray(res.items) ? res.items : [])
    const items = rawItems.map((it) => ({
      model: String(it?.Model ?? it?.model ?? ''),
      calls: Number(it?.Calls ?? it?.calls ?? 0) || 0,
      inputTokens: Number(it?.InputTokens ?? it?.inputTokens ?? 0) || 0,
      outputTokens: Number(it?.OutputTokens ?? it?.outputTokens ?? 0) || 0,
      costCNY: Number(it?.Cost ?? it?.cost ?? it?.CostCNY ?? 0) || 0,
    })).filter((it) => it.model !== '')
    return { ok: true, totalCNY: total, items }
  } catch {
    return { ok: false, code: 'UNPARSEABLE', error: '官方计费返回体无法解析（结构待确认）' }
  }
}

/**
 * 火山方舟官方计费查询（契约 D2 第一分支的唯一实现）。
 *
 * 行为表（**顺序不可变**）：
 *   · 无 ak/sk                 ⇒ `{ok:false, code:'NO_AK_SK'}`，**零网络请求**（测试断言 fetchImpl 调用数=0）
 *   · 有 ak/sk 但 endpoint 未确认 ⇒ `{ok:false, code:'NOT_IMPLEMENTED'}`，**同样零网络请求**（不猜、不假装成功）
 *   · 有 ak/sk + endpoint 覆盖  ⇒ 发签名请求；失败 ⇒ `{ok:false, error, code}`；
 *                                 成功且能解析 ⇒ `{ok:true, source:'live', items, totalCNY, period, fetchedAt}`
 *
 * @param {{fetchImpl?:Function, ak?:string|null, sk?:string|null, region?:string,
 *          now?:Function, endpoint?:string|null, action?:string, version?:string,
 *          timeoutMs?:number}} [opts]
 * @returns {Promise<object>}
 */
export async function queryArkOfficial({
  fetchImpl = globalThis.fetch, ak = null, sk = null, region = 'cn-beijing',
  now = () => Date.now(), endpoint = null, action = VOLC_BILLING_ACTION,
  version = VOLC_BILLING_VERSION, timeoutMs = 8000,
} = {}) {
  // ① 没有主账号 AK/SK：立刻返回，绝不尝试（推理 key 冒充不了主账号）
  if (!ak || !sk) {
    return { ok: false, code: 'NO_AK_SK', error: '未配置主账号 AK/SK（VOLC_ACCESS_KEY_ID / VOLC_SECRET_ACCESS_KEY）' }
  }

  // ② endpoint 未实测确认 ⇒ 如实报告缺口，不发请求（凭猜测打官方接口等于伪造数据源）
  if (!endpoint && VOLC_BILLING_ENDPOINT_CONFIRMED !== true) {
    return {
      ok: false,
      code: 'NOT_IMPLEMENTED',
      error: `待确认官方计费 endpoint（需主账号 AK/SK 实测）：${VOLC_BILLING_HOST} action=${action} version=${version}`,
    }
  }
  if (!endpoint) {
    // 防御：即使有人把 CONFIRMED 改成 true，也必须显式给 endpoint，绝不内置猜测值
    return { ok: false, code: 'NOT_IMPLEMENTED', error: '未提供 endpoint（不内置猜测的官方地址）' }
  }

  // ③ 有 endpoint ⇒ 真发签名请求（部署方显式启用后的路径）
  const atMs = Number(now()) || Date.now()
  const body = `Action=${uriEncode(action)}&Version=${uriEncode(version)}`
  const signed = volcSignV4({
    ak, sk, region, method: 'POST', path: '/', body, atMs,
    headers: { host: String(endpoint).replace(/^https?:\/\//, '').split('/')[0] },
  })

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { ...signed.headers, 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: ctrl?.signal,
    })
    let payload = null
    try { payload = await res.json() } catch { payload = null }
    if (!res.ok) {
      const apiErr = payload?.ResponseMetadata?.Error
      return {
        ok: false,
        code: apiErr?.Code ? `HTTP_${res.status}_${apiErr.Code}` : `HTTP_${res.status}`,
        error: apiErr?.Message ? String(apiErr.Message).slice(0, 160) : `计费接口返回 HTTP ${res.status}`,
      }
    }
    const parsed = parseVolcBilling(payload)
    if (!parsed.ok) return { ok: false, code: parsed.code ?? 'UNPARSEABLE', error: parsed.error ?? '官方计费返回体无法解析' }
    return {
      ok: true,
      source: 'live',
      items: parsed.items,
      totalCNY: parsed.totalCNY,
      period: { fromMs: atMs - 30 * 86400 * 1000, toMs: atMs },
      fetchedAt: atMs,
    }
  } catch (err) {
    // ⚠️ 错误信息里绝不能出现 ak/sk：这里只取 message，且截断
    const msg = String(err?.message ?? err).slice(0, 160)
    return { ok: false, code: err?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', error: msg || '计费查询失败' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 从宿主凭据服务读出 AK/SK 两个键（**只在本进程内用**）。
 * 兼容两种形态：`{resolve(name)}`（宿主 credentials 服务）/ 普通对象（credentials.yaml 解析结果）。
 * @param {object} ctx
 * @returns {Promise<object>} 形如 { VOLC_ACCESS_KEY_ID, VOLC_SECRET_ACCESS_KEY }（缺失则为空对象）
 */
async function readCredentialsMap(ctx) {
  const out = {}
  let creds = null
  try { creds = ctx?.get?.('credentials', false) ?? null } catch { creds = null }
  if (!creds) return out
  if (typeof creds.resolve === 'function') {
    for (const name of [VOLC_ENV_AK, VOLC_ENV_SK]) {
      try {
        const r = await creds.resolve(name)
        if (r && typeof r.value === 'string' && r.value !== '') out[name] = r.value
      } catch { /* 单个键取不到不影响另一个 */ }
    }
    return out
  }
  if (typeof creds === 'object') {
    for (const name of [VOLC_ENV_AK, VOLC_ENV_SK]) {
      try { if (typeof creds[name] === 'string' && creds[name] !== '') out[name] = creds[name] } catch { /* ignore */ }
    }
  }
  return out
}

/**
 * 火山方舟余额（T3a + 契约 D）。
 *
 * 实测结论（2026-11-05）：ARK_API_KEY **没有**计费查询能力
 * （方舟 /api/v3 无余额端点；计费 OpenAPI 需主账号 AK/SK 签名）。
 * 因此三分支顺序固定：live（有 AK/SK 且官方查询成功）→ estimated（有 ARK key，本地账本近 30 天）
 * → error（两者都无 / 账本读取失败）。
 *
 * 🔴 红线：estimated 分支的响应里**不得出现**「官方 / 实时 / live」字样（不许伪装成实时数据）。
 *
 * @param {object} ctx 宿主上下文（credentials）
 * @param {{dshHome?:string, fetchImpl?:Function, volcBalance?:Function, now?:Function,
 *          resolveAkSk?:Function, credentials?:object, region?:string}} opts
 *   volcBalance: async ({fetchImpl, ak, sk, region, now}) =>
 *     {ok:true,total?:number,currency?:string,totalCNY?:number,items?:Array,period?:any,fetchedAt?:number}
 *     | {ok:false,error?:string,code?:string}
 * @returns {Promise<{provider:'ark', total:number|null, currency:string, source:'live'|'estimated'|'error', error:string|null, note?:string}>}
 */
export async function queryArkBalance(ctx, {
  dshHome, fetchImpl, volcBalance = null, now = () => Date.now(),
  resolveAkSk = resolveVolcAkSk, credentials = undefined, region = 'cn-beijing',
} = {}) {
  const atMs = Number(now()) || Date.now()
  const period = { fromMs: atMs - 30 * 86400 * 1000, toMs: atMs }

  // ── 分支① live：主账号 AK/SK + 官方计费查询成功 ──
  // official 只用来决定「提示里给什么状态码」，**失败原因原文绝不整段回传**（怕带出「官方」等字样）
  let official = null
  if (typeof volcBalance === 'function') {
    let ak = null
    let sk = null
    try {
      const credMap = credentials !== undefined ? credentials : await readCredentialsMap(ctx)
      const r = typeof resolveAkSk === 'function' ? resolveAkSk({ credentials: credMap }) : null
      if (r && r.ak && r.sk) { ak = r.ak; sk = r.sk }
    } catch { /* 凭据读取失败 ⇒ 当作无 AK/SK，落到 estimated（不抛给用户） */ }

    try {
      official = await volcBalance({ fetchImpl, ak, sk, region, now })
    } catch (err) {
      official = { ok: false, code: 'THREW', error: String(err?.message ?? err).slice(0, 160) }
    }

    if (official && official.ok === true) {
      const totalRaw = official.total ?? official.totalCNY
      if (Number.isFinite(Number(totalRaw))) {
        return {
          provider: 'ark',
          total: Number(totalRaw),
          currency: official.currency || 'CNY',
          source: 'live',
          error: null,
          fetchedAt: Number.isFinite(Number(official.fetchedAt)) ? Number(official.fetchedAt) : atMs,
          period: official.period ?? period,
          items: Array.isArray(official.items) ? official.items : [],
        }
      }
      // ok:true 但没给数字 ⇒ 当成失败处理（宁可标错也不报假数）
      official = { ok: false, code: 'NO_TOTAL', error: '计费查询未返回可用的金额' }
    }
  }

  // ── 分支② estimated：有 ARK_API_KEY（推理 key）⇒ 本地账本近 30 天估算 ──
  const key = await resolveArkKey(ctx).catch(() => null)
  if (!key) {
    // ── 分支③ error：连推理 key 都没有 ──
    // 有官方查询的失败原因时如实透传（此时没有「估算」可混淆，不会踩 estimated 的红线）
    const reason = official && official.ok === false && official.error
      ? String(official.error).slice(0, 160)
      : null
    return {
      provider: 'ark', total: null, currency: 'CNY', source: 'error',
      error: reason
        // 两条线索都给：没有推理 key，同时计费查询也没成（缺什么一目了然）
        ? `未配置 ARK_API_KEY（火山方舟推理 Key）；计费查询未成功：${reason}`
        : '未配置 ARK_API_KEY（火山方舟的 API Key；可在宿主凭据库中添加）',
    }
  }

  try {
    const spend = await readSpend({ dshHome, fromMs: period.fromMs })
    const ark = (spend.providers ?? []).find((p) => p.provider === 'ark')
    const total = ark && Number.isFinite(ark.costCNY) ? Number(ark.costCNY) : null
    return {
      provider: 'ark',
      total,
      currency: 'CNY',
      source: 'estimated',
      error: null,
      note: total == null
        ? '账本估算：近 30 天无 ark 渠道消耗记录；真实账单需主账号 AK/SK 签名查询'
        : '估算值 = 本地账本近 30 天 ark 渠道消耗合计；真实账单需主账号 AK/SK 签名查询',
      basis: 'ledger-30d',
      period,
      // 只给状态码（NO_AK_SK / NOT_IMPLEMENTED / 签名失败码…），不回传原文
      billingQuery: official ? String(official.code ?? (official.ok === true ? 'OK' : 'ERROR')) : 'skipped',
    }
  } catch (err) {
    return {
      provider: 'ark', total: null, currency: 'CNY', source: 'error',
      error: '账本读取失败：' + String(err?.message ?? err).slice(0, 120),
    }
  }
}

/**
 * 归一化余额响应 —— **只保留数字**，丢弃任何可能敏感的字段。
 * @param {object} j DeepSeek 原始响应
 */
export function normalizeBalance(j) {
  const infos = Array.isArray(j?.balance_infos) ? j.balance_infos : []
  return {
    available: j?.is_available === true,
    balances: infos.map((b) => ({
      currency: String(b?.currency ?? ''),
      total: Number(b?.total_balance ?? 0),
      granted: Number(b?.granted_balance ?? 0),
      topped: Number(b?.topped_up_balance ?? 0),
    })),
  }
}

/**
 * 查询余额。
 * @param {object} ctx 宿主上下文
 * @param {{fetchImpl?:Function, timeoutMs?:number, dshHome?:string, volcBalance?:Function,
 *          resolveAkSk?:Function, now?:Function}} [opts]
 *   volcBalance / resolveAkSk 透传给 queryArkBalance（契约 D 的接线口）
 * @returns {Promise<{ok:boolean, deepseek:object|null, ark:object|null, errors:string[]}>}
 */
export async function queryCash(ctx, {
  fetchImpl = globalThis.fetch, timeoutMs = 8000, dshHome, volcBalance = null,
  resolveAkSk = undefined, now = undefined,
} = {}) {
  const out = { ok: true, deepseek: null, ark: null, errors: [] }
  const arkOpts = { dshHome, fetchImpl, volcBalance }
  if (resolveAkSk !== undefined) arkOpts.resolveAkSk = resolveAkSk
  if (now !== undefined) arkOpts.now = now

  let key = null
  try { key = await resolveDeepSeekKey(ctx) }
  catch { out.errors.push('凭据读取失败') }

  if (!key) {
    out.errors.push('未配置 DEEPSEEK_API_KEY（余额功能需要你自己的 DeepSeek Key）')
    // 即便没有 DeepSeek key，ark 估算仍可独立给出（不等同于「全部失败」）
    out.ark = await queryArkBalance(ctx, arkOpts)
    return out
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(DEEPSEEK_BALANCE_URL, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      out.errors.push(`余额接口返回 HTTP ${res.status}`)
      return out
    }
    out.deepseek = normalizeBalance(await res.json())
  } catch (err) {
    // ⚠️ 错误信息里绝不能出现 key（上面的 err.message 不会含，但保险起见截断）
    out.errors.push(`余额查询失败：${String(err?.message ?? err).slice(0, 120)}`)
  } finally {
    clearTimeout(timer)
    key = null   // 主动丢弃引用
  }

  // 火山方舟（T3a）：独立查询，不因 DeepSeek 成败而影响
  out.ark = await queryArkBalance(ctx, arkOpts)

  return out
}

/**
 * 把余额格式化成人看的文本（客户端也用同一套规则）。
 * @param {{available:boolean, balances:Array}} ds
 */
export function formatCash(ds) {
  if (!ds || !Array.isArray(ds.balances) || ds.balances.length === 0) return '¥ —'
  return ds.balances
    .map((b) => (b.currency === 'CNY' ? '¥' : `${b.currency} `) + Number(b.total).toFixed(2))
    .join(' ')
}

/**
 * 在 webServer 上注册余额路由。
 *
 * 契约 D3 接线：默认 `volcBalance` = `queryArkOfficial`（无主账号 AK/SK 时立刻回
 * `{ok:false, code:'NO_AK_SK'}`、**零网络请求**，cash.js 自然落到 estimated 分支），
 * `resolveAkSk` 默认 = 本模块 `resolveVolcAkSk`（env → credentials.yaml）。部署方可覆盖。
 *
 * @param {object} webServer 宿主 web 服务
 * @param {object} ctx 插件上下文
 * @param {{trustedHosts?:string[], logger?:object, dshHome?:string, fetchImpl?:Function,
 *          volcBalance?:Function, resolveVolcAkSk?:Function, region?:string}} opts
 *   volcBalance: async ({fetchImpl, ak, sk, region, now}) => 官方计费结果
 * @returns {boolean} 是否注册成功
 */
export function registerCashRoute(webServer, ctx, opts = {}) {
  try {
    if (!webServer || typeof webServer.register !== 'function') return false
    const { judge, sendJson } = opts.helpers ?? {}
    if (!judge || !sendJson) return false

    // 默认走官方计费查询（AK/SK 缺失 ⇒ NO_AK_SK ⇒ estimated），不注水的 honest 默认值
    const volcBalance = typeof opts.volcBalance === 'function'
      ? opts.volcBalance
      : (o) => queryArkOfficial({ ...o, region: opts.region ?? 'cn-beijing' })
    const resolveAkSk = typeof opts.resolveVolcAkSk === 'function' ? opts.resolveVolcAkSk : resolveVolcAkSk

    webServer.register({
      kind: 'exact',
      path: CASH_PATH,
      handler: async (req, res) => {
        const verdict = judge(req, { trustedHosts: opts.trustedHosts ?? [] })
        if (!verdict.ok) return sendJson(res, 403, { ok: false, error: verdict.reason })
        try {
          const data = await queryCash(ctx, {
            fetchImpl: opts.fetchImpl, dshHome: opts.dshHome, volcBalance, resolveAkSk,
          })
          return sendJson(res, 200, data)
        } catch (err) {
          return sendJson(res, 500, { ok: false, errors: ['内部错误'] })
        }
      },
    })
    return true
  } catch {
    return false
  }
}
