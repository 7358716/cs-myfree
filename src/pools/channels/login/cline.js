/**
 * cs-myfree — Cline 设备码登录（WorkOS 标准设备码流程，真实实现）
 *
 * 协议来源：对拍 dsh-codearts-auth@1.10.261021 `lib/cline-oauth.js` + `cline-product.js`。
 *
 * 流程（标准 RFC 8628 设备码）：
 *   ① POST {workOsBase}/user_management/authorize/device
 *        form: client_id=<workOsClientId>
 *      → { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }
 *   ② 用户在浏览器打开 verification_uri（或用 complete 链接直接带 code），输入 user_code 并授权
 *   ③ 轮询 POST {workOsBase}/user_management/authenticate
 *        form: grant_type=urn:ietf:params:oauth:grant-type:device_code
 *              &device_code=<device_code>&client_id=<workOsClientId>
 *      - error=authorization_pending ⇒ **继续轮询**（用户还没点）
 *      - error=slow_down           ⇒ 间隔 +1s 继续
 *      - error=access_denied/expired_token/invalid_grant ⇒ 终态失败
 *   ④ 拿到 WorkOS access/refresh token
 *   ⑤ （可选）POST {apiBase}/api/v1/auth/register 换 Cline 自己的 token，字段驼峰
 *
 * @module cs-myfree/pools/channels/login/cline
 */

export const CLINE_WORKOS_BASE = 'https://api.workos.com'
export const CLINE_API_BASE = 'https://api.cline.bot'
export const CLINE_WORKOS_CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR'
export const CLINE_DEVICE_AUTHORIZATION_PATH = '/user_management/authorize/device'
export const CLINE_DEVICE_AUTHENTICATE_PATH = '/user_management/authenticate'
export const CLINE_REGISTER_PATH = '/api/v1/auth/register'
export const CLINE_HTTP_TIMEOUT_MS = 30_000
export const CLINE_POLL_MAX_FAILURES = 5

/**
 * 解析 authorize/device 响应。
 * 缺 device_code / user_code / verification_uri 任一即视为无效。
 */
export function parseClineDeviceAuthorization(payload) {
  if (!payload || typeof payload !== 'object') return null
  const deviceCode = typeof payload.device_code === 'string' ? payload.device_code : ''
  const userCode = typeof payload.user_code === 'string' ? payload.user_code : ''
  const verificationUri = typeof payload.verification_uri === 'string' ? payload.verification_uri : ''
  if (!deviceCode || !userCode || !verificationUri) return null
  const expiresIn = Number(payload.expires_in) > 0 ? Number(payload.expires_in) : 600
  const interval = Math.max(1, Number(payload.interval) > 0 ? Number(payload.interval) : 5)
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: typeof payload.verification_uri_complete === 'string'
      ? payload.verification_uri_complete : '',
    expiresInSec: expiresIn,
    intervalSec: interval,
  }
}

/** 解析 Cline 自己的 token 信封 {success, data} 或扁平结构 */
export function parseClineTokenPayload(payload) {
  if (!payload || typeof payload !== 'object') return null
  const d = (payload.data && typeof payload.data === 'object') ? payload.data : payload
  const accessToken = typeof d.accessToken === 'string' ? d.accessToken
    : typeof d.access_token === 'string' ? d.access_token : ''
  if (!accessToken) return null
  return {
    accessToken,
    refreshToken: typeof d.refreshToken === 'string' ? d.refreshToken
      : typeof d.refresh_token === 'string' ? d.refresh_token : undefined,
    expiresAt: Number.isFinite(d.expiresAt) ? d.expiresAt
      : (Number.isFinite(d.expires_in) ? Date.now() + d.expires_in * 1000 : undefined),
  }
}

/** start：向 WorkOS 申请设备码（真实网络请求，失败要诚实报错） */
export async function startCline(provider, ch, opts = {}) {
  const fetcher = opts.fetchImpl ?? globalThis.fetch
  let res
  try {
    res = await fetcher(`${CLINE_WORKOS_BASE}${CLINE_DEVICE_AUTHORIZATION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: CLINE_WORKOS_CLIENT_ID }).toString(),
      signal: AbortSignal.timeout(CLINE_HTTP_TIMEOUT_MS),
    })
  } catch (err) {
    return {
      flow: 'device',
      url: null,
      userCode: null,
      instructions: ['无法连接 Cline 登录服务（网络问题）', '可改用「粘贴 API Key」入口'],
      _startError: `无法连接 Cline 登录服务：${String(err?.message ?? err).slice(0, 120)}`,
    }
  }
  if (!res.ok) {
    return {
      flow: 'device', url: null, userCode: null,
      instructions: ['Cline 登录服务返回错误，可改用「粘贴凭据」'],
      _startError: `Cline 设备码申请失败（HTTP ${res.status}）`,
    }
  }
  let payload = null
  try { payload = await res.json() } catch { payload = null }
  const auth = parseClineDeviceAuthorization(payload)
  if (!auth) {
    return {
      flow: 'device', url: null, userCode: null,
      instructions: ['Cline 返回的设备码响应格式异常，可改用「粘贴凭据」'],
      _startError: 'Cline 设备码响应缺少必要字段',
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
      '设备码约 10 分钟内有效',
    ],
    _deviceCode: auth.deviceCode,
    _expiresAtMs: Date.now() + auth.expiresInSec * 1000,
    _intervalMs: auth.intervalSec * 1000,
  }
}

/**
 * poll：WorkOS 设备码轮询。
 * authorization_pending ⇒ waiting；slow_down ⇒ 退避；其余错误码 ⇒ 终态。
 */
export async function pollCline(session, opts = {}) {
  const fetcher = opts.fetchImpl ?? globalThis.fetch
  if (!session._deviceCode) return { state: 'error', error: '登录会话缺少设备码，请重新发起' }
  if (session._expiresAtMs && Date.now() > session._expiresAtMs) {
    return { state: 'error', error: '设备码已过期，请重新发起登录' }
  }
  let res
  try {
    res = await fetcher(`${CLINE_WORKOS_BASE}${CLINE_DEVICE_AUTHENTICATE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: session._deviceCode,
        client_id: CLINE_WORKOS_CLIENT_ID,
      }).toString(),
      signal: AbortSignal.timeout(CLINE_HTTP_TIMEOUT_MS),
    })
  } catch {
    session._failures = (session._failures ?? 0) + 1
    if (session._failures > CLINE_POLL_MAX_FAILURES) {
      return { state: 'error', error: '无法连接 Cline 登录服务（连续多次失败）' }
    }
    return { state: 'waiting', hint: '网络抖动，继续等待…' }
  }
  session._failures = 0
  let payload = null
  try { payload = await res.json() } catch { payload = null }

  if (res.ok) {
    const accessToken = typeof payload?.access_token === 'string' ? payload.access_token : ''
    const refreshToken = typeof payload?.refresh_token === 'string' ? payload.refresh_token : ''
    if (accessToken && refreshToken) {
      // 优先换 Cline 自己的 token；失败则退回 WorkOS token（诚实标注）
      const reg = await registerClineToken(accessToken, refreshToken, fetcher)
      if (reg) {
        return {
          state: 'ok',
          hint: '登录成功',
          credential: { token: reg.accessToken, refreshToken: reg.refreshToken, expiresAt: reg.expiresAt },
        }
      }
      return {
        state: 'ok',
        hint: '登录成功（已用 WorkOS token，未完成 Cline 注册）',
        credential: { token: accessToken, refreshToken, expiresAt: Date.now() + 3600 * 1000 },
      }
    }
    return { state: 'waiting', hint: '授权成功但缺少必要字段，继续等待…' }
  }

  const code = typeof payload?.error === 'string' ? payload.error : ''
  if (code === 'authorization_pending') {
    return { state: 'waiting', hint: '已打开授权页，等待你完成授权…' }
  }
  if (code === 'slow_down') {
    session._intervalMs = Math.min((session._intervalMs ?? 5000) + 1000, 15000)
    return { state: 'waiting', hint: '服务端要求降速，继续等待…' }
  }
  if (code === 'access_denied' || code === 'expired_token' || code === 'invalid_grant') {
    const detail = typeof payload?.error_description === 'string' ? payload.error_description : code
    return { state: 'error', error: `授权失败：${detail}` }
  }
  return { state: 'waiting', hint: `上游返回 HTTP ${res.status}，继续等待…` }
}

/** 用 WorkOS token 换 Cline token（失败返回 null，不抛） */
async function registerClineToken(accessToken, refreshToken, fetcher) {
  try {
    const res = await fetcher(`${CLINE_API_BASE}${CLINE_REGISTER_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ accessToken, refreshToken }),
      signal: AbortSignal.timeout(CLINE_HTTP_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const payload = await res.json().catch(() => null)
    return parseClineTokenPayload(payload)
  } catch {
    return null
  }
}
