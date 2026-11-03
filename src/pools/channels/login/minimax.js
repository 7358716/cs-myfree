/**
 * cs-myfree — MiniMax Code 设备码登录（真实实现）
 *
 * 协议来源：对拍 dsh-codearts-auth@1.10.261021 `lib/minimax-oauth.js` + `minimax-product.js`。
 *
 * 流程（OAuth 2.0 设备码 + PKCE S256）：
 *   ① POST {accountHost}/oauth2/device/code
 *        form: client_id=mcode-public & scope=agent.default & audience=agent-backend
 *              & code_challenge=<S256> & code_challenge_method=S256
 *      → { device_code, user_code, verification_uri, expires_in, interval }
 *   ② 用户在浏览器打开 verification_uri，输入 user_code 并授权
 *   ③ 轮询 POST {accountHost}/oauth2/token
 *        form: grant_type=urn:ietf:params:oauth:grant-type:device_code
 *              & device_code=<device_code> & client_id=mcode-public & code_verifier=<verifier>
 *      - OAuth 标准错误 authorization_pending ⇒ 继续；slow_down ⇒ 退避
 *   ④ 拿到 access_token / refresh_token
 *
 * 站点差异（仅 6 个字段）：
 *   minimax    → account.minimax.cn / region=cn
 *   minimaxintl→ account.minimax.io / region=en
 *
 * @module cs-myfree/pools/channels/login/minimax
 */

import { createHash, randomBytes } from 'node:crypto'

const PKCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

export const MINIMAX_PRODUCTS = Object.freeze({
  minimax: {
    id: 'minimax',
    accountHost: 'https://account.minimax.cn',
    apiHost: 'https://agent.minimax.cn',
    region: 'cn',
    clientId: 'mcode-public',
    audience: 'agent-backend',
    scope: 'agent.default',
  },
  minimaxintl: {
    id: 'minimaxintl',
    accountHost: 'https://account.minimax.io',
    apiHost: 'https://agent.minimax.io',
    region: 'en',
    clientId: 'mcode-public',
    audience: 'agent-backend',
    scope: 'agent.default',
  },
})

export const MINIMAX_DEVICE_CODE_PATH = '/oauth2/device/code'
export const MINIMAX_TOKEN_PATH = '/oauth2/token'
export const MINIMAX_HTTP_TIMEOUT_MS = 30_000

/** PKCE（S256） */
export function createMinimaxPkce() {
  const bytes = randomBytes(64)
  let verifier = ''
  for (let i = 0; i < 64; i++) verifier += PKCE_ALPHABET[bytes[i] % PKCE_ALPHABET.length]
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** 解析设备码响应 */
export function parseMinimaxDeviceAuthorization(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const deviceCode = typeof payload.device_code === 'string' ? payload.device_code : ''
  const userCode = typeof payload.user_code === 'string' ? payload.user_code : ''
  const verificationUri = typeof payload.verification_uri === 'string' ? payload.verification_uri
    : typeof payload.verification_uri_complete === 'string' ? payload.verification_uri_complete : ''
  if (!deviceCode || !userCode || !verificationUri) return null
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: typeof payload.verification_uri_complete === 'string' ? payload.verification_uri_complete : '',
    expiresInSec: Number(payload.expires_in) > 0 ? Number(payload.expires_in) : 600,
    intervalSec: Math.max(1, Number(payload.interval) > 0 ? Number(payload.interval) : 5),
  }
}

/** 解析 token 响应 */
export function parseMinimaxTokenGrant(payload) {
  if (!payload || typeof payload !== 'object') return null
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : ''
  if (!accessToken) return null
  const expiresIn = Number(payload.expires_in)
  return {
    accessToken,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined,
    expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : undefined,
  }
}

/** start：申请设备码（真实网络请求） */
export async function startMinimax(provider, ch, opts = {}) {
  const product = MINIMAX_PRODUCTS[provider] ?? MINIMAX_PRODUCTS.minimax
  const fetcher = opts.fetchImpl ?? globalThis.fetch
  const pkce = createMinimaxPkce()
  let res
  try {
    res = await fetcher(`${product.accountHost}${MINIMAX_DEVICE_CODE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: product.clientId,
        scope: product.scope,
        audience: product.audience,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
      }).toString(),
      signal: AbortSignal.timeout(MINIMAX_HTTP_TIMEOUT_MS),
    })
  } catch (err) {
    return {
      flow: 'device', url: null, userCode: null,
      instructions: [`无法连接 ${product.id} 登录服务（网络问题）`, '可改用「粘贴凭据」入口'],
      _startError: `无法连接登录服务：${String(err?.message ?? err).slice(0, 120)}`,
    }
  }
  if (!res.ok) {
    return {
      flow: 'device', url: null, userCode: null,
      instructions: [`${product.id} 登录服务返回 HTTP ${res.status}`, '可改用「粘贴凭据」入口'],
      _startError: `设备码申请失败（HTTP ${res.status}）`,
    }
  }
  let payload = null
  try { payload = await res.json() } catch { payload = null }
  const auth = parseMinimaxDeviceAuthorization(payload)
  if (!auth) {
    return {
      flow: 'device', url: null, userCode: null,
      instructions: ['登录服务返回的设备码格式异常', '可改用「粘贴凭据」入口'],
      _startError: '设备码响应缺少必要字段',
    }
  }
  return {
    flow: 'device',
    url: auth.verificationUriComplete || auth.verificationUri,
    userCode: auth.userCode,
    verificationUri: auth.verificationUriComplete || auth.verificationUri,
    interval: auth.intervalSec,
    instructions: [
      `在打开的页面输入设备码：${auth.userCode}`,
      '完成授权后不用复制任何东西，本页会自动检测',
      `设备码约 ${Math.round(auth.expiresInSec / 60)} 分钟内有效`,
    ],
    _product: product.id,
    _deviceCode: auth.deviceCode,
    _pkceVerifier: pkce.verifier,
    _expiresAtMs: Date.now() + auth.expiresInSec * 1000,
    _intervalMs: auth.intervalSec * 1000,
  }
}

/** poll：OAuth 设备码轮询 */
export async function pollMinimax(session, opts = {}) {
  const product = MINIMAX_PRODUCTS[session._product ?? 'minimax'] ?? MINIMAX_PRODUCTS.minimax
  const fetcher = opts.fetchImpl ?? globalThis.fetch
  if (!session._deviceCode) return { state: 'error', error: '登录会话缺少设备码，请重新发起' }
  if (session._expiresAtMs && Date.now() > session._expiresAtMs) {
    return { state: 'error', error: '设备码已过期，请重新发起登录' }
  }
  let res
  try {
    res = await fetcher(`${product.accountHost}${MINIMAX_TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: session._deviceCode,
        client_id: product.clientId,
        code_verifier: session._pkceVerifier ?? '',
      }).toString(),
      signal: AbortSignal.timeout(MINIMAX_HTTP_TIMEOUT_MS),
    })
  } catch {
    session._failures = (session._failures ?? 0) + 1
    if (session._failures > 5) return { state: 'error', error: '无法连接登录服务（连续多次失败）' }
    return { state: 'waiting', hint: '网络抖动，继续等待…' }
  }
  session._failures = 0
  let payload = null
  try { payload = await res.json() } catch { payload = null }

  if (res.ok) {
    const t = parseMinimaxTokenGrant(payload)
    if (t) {
      return {
        state: 'ok', hint: '登录成功',
        credential: { token: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt },
      }
    }
    return { state: 'waiting', hint: '授权成功但缺少 token 字段，继续等待…' }
  }
  const code = typeof payload?.error === 'string' ? payload.error : ''
  if (code === 'authorization_pending') return { state: 'waiting', hint: '已打开授权页，等待你完成授权…' }
  if (code === 'slow_down') {
    session._intervalMs = Math.min((session._intervalMs ?? 5000) + 1000, 15000)
    return { state: 'waiting', hint: '服务端要求降速，继续等待…' }
  }
  if (code === 'access_denied' || code === 'expired_token' || code === 'invalid_grant') {
    return { state: 'error', error: `授权失败：${code}` }
  }
  return { state: 'waiting', hint: `上游返回 HTTP ${res.status}，继续等待…` }
}
