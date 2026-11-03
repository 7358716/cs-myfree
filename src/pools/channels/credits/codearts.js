/**
 * cs-myfree — CodeArts 积分/签到（真实端点，SDK-HMAC-SHA256 签名）
 *
 * 对拍参考实现 dsh-codearts-auth@1.10.261021 `lib/codearts-credits.js`：
 *   账户/套餐  GET  {snap}/snap-manager/v1/statistics/plugin
 *   活动列表   GET  {snap}/v1/ops/delivery?channel=IDE
 *   领取       POST {snap}/v1/ops/claim   { campaignId, channel: 'IDE' }
 *   领取确认   POST {snap}/v1/ops/confirm { campaignId }
 *
 * 背包/积分口径：metrics[] 里 `usageTotalPackageCredit` 的
 * `package_credit_remain` 是总积分，**不累加分类明细**（会重复计算）。
 *
 * 🔴 两个坑（参考实现实测，必须照做）：
 *   1. `Agent-Type` / `X-Language` **只发送、不参与签名**（进了 canonical 就 401）；
 *   2. 没有服务端「今天已签到」业务码 ⇒ 幂等保护靠**活动列表预检**：
 *      活动不可领且 status ∈ CLAIMED/CONFIRMED/CONSUMED ⇒ already-claimed。
 *
 * @module cs-myfree/pools/channels/credits/codearts
 */

import { signHuaweiRequest } from '../sign.js'

export const SNAP_ENGINE = 'https://snap-access.cn-north-4.myhuaweicloud.com'
export const PATHS = Object.freeze({
  packageInfo: '/snap-manager/v1/statistics/plugin',
  opsDelivery: '/v1/ops/delivery',
  opsClaim: '/v1/ops/claim',
  opsConfirm: '/v1/ops/confirm',
})

/** 每日签到活动类型（IDE 的 USER_LOGIN = 每日登录领取） */
export const DAILY_LOGIN_TYPE = 'USER_LOGIN'
const CLAIMED_STATUSES = ['CLAIMED', 'CONFIRMED', 'CONSUMED']
const EXTRA_HEADERS = { 'Agent-Type': 'PromptCenter', 'X-Language': 'zh-cn' }

const readRec = (o, k) => (o && typeof o === 'object' && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? o[k] : {})
const readStr = (o, k) => (typeof o?.[k] === 'string' ? o[k] : (typeof o?.[k] === 'number' ? String(o[k]) : ''))
const readNum = (o, k) => {
  const v = Number(o?.[k])
  return Number.isFinite(v) ? v : 0
}
const readBool = (o, k) => o?.[k] === true
const readId = (o, k) => (typeof o?.[k] === 'number' ? String(o[k]) : readStr(o, k))

/** 解包 snap 信封：ops/* = {code,message,data}；statistics/plugin = 裸对象 */
export function unwrapEnvelope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: '响应不是 JSON 对象' }
  const code = raw.code
  if (typeof code === 'number') {
    if (code !== 0) return { ok: false, code, message: readStr(raw, 'message') || readStr(raw, 'msg') || `业务码 ${code}` }
    const data = raw.data
    if (data && typeof data === 'object' && !Array.isArray(data)) return { ok: true, data }
    return { ok: false, code, message: '响应缺少 data 字段' }
  }
  return { ok: true, data: raw }
}

/** 把非 2xx 响应整理成带服务端原因的说明（不吞原因） */
function describeHttpFailure(status, text) {
  try {
    const p = JSON.parse(text)
    const code = readStr(p, 'error_code')
    const msg = readStr(p, 'error_msg')
    if (code || msg) return [code, msg].filter(Boolean).join(' ')
  } catch { /* 非 JSON（网关 HTML） */ }
  return String(text ?? '').trim().slice(0, 200) || `HTTP ${status}`
}

/**
 * 发一次带签名（+ 未签名附加头）的 snap 请求。
 * @param {{method:string, path:string, body?:string, secret:{ak:string,sk:string,securityToken?:string}, fetchImpl?:Function, timeoutMs?:number}} o
 */
export async function signedSnapRequest(o) {
  const {
    method, path, body, secret = {},
    fetchImpl = globalThis.fetch, timeoutMs = 30_000,
  } = o
  if (!secret.ak || !secret.sk) {
    throw Object.assign(new Error('codearts 凭据缺少 AK/SK（请用 AK/SK 登录重新保存）'), { code: 'AUTH' })
  }
  const url = `${SNAP_ENGINE}${path}`
  const payload = body === undefined ? '' : String(body)
  const sig = signHuaweiRequest({
    ak: secret.ak,
    sk: secret.sk,
    securityToken: secret.securityToken,
    method,
    url,
    body: payload,
  })
  const headers = {
    'content-type': 'application/json',
    ...sig.headers,
    authorization: sig.authorization,
    ...EXTRA_HEADERS,           // 签名后再追加（进签名会 401）
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: payload }),
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      throw Object.assign(new Error(`codearts HTTP ${res.status}: ${describeHttpFailure(res.status, text)}`), {
        status: res.status,
      })
    }
    let parsed
    try { parsed = JSON.parse(text) } catch { throw new Error('codearts 响应不是合法 JSON') }
    const env = unwrapEnvelope(parsed)
    if (!env.ok) throw Object.assign(new Error(`codearts 业务失败：${env.message}`), { status: 200, code: env.code })
    return env.data
  } finally {
    clearTimeout(timer)
  }
}

/** 从 metrics[] 解析总积分（只认 usageTotalPackageCredit，避免分类重复累加） */
export function parseCreditBalance(metrics) {
  if (!Array.isArray(metrics)) return undefined
  const LABELS = {
    usageTotalPackageCredit: '总积分包',
    usageBasicPackageCredit: '基础积分包',
    usageOnDemandPackageCredit: '按需积分包',
    usageBonusPackageCredit: '赠送积分包',
  }
  const packages = []
  let totalRemain = null
  let saw = false
  for (const m of metrics) {
    if (!m || typeof m !== 'object') continue
    const label = LABELS[readStr(m, 'name')]
    if (!label) continue
    saw = true
    const remaining = readNum(m, 'package_credit_remain')
    const total = readNum(m, 'package_credit_amount')
    if (readStr(m, 'name') === 'usageTotalPackageCredit') totalRemain = remaining
    if (total <= 0 && remaining <= 0) continue
    packages.push({ name: label, unit: 'credit', remaining, total, used: readNum(m, 'package_credit_used') })
  }
  if (!saw) return undefined
  const total = Math.round((totalRemain ?? packages.reduce((s, p) => s + p.remaining, 0)) * 100) / 100
  return { total, packages }
}

/** 查询账户/套餐信息（含积分账户判定 + 余额） */
export async function fetchAccountInfo(o) {
  const data = await signedSnapRequest({ ...o, method: 'GET', path: PATHS.packageInfo })
  const pkg = readRec(data, 'package')
  return {
    isCreditPackage: readBool(pkg, 'is_credit_package'),
    isTokenPackage: readBool(pkg, 'is_token_package'),
    packageName: readStr(pkg, 'package_name_cn') || readStr(pkg, 'package_name_en'),
    packageStatus: readStr(pkg, 'status'),
    credit: parseCreditBalance(data.metrics),
  }
}

/** 查询活动列表（每日签到 = type USER_LOGIN） */
export async function fetchActivities(o) {
  const data = await signedSnapRequest({ ...o, method: 'GET', path: `${PATHS.opsDelivery}?channel=IDE` })
  const items = Array.isArray(data.items) ? data.items : []
  return items
    .filter((x) => x && typeof x === 'object' && !Array.isArray(x))
    .map((it) => ({
      campaignId: readId(it, 'campaignId'),
      type: readStr(it, 'type'),
      title: readStr(it, 'title'),
      claimable: readBool(it, 'claimable'),
      status: readStr(it, 'status'),
      amount: readNum(it, 'benefitAmount') || readNum(it, 'amount') || readNum(it, 'creditAmount'),
    }))
}

/**
 * 执行每日签到（完整流程）。返回 ClaimOutcome：
 *   {kind: 'claimed'|'already-claimed'|'inactive'|'failed', gain?:{amount,unit}, message}
 */
export async function claimDailyCheckin(o) {
  let info
  try {
    info = await fetchAccountInfo(o)
  } catch (err) {
    return { kind: 'failed', message: `账户信息查询失败：${err?.message ?? err}`, code: err?.status ?? -1 }
  }
  if (!info.isCreditPackage) {
    return { kind: 'inactive', message: info.isTokenPackage ? 'Token 计费账户，不在积分活动范围' : '非积分计费账户，不在积分活动范围' }
  }
  let activities
  try {
    activities = await fetchActivities(o)
  } catch (err) {
    return { kind: 'failed', message: `活动列表查询失败：${err?.message ?? err}`, code: err?.status ?? -1 }
  }
  const activity = activities.find((a) => a.type === DAILY_LOGIN_TYPE)
  if (!activity) return { kind: 'inactive', message: '未找到每日签到活动' }
  if (!activity.claimable) {
    return CLAIMED_STATUSES.includes(activity.status)
      ? { kind: 'already-claimed', message: '今天已领取' }
      : { kind: 'inactive', message: `当前不可领取（status=${activity.status}）` }
  }
  if (!activity.campaignId) return { kind: 'failed', message: '活动缺少 campaignId，无法领取' }
  let claimData
  try {
    claimData = await signedSnapRequest({
      ...o,
      method: 'POST',
      path: PATHS.opsClaim,
      body: JSON.stringify({ campaignId: activity.campaignId, channel: 'IDE' }),
    })
  } catch (err) {
    return { kind: 'failed', message: `领取失败：${err?.message ?? err}`, code: err?.status ?? err?.code ?? -1 }
  }
  // 服务端要求确认时补 confirm；确认失败不改变「已领取」结论（积分已进待确认态）
  const benefitId = claimData?.id
  if (benefitId !== null && benefitId !== undefined) {
    try {
      await signedSnapRequest({
        ...o,
        method: 'POST',
        path: PATHS.opsConfirm,
        body: JSON.stringify({ campaignId: activity.campaignId }),
      })
    } catch { /* 确认异常留给日志层，不影响已领取事实 */ }
  }
  const amount = readNum(claimData, 'benefitAmount') || readNum(claimData, 'credit')
    || readNum(claimData, 'credits') || readNum(claimData, 'creditAmount') || readNum(claimData, 'amount')
  return {
    kind: 'claimed',
    gain: { amount: amount > 0 ? amount : activity.amount, unit: 'credit' },
    message: amount > 0 || activity.amount > 0 ? `+${amount > 0 ? amount : activity.amount} 积分` : '已领取',
  }
}

/** 余额/积分查询（GET /credits 用） */
export async function fetchCredits(o) {
  const info = await fetchAccountInfo(o)
  if (!info.credit) return { ok: true, total: null, unit: null, note: '该账户没有积分口径（可能是 Token 计费）', packages: [] }
  return { ok: true, total: info.credit.total, unit: 'credit', packages: info.credit.packages, isCreditPackage: info.isCreditPackage }
}
