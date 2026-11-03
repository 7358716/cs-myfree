/**
 * cs-myfree — 统一登录状态机（18 家渠道共用）
 *
 * 五类登录流（映射见 flow-map.js）：
 *   - browser: 浏览器授权回调（redirect 到宿主公网地址，见下）
 *   - device:  设备码 + 轮询（qoder/qodercn/cline/minimax/minimaxintl/zcode）
 *   - qr:      显示二维码 + 轮询扫码（loomy/raccoon）
 *   - paste:   官方只给 API Key（qiniu/opencode）
 *   - aksk:    AK/SK 一步（codearts 已真机验证）
 *
 * 🔴 云服务器部署的硬约束（这是「点去官网拿不到授权」的根因）：
 *    插件跑在服务器上，用户浏览器在另一台机器。把 redirect_uri 写成
 *    `http://127.0.0.1:<port>/...` 时，浏览器授权后会跳到**用户自己的机器**，
 *    服务器上的插件永远收不到。
 *    ⇒ browser 流一律走宿主公网回调：`<publicBase>/cs-myfree/login/callback?state=…`
 *      state 是一次性随机串，落内存 5 分钟，回调时消费掉（防重放）。
 *    ⇒ 拿不到 publicBase 时（纯本机使用）才退回 127.0.0.1 临时服务器。
 *
 * 会话在内存，不落盘。凭据落 ~/.dsh/cs-myfree/accounts.json（0600）。
 * UI 只回掩码，日志脱敏。
 *
 * @module cs-myfree/pools/channels/login
 */

import { randomUUID, randomBytes } from 'node:crypto'
import { getFlow } from './flow-map.js'

/** sessionId -> session；state -> sessionId（回调一次性令牌） */
const sessions = new Map()
const states = new Map()

const SESSION_TTL_MS = 5 * 60 * 1000

export function startLogin(provider, ch, opts = {}) {
  const flow = getFlow(provider, ch)
  const sessionId = randomUUID()
  const expiresAt = Date.now() + SESSION_TTL_MS

  // 🔴 回调地址必须在**调用 initial 之前**算好：登录器要用它拼授权 URL
  const oauthState = randomBytes(24).toString('hex')
  const base = String(opts.publicBase ?? '').replace(/\/+$/, '')
  const cbPath = opts.callbackPath ?? '/cs-myfree/login/callback'
  const callbackUrl = base ? `${base}${cbPath}` : `http://127.0.0.1:${opts.port ?? 0}${cbPath}`
  const callbackWithState = `${callbackUrl}?state=${oauthState}`
  if (base) states.set(oauthState, { sessionId, expiresAt })

  const initial = flow.initial(provider, ch, { ...opts, callbackUrl: callbackWithState, publicBase: base, callbackPath: cbPath }) || {}

  const session = {
    sessionId,
    provider,
    flow: flow.type,
    state: 'pending',
    startedAt: Date.now(),
    expiresAt,
    ...initial,
  }

  // 浏览器回调流：登记一次性 state（防重放 + 防伪造回调）
  if (session.flow === 'browser') {
    session.oauthState = oauthState
    session.callbackUrl = callbackUrl
    if (!base) states.set(oauthState, { sessionId, expiresAt })
  }

  sessions.set(sessionId, session)
  return {
    sessionId,
    state: session.oauthState ?? null,
    callbackUrl: session.callbackUrl ?? null,
    flow: session.flow,
    url: session.url ?? null,
    qr: session.qr ?? null,
    shortLink: session.shortLink ?? null,
    userCode: session.userCode ?? null,
    verificationUri: session.verificationUri ?? null,
    interval: session.interval ?? 5,
    instructions: session.instructions ?? [],
    expiresAt,
  }
}

export function getSession(sessionId) {
  const s = sessions.get(sessionId)
  if (!s) return null
  if (Date.now() > s.expiresAt && s.state === 'pending') s.state = 'expired'
  return s
}

/**
 * 浏览器 OAuth 回调入口（由 /login/callback 路由调用）。
 * 消费一次性 state，把 code 交给会话，之后由 poll 完成 token 交换。
 */
export function handleCallback({ state, code }) {
  const sid = states.get(String(state ?? ''))
  if (!sid) return { ok: false, error: '登录会话已过期或无效，请回设置页重新发起' }
  if (Date.now() > sid.expiresAt) { states.delete(String(state)); return { ok: false, error: '登录会话已过期' } }
  states.delete(String(state)) // 一次性
  const s = sessions.get(sid.sessionId)
  if (!s) return { ok: false, error: '登录会话不存在' }
  if (!code) { s.state = 'error'; s.error = '厂商未返回授权码'; return { ok: false, error: s.error } }
  s.callbackCode = String(code)
  s.state = 'waiting'
  s.hint = '已收到授权，正在换取凭证…'
  return { ok: true }
}

export async function pollLogin(sessionId, opts = {}) {
  const s = getSession(sessionId)
  if (!s) return { state: 'error', hint: '会话不存在或已过期' }
  if (s.state === 'ok' || s.state === 'error' || s.state === 'expired' || s.state === 'cancelled') {
    return { state: s.state, hint: s.hint ?? '', maskedAccount: s.maskedAccount ?? null, error: s.error ?? null }
  }
  const flow = getFlow(s.provider, null, s.flow)
  if (typeof flow.poll === 'function') {
    let r = null
    try { r = await flow.poll(s, opts) } catch (err) {
      s.state = 'error'
      s.error = String(err?.message ?? err).slice(0, 200)
      return { state: s.state, hint: '', maskedAccount: null, error: s.error }
    }
    if (r) {
      s.state = r.state ?? s.state
      if (r.hint !== undefined) s.hint = r.hint
      if (r.maskedAccount) s.maskedAccount = r.maskedAccount
      if (r.error) s.error = r.error
      if (r.credential) s.credential = r.credential
      if (r.accountId) s.accountId = r.accountId
    }
  }
  return { state: s.state, hint: s.hint ?? '', maskedAccount: s.maskedAccount ?? null, error: s.error ?? null }
}

export function cancelLogin(sessionId) {
  const s = sessions.get(sessionId)
  if (!s) return false
  s.state = 'cancelled'
  if (s.oauthState) states.delete(s.oauthState)
  sessions.delete(sessionId)
  return true
}

export function cleanupExpired(nowMs = Date.now()) {
  for (const [id, s] of sessions) if (nowMs > s.expiresAt + 60_000) sessions.delete(id)
  for (const [st, v] of states) if (nowMs > v.expiresAt + 60_000) states.delete(st)
}

// 每 5 分钟清理过期会话（unref：不拖住宿主退出）
const timer = setInterval(() => cleanupExpired(), 5 * 60 * 1000)
if (typeof timer.unref === 'function') timer.unref()

export { sessions, states }
