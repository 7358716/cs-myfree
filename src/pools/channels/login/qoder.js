/**
 * cs-myfree — Qoder 设备码登录（真实实现）
 *
 * 协议来源：对拍 dsh-codearts-auth@1.10.261021 `lib/qoder.js` + `qoder-oauth.js`。
 *
 * 流程（**不是**标准 OAuth 授权码，是 Qoder 的设备码 + PKCE 轮询）：
 *   ① 生成 PKCE（verifier/challenge S256）+ nonce + machineId
 *   ② 打开授权页：`{authBase}/device/selectAccounts?challenge&challenge_method=S256&nonce&machine_id&client_id`
 *   ③ 用户在浏览器完成登录（页面会把授权结果绑定到 nonce）
 *   ④ 轮询：`GET {openApiBase}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256`
 *      - **404 = 用户还没完成授权 ⇒ 继续轮询**（关键！不是错误）
 *      - 200 + token = 成功
 *   ⑤ token 响应字段：token/access_token、refresh_token、expires_at、user_id、user_name
 *
 * ⚠️ 轮询必须挂 `openApiBase`（openapi.qoder.sh），不是 authBase —— 写错 host 登录永远失败。
 * ⚠️ client_id 必须用 prod 的那个（qoder-product.js 里 QODER.clientId）。
 *
 * @module cs-myfree/pools/channels/login/qoder
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'

/** PKCE verifier 允许的字符集（RFC 7636 unreserved） */
const PKCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

export const QODER_PRODUCTS = Object.freeze({
  qoder: {
    id: 'qoder',
    authBase: 'https://qoder.com',
    openApiBase: 'https://openapi.qoder.sh',
    clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
  },
  qodercn: {
    id: 'qodercn',
    authBase: 'https://qoder.cn',
    openApiBase: 'https://openapi.qoder.com.cn',
    clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
  },
})

export const QODER_DEVICE_SELECT_PATH = '/device/selectAccounts'
export const QODER_POLL_PATH = '/api/v1/deviceToken/poll'
export const QODER_POLL_INTERVAL_MS = 1500
export const QODER_POLL_MAX_FAILURES = 5
export const QODER_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** 生成 PKCE（verifier 43~128 字符，challenge=S256 base64url） */
export function createQoderPkce() {
  const length = 64
  const bytes = randomBytes(length)
  let verifier = ''
  for (let i = 0; i < length; i++) verifier += PKCE_ALPHABET[bytes[i] % PKCE_ALPHABET.length]
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** 授权页 URL */
export function buildQoderAuthUrl(session, product) {
  const query = new URLSearchParams({
    challenge: session.pkce.challenge,
    challenge_method: 'S256',
    nonce: session.nonce,
    machine_id: session.machineId,
    client_id: product.clientId,
  })
  return `${product.authBase}${QODER_DEVICE_SELECT_PATH}?${query.toString()}`
}

/** 轮询 URL（挂 openApiBase） */
export function buildQoderPollUrl(session, product) {
  const query = new URLSearchParams({
    nonce: session.nonce,
    verifier: session.pkce.verifier,
    challenge_method: 'S256',
  })
  return `${product.openApiBase}${QODER_POLL_PATH}?${query.toString()}`
}

/** token 响应 → 归一字段 */
export function parseQoderTokenPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { accessToken: '' }
  const s = value
  const pick = (...keys) => {
    for (const k of keys) { if (typeof s[k] === 'string' && s[k].length > 0) return s[k] }
    return undefined
  }
  const ts = (v) => {
    if (v === undefined || v === null) return undefined
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
    const t = Date.parse(String(v))
    return Number.isNaN(t) ? undefined : t
  }
  const accessToken = pick('token', 'device_token', 'access_token') ?? ''
  return {
    accessToken,
    refreshToken: pick('refresh_token', 'refreshToken'),
    expiresAt: ts(s.expires_at ?? s.expiresAt),
    uid: pick('user_id', 'userId'),
    userName: pick('user_name', 'userName'),
  }
}

/**
 * start：生成 PKCE/nonce/machineId，返回真实授权页 URL。
 * @param {string} provider 'qoder' | 'qodercn'
 */
export function startQoder(provider, ch, opts = {}) {
  const product = QODER_PRODUCTS[provider] ?? QODER_PRODUCTS.qoder
  const session = {
    pkce: createQoderPkce(),
    nonce: randomUUID(),
    machineId: randomUUID(),
  }
  return {
    flow: 'device',
    url: buildQoderAuthUrl(session, product),
    pollingOnly: true,          // 没有回调，纯轮询
    interval: 2,
    userCode: null,             // Qoder 没有设备码人读码，只有授权页
    verificationUri: null,
    instructions: [
      '点「打开登录页」，在 Qoder 页面完成登录授权',
      '授权完成后不用复制任何东西，本页会自动检测',
      '本渠道没有回调，靠后台轮询（约 2~10 秒）',
    ],
    _product: product.id,
    _pkceVerifier: session.pkce.verifier,
    _nonce: session.nonce,
    _machineId: session.machineId,
  }
}

/**
 * poll：轮询设备码端点。
 * 404 = 等待用户完成授权（必须继续）；其它非 2xx = 服务端异常。
 */
export async function pollQoder(session, opts = {}) {
  const product = QODER_PRODUCTS[session._product ?? 'qoder'] ?? QODER_PRODUCTS.qoder
  const fetcher = opts.fetchImpl ?? globalThis.fetch
  if (!session._nonce || !session._pkceVerifier) {
    return { state: 'error', error: '登录会话缺少 PKCE 参数，请重新发起' }
  }
  session._attempts = (session._attempts ?? 0) + 1
  if (session._attempts > 200) return { state: 'error', error: '登录超时（约 5 分钟未完成），请重试' }

  const url = buildQoderPollUrl({
    pkce: { verifier: session._pkceVerifier },
    nonce: session._nonce,
  }, product)

  let res
  try {
    res = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    session._failures = (session._failures ?? 0) + 1
    if (session._failures > QODER_POLL_MAX_FAILURES) {
      return { state: 'error', error: '网络连续失败，请检查网络后重试' }
    }
    return { state: 'waiting', hint: '网络抖动，继续等待…' }
  }
  session._failures = 0

  // 🔴 404 = 「无待授权会话」= 用户还没点完 ⇒ 继续等（不是错误）
  if (res.status === 404) {
    return { state: 'waiting', hint: '已打开登录页，等待你在浏览器完成授权…' }
  }
  if (!res.ok) {
    return { state: 'waiting', hint: `上游返回 HTTP ${res.status}，继续等待…` }
  }
  let data = null
  try { data = await res.json() } catch { data = null }
  const payload = parseQoderTokenPayload(data)
  if (!payload.accessToken) {
    return { state: 'waiting', hint: '已收到响应但还没拿到凭据，继续等待…' }
  }
  return {
    state: 'ok',
    hint: '登录成功',
    maskedAccount: payload.userName ?? payload.uid ?? undefined,
    credential: {
      token: payload.accessToken,
      refreshToken: payload.refreshToken,
      expiresAt: payload.expiresAt ?? Date.now() + 24 * 3600 * 1000,
      uid: payload.uid,
      userName: payload.userName,
    },
  }
}
