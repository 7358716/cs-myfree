/**
 * cs-myfree — TRAE（字节跳动）浏览器一键登录（真实实现）
 *
 * 协议来源：对拍 dsh-codearts-auth@1.10.261021 `lib/trae-oauth.js` + `trae-product.js`。
 *
 * 流程（**参数名与常规 OAuth 不同，照抄就会永远停在「授权中」**）：
 *   ① 打开授权页 `https://www.trae.cn/authorization?<17 个参数>`
 *      关键参数：`auth_callback_url`（**不是** callback_url / redirect_uri）、
 *      `login_trace_id`（回调反查 pending 的唯一凭据）、`auth_type=local`、`login_channel=native_ide`
 *   ② TRAE 授权后把浏览器跳回 `auth_callback_url`，并在 query 里带
 *      `refreshToken` / `userJwt` / `userInfo` / `login_trace_id`
 *   ③ 用 `refreshToken` 调 `POST https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken`
 *      body `{ClientID, RefreshToken, ClientSecret:'-', UserID:''}` → accessToken
 *   ④ （可选）`POST /cloudide/api/v3/trae/GetUserInfo` 补昵称
 *
 * 🔴 远程部署适配：`auth_callback_url` 用**宿主公网回调**（由状态机注入），
 *    不用 127.0.0.1（那是用户自己的机器）。
 *
 * @module cs-myfree/pools/channels/login/trae
 */

import { createHash, randomBytes } from 'node:crypto'

export const TRAE_CONSOLE_HOST = 'https://www.trae.cn'
export const TRAE_OAUTH_HOST = 'https://api.trae.com.cn'
export const TRAE_EXCHANGE_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken'
export const TRAE_USER_INFO_PATH = '/cloudide/api/v3/trae/GetUserInfo'
export const TRAE_REQUEST_TIMEOUT_MS = 30_000

export const TRAE_PRODUCT = Object.freeze({
  consoleHost: TRAE_CONSOLE_HOST,
  oauthHost: TRAE_OAUTH_HOST,
  clientId: 'en1oxy7wnw8j9n',
  ideVersion: '0.1.52',
  ideVersionCode: '20260811',
  pluginVersion: '2.3.62834',
})

const PKCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

export function createTraePkce() {
  const bytes = randomBytes(48)
  let verifier = ''
  for (let i = 0; i < 48; i++) verifier += PKCE_ALPHABET[bytes[i] % PKCE_ALPHABET.length]
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * 拼授权 URL（**17 个参数，一个都不能少**）。
 * @param {object} product
 * @param {string} machineId
 * @param {string} deviceId
 * @param {string} callbackUrl 浏览器可达的公网回调
 */
export function buildTraeLoginUrl(product, machineId, deviceId, callbackUrl) {
  const traceId = createHash('sha256').update(`${machineId}:${deviceId}:${Date.now()}`).digest('hex').slice(0, 32)
  const params = new URLSearchParams({
    login_version: '1',
    auth_from: 'solo',
    login_channel: 'native_ide',
    plugin_version: product.pluginVersion,
    auth_type: 'local',
    client_id: product.clientId,
    redirect: '0',
    login_trace_id: traceId,
    // ⚠️ 参数名必须是 auth_callback_url（写 callback_url/redirect_uri 会永远停在授权中）
    auth_callback_url: callbackUrl,
    machine_id: machineId,
    device_id: deviceId,
    x_device_id: deviceId,
    x_machine_id: machineId,
    x_device_brand: 'PC',
    x_device_type: 'PC',
    x_os_version: '1.0',
    x_app_version: product.ideVersion,
    x_app_type: 'stable',
  })
  return { url: `${product.consoleHost}/authorization?${params.toString()}`, traceId }
}

function traeHeaders(product) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': `Trae/${product.ideVersion} (PC)`,
  }
}

/** 解析 ExchangeToken 响应 */
export function parseTraeExchangeResponse(payload) {
  if (!payload || typeof payload !== 'object') return null
  const d = payload.data && typeof payload.data === 'object' ? payload.data : payload
  const accessToken = typeof d.Token === 'string' ? d.Token
    : typeof d.token === 'string' ? d.token
    : typeof d.accessToken === 'string' ? d.accessToken : ''
  if (!accessToken) return null
  const expireAt = Number(d.TokenExpireAt ?? d.tokenExpireAt) || 0
  return {
    accessToken,
    refreshToken: typeof d.RefreshToken === 'string' ? d.RefreshToken
      : typeof d.refreshToken === 'string' ? d.refreshToken : '',
    expiresAt: expireAt > 0 ? (expireAt > 1e12 ? expireAt : expireAt * 1000) : undefined,
  }
}

/** start：生成授权 URL（同步，无需网络） */
export function startTrae(provider, ch, opts = {}) {
  const product = TRAE_PRODUCT
  const machineId = randomBytes(16).toString('hex')
  const deviceId = randomBytes(16).toString('hex')
  const callbackUrl = opts.callbackUrl
    ?? `${String(opts.publicBase ?? '').replace(/\/+$/, '')}${opts.callbackPath ?? '/cs-myfree/login/callback'}`
  const { url, traceId } = buildTraeLoginUrl(product, machineId, deviceId, callbackUrl)
  return {
    flow: 'browser',
    url,
    pollingOnly: false,
    interval: 2,
    instructions: [
      '点「打开登录页」，用 TRAE 账号登录并授权',
      '授权完成后浏览器会自动跳回，本页几秒内自动完成',
      '若页面一直停在「授权中」，多半是回调参数没带对（本插件已按官方 17 参构造）',
    ],
    _machineId: machineId,
    _deviceId: deviceId,
    _traceId: traceId,
    _callbackUrl: callbackUrl,
  }
}

/**
 * poll：等回调参数 → 用 refreshToken 换 accessToken。
 * 回调里可能直接给 refreshToken（正常）或只有 userJwt（兜底）。
 */
export async function pollTrae(session, opts = {}) {
  const fetcher = opts.fetchImpl ?? globalThis.fetch
  const params = session.callbackParams ?? {}
  const refreshToken = String(params.refreshToken ?? params.refresh_token ?? '')
  const userJwt = String(params.userJwt ?? params.user_jwt ?? '')
  const code = session.callbackCode ?? ''

  if (!session._started) session._started = true
  session._attempts = (session._attempts ?? 0) + 1
  if (session._attempts > 200) return { state: 'error', error: '登录超时（约 5 分钟），请重试' }

  // 还没收到回调 ⇒ 等待
  if (!refreshToken && !userJwt && !code) {
    return { state: 'waiting', hint: '已打开登录页，等待你在浏览器完成授权…' }
  }

  // 分支 2：只有 userJwt，直接当 accessToken 用（兜底）
  if (!refreshToken && userJwt) {
    return {
      state: 'ok',
      hint: '登录成功',
      credential: { token: userJwt, expiresAt: Date.now() + 3600 * 1000 },
    }
  }
  if (!refreshToken && code) {
    return { state: 'waiting', hint: '已收到回调但缺少 refreshToken，请重新登录（TRAE 需 refreshToken 换 token）' }
  }

  // 分支 1：ExchangeToken
  try {
    const res = await fetcher(`${TRAE_OAUTH_HOST}${TRAE_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: traeHeaders(TRAE_PRODUCT),
      body: JSON.stringify({
        ClientID: TRAE_PRODUCT.clientId,
        RefreshToken: refreshToken,
        ClientSecret: '-',
        UserID: '',
      }),
      signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS),
    })
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      return { state: 'error', error: `TRAE ExchangeToken 失败（HTTP ${res.status}）` }
    }
    let payload = null
    try { payload = JSON.parse(text) } catch { payload = null }
    const parsed = parseTraeExchangeResponse(payload)
    if (!parsed) return { state: 'error', error: 'TRAE ExchangeToken 响应缺少 Token' }
    return {
      state: 'ok',
      hint: '登录成功',
      credential: {
        token: parsed.accessToken,
        refreshToken: parsed.refreshToken || refreshToken,
        expiresAt: parsed.expiresAt,
      },
    }
  } catch (err) {
    return { state: 'error', error: `TRAE token 交换异常：${String(err?.message ?? err).slice(0, 120)}` }
  }
}
