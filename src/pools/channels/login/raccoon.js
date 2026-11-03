/**
 * cs-myfree — Raccoon（商汤小浣熊）扫码登录（真实实现）
 *
 * 协议来源：对拍 dsh-codearts-auth@1.10.261021 `lib/raccoon-oauth.js` + `raccoon.js`。
 *
 * ## 链路（**不需要验证码**，比短信路径简单）
 *
 * ```
 * ① 生成 qrcode_code（32 位小写 hex = 16 字节随机）
 * ② 二维码内容 = {base}/login/mp?code=<code>&appname=商汤小浣熊官网
 *    这是公开页面，手机扫码后在微信内完成授权
 * ③ 轮询 POST {base}/api/web/auth/v1/login_with_qrcode_code {qrcode_code}
 *    → { code:0, data:{ status, access_token?, refresh_token?, expired_at? } }
 *    status: pending / logging / canceled / success
 * ④ success 且有 access_token ⇒ 完成
 * ```
 *
 * ⚠️ **任何异常都降级为 pending**（参考包明确记录）：轮询 2 秒一次，
 *    偶发网络失败不该中断流程；误判 success 会拿到空 token 卡死，
 *    误判 canceled 会把用户正在扫的码刷新掉。
 *
 * ⚠️ 缺 access_token 的 success **视为未完成**（否则产出空凭据）。
 *
 * @module cs-myfree/pools/channels/login/raccoon
 */

import { randomBytes } from 'node:crypto'

export const RACCOON_API_BASE = 'https://xiaohuanxiong.com'
export const RACCOON_AUTH_PREFIX = '/api/web/auth/v1'
export const RACCOON_REQUEST_TIMEOUT_MS = 60_000
export const RACCOON_QR_POLL_INTERVAL_MS = 2_000
export const RACCOON_QR_APPNAME = '商汤小浣熊官网'

export const RACCOON_QR_STATUS = Object.freeze({
  pending: 'pending',
  logging: 'logging',
  canceled: 'canceled',
  success: 'success',
})

/** 生成扫码用的 code（16 字节随机 → 32 位小写 hex） */
export function generateQrCode() {
  return randomBytes(16).toString('hex')
}

/** 二维码内容（公开微信登录页） */
export function buildQrImageUrl(code) {
  const params = new URLSearchParams({ code, appname: RACCOON_QR_APPNAME })
  return `${RACCOON_API_BASE}/login/mp?${params.toString()}`
}

/** 从 JWT 读 exp（毫秒）；解析失败返回 undefined（不当作已过期） */
export function raccoonJwtExpMs(token) {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined
  } catch { return undefined }
}

/** 解析信封 { code, data, msg } */
export function parseRaccoonEnvelope(payload) {
  if (!payload || typeof payload !== 'object') return null
  const code = Number(payload.code)
  const data = payload.data && typeof payload.data === 'object' ? payload.data : undefined
  return { code: Number.isFinite(code) ? code : -1, data, msg: String(payload.msg ?? payload.message ?? '') }
}

/** start：生成 qr code，返回二维码内容（同步，无需网络） */
export function startRaccoon(provider, ch, opts = {}) {
  const code = generateQrCode()
  return {
    flow: 'qr',
    qr: buildQrImageUrl(code),
    shortLink: buildQrImageUrl(code),
    interval: 2,
    instructions: [
      '用手机**微信**扫下方二维码',
      '扫码后在微信里点「允许」完成授权',
      '授权完成后本页会自动完成登录（约 2~5 秒）',
      '二维码 5 分钟内有效；过期请点「重试」',
    ],
    _qrcodeCode: code,
  }
}

/**
 * poll：轮询扫码状态。
 * 任何异常/畸形/未知状态 ⇒ pending（不中断）。
 */
export async function pollRaccoon(session, opts = {}) {
  const fetcher = opts.fetchImpl ?? globalThis.fetch
  if (!session._qrcodeCode) return { state: 'error', error: '登录会话缺少二维码，请重新发起' }
  session._attempts = (session._attempts ?? 0) + 1
  if (session._attempts > 150) return { state: 'error', error: '登录超时（约 5 分钟），请重新扫码' }

  let envelope = null
  try {
    const res = await fetcher(`${RACCOON_API_BASE}${RACCOON_AUTH_PREFIX}/login_with_qrcode_code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ qrcode_code: session._qrcodeCode }),
      signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS),
    })
    if (res.ok) {
      let payload = null
      try { payload = await res.json() } catch { payload = null }
      envelope = parseRaccoonEnvelope(payload)
    }
  } catch { /* 网络抖动 ⇒ pending */ }

  if (!envelope || envelope.code !== 0 || !envelope.data) {
    return { state: 'waiting', hint: '等待用手机微信扫码…' }
  }

  const status = String(envelope.data.status ?? '')
  if (status === RACCOON_QR_STATUS.canceled) {
    return { state: 'error', error: '你已在手机上取消授权，请重新扫码' }
  }
  if (status === RACCOON_QR_STATUS.logging) {
    return { state: 'waiting', hint: '已扫码，请在手机上确认授权…' }
  }
  if (status === RACCOON_QR_STATUS.success) {
    const accessToken = String(envelope.data.access_token ?? '')
    const refreshToken = String(envelope.data.refresh_token ?? '')
    // 缺 token 的 success 视为未完成（否则产出空凭据卡死）
    if (!accessToken) return { state: 'waiting', hint: '授权已完成，正在获取凭据…' }
    return {
      state: 'ok',
      hint: '登录成功',
      credential: {
        token: accessToken,
        refreshToken: refreshToken || undefined,
        expiresAt: raccoonJwtExpMs(accessToken),
        refreshSource: 'raccoon',
      },
    }
  }
  return { state: 'waiting', hint: '等待用手机微信扫码…' }
}