/**
 * cs-myfree — CodeArts（华为云）浏览器一键登录（真实实现）
 *
 * 协议来源：对拍 dsh-codearts-auth@1.10.261021 `lib/login.js`（本机真实运行的那份）。
 *
 * 流程（**不是标准 OAuth 授权码**，是华为的 ticket 兑换）：
 *   ① 生成 32 字节随机 secret（64 位小写 hex）
 *   ② 拼登录页 URL：
 *        auth.huaweicloud.com/authui/login.html?service=<doer/redirect?...&auth_callback_url=<回调>&ticket_id=<id>…>
 *   ③ 用户在浏览器登录华为云 → 华为把浏览器**重定向到 auth_callback_url**
 *      （回调只需被访问到，凭据不从这里来）
 *   ④ 插件在后台轮询 snap-manager ticket 端点：
 *        GET https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket?ticket_id=<id>&secret=<secret>
 *      直到返回 credential（1s 间隔，最多 120 次）
 *   ⑤ credential → {access_key_id, secret_access_key, security_token, expiration}
 *
 * 🔴 云服务器关键改动：
 *   参考实现把 auth_callback_url 写死成 `http://127.0.0.1:<port>/authentication`，
 *   在本机（插件与浏览器同机）成立；但我们是**服务器 + 远程浏览器**，
 *   127.0.0.1 会跳到用户自己的机器 ⇒ 插件收不到。
 *   故 auth_callback_url 必须用**宿主公网地址**（由状态机注入 callbackUrl）。
 *
 * @module cs-myfree/pools/channels/login/codearts
 */

import { randomBytes } from 'node:crypto'

export const CODEARTS_LOGIN_BASE = 'https://devcloud.cn-north-4.huaweicloud.com/doer/redirect'
export const HUAWEI_AUTH_BASE = 'https://auth.huaweicloud.com/authui/login.html'
export const CODEARTS_TICKET_ENDPOINT = 'https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket'
const PLUGIN_NAME = 'snap_jetbrains'
const PLUGIN_VERSION = '26.3.3'
const POLL_INTERVAL_MS = 1000
const POLL_MAX_ATTEMPTS = 120

export function generateRandomSecret() {
  return randomBytes(32).toString('hex')
}

/**
 * 拼登录 URL。
 * @param {string} callbackUrl 浏览器登录后被重定向到的地址（必须是浏览器可达的公网地址）
 * @param {string} ticketId
 */
export function buildLoginUrl(callbackUrl, ticketId) {
  const redirectUrl = `${CODEARTS_LOGIN_BASE}?IdeaType=jetbrains`
    + `&auth_callback_url=${encodeURIComponent(callbackUrl)}`
    + `&plugin-name=${PLUGIN_NAME}`
    + `&plugin-version=${PLUGIN_VERSION}`
    + `&ticket_id=${encodeURIComponent(ticketId)}`
  return `${HUAWEI_AUTH_BASE}?service=${encodeURIComponent(redirectUrl)}`
}

/** ticket 响应 → 结构化凭据（未完成时返回 null） */
export function parseCredentialResponse(data) {
  if (!data || typeof data !== 'object') return null
  if (data.credential) {
    const access = String(data.credential.access ?? '')
    const st = String(data.credential.securitytoken ?? data.credential.securityToken ?? '')
    if (access && st) {
      return {
        ak: access,
        sk: String(data.credential.secret ?? ''),
        securityToken: st,
        expiresAt: parseExpiry(data.credential.expires_at ?? data.credential.expiresAt),
      }
    }
  }
  if (data.result) {
    const ak = String(data.result.accessKeyId ?? '')
    const st = String(data.result.securityToken ?? '')
    if (ak && st) {
      return {
        ak,
        sk: String(data.result.secretAccessKey ?? ''),
        securityToken: st,
        expiresAt: parseExpiry(data.result.expiration ?? data.result.expiresAt),
      }
    }
  }
  return null
}

function parseExpiry(v) {
  if (v === undefined || v === null || v === '') return null
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  const t = Date.parse(String(v))
  return Number.isNaN(t) ? null : t
}

/**
 * start：生成 secret + ticketId，返回登录 URL 与会话私有字段。
 * 状态机会把 callbackUrl 传进来（公网地址）。
 */
export function startCodearts(provider, ch, opts = {}) {
  const secret = generateRandomSecret()
  const ticketId = randomBytes(16).toString('hex')
  const callbackUrl = opts.callbackUrl
    ?? `${String(opts.publicBase ?? '').replace(/\/+$/, '')}${opts.callbackPath ?? '/cs-myfree/login/callback'}`
  return {
    flow: 'browser',
    url: buildLoginUrl(callbackUrl, ticketId),
    instructions: [
      '点「打开登录页」，用你的华为云账号登录并授权',
      '授权完成后浏览器会自动跳回，本页几秒内自动完成登录',
      '若浏览器提示无法访问，把地址栏整条链接复制回来粘贴也可以',
    ],
    _secret: secret,
    _ticketId: ticketId,
    _callbackUrl: callbackUrl,
    interval: 2,
  }
}

/**
 * poll：轮询 ticket 端点拿凭据。
 * 回调本身只表示「用户可能已完成」；真正的凭据来自轮询。
 */
export async function pollCodearts(session, opts = {}) {
  if (!session._ticketId || !session._secret) return { state: 'error', error: '登录会话缺少 ticket 参数' }
  const fetcher = opts.fetchImpl ?? globalThis.fetch
  session._attempts = (session._attempts ?? 0) + 1
  if (session._attempts > POLL_MAX_ATTEMPTS) {
    return { state: 'error', error: '登录超时（2 分钟未完成授权），请重试' }
  }
  const url = `${CODEARTS_TICKET_ENDPOINT}?ticket_id=${encodeURIComponent(session._ticketId)}&secret=${encodeURIComponent(session._secret)}`
  try {
    const res = await fetcher(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'plugin-name': PLUGIN_NAME,
        'plugin-version': PLUGIN_VERSION,
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) {
      let data = null
      try { data = await res.json() } catch { data = null }
      const cred = parseCredentialResponse(data)
      if (cred) {
        return {
          state: 'ok',
          hint: '登录成功',
          credential: { ak: cred.ak, sk: cred.sk, securityToken: cred.securityToken, expiresAt: cred.expiresAt },
        }
      }
    }
    // 未完成 / 瞬时失败 ⇒ 继续等（不要当错误，否则用户刚点完就被判失败）
    return { state: 'waiting', hint: session.callbackCode ? '已收到回调，正在换取凭证…' : '等待你在浏览器完成登录…' }
  } catch {
    return { state: 'waiting', hint: '网络抖动，继续等待…' }
  }
}
