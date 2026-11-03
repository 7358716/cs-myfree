/**
 * cs-myfree — Accio（阿里）浏览器一键登录（真实实现）
 *
 * 协议来源：对拍 dsh-codearts-auth@1.10.261021 `lib/accio-oauth.js` + `accio-product.js`。
 *
 * 流程（OAuth 授权码 + PKCE S256）：
 *   ① 生成 PKCE（verifier 48 字节 base64url，challenge=S256）+ state（32 字节 hex）
 *   ② 打开授权页 `{loginBase}/login?return_url=<回调>&state&code_challenge&code_challenge_method=S256&client_id=accio-work&ttid&language=zh`
 *      ⚠️ 缺 `code_challenge` 会被登录页判为 legacy 客户端，弹「请升级客户端」且回调永不到达
 *   ③ 回调带 `code` → `POST {gateway}/api/oauth/token`
 *      body `{code, codeVerifier, clientId:'accio-work', redirectUri}`（**没有 client_secret**）
 *   ④ 响应含 accessToken / refreshToken / expiresAt（三者缺一不可）
 *
 * 站点：cn → www.accio-ai.com；global → zh.accio.com（只有登录页分区域，gateway 同一个）
 *
 * @module cs-myfree/pools/channels/login/accio
 */

import { createHash, randomBytes } from 'node:crypto'

export const ACCIO_GATEWAY_BASE = 'https://phoenix-gw.alibaba.com'
export const ACCIO_LOGIN_CN = 'https://www.accio-ai.com'
export const ACCIO_LOGIN_GLOBAL = 'https://zh.accio.com'
export const ACCIO_TOKEN_EXCHANGE_PATH = '/api/oauth/token'
export const ACCIO_REFRESH_PATH = '/api/auth/refresh_token'
export const ACCIO_CLIENT_ID = 'accio-work'
export const ACCIO_REQUEST_TIMEOUT_MS = 30_000

/** 生成 PKCE（verifier 48 字节 base64url，challenge=S256） */
export function createAccioPkcePair() {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** state（32 随机字节 hex） */
export function createAccioState() {
  return randomBytes(32).toString('hex')
}

/** 拼授权 URL（参数缺一不可） */
export function buildAccioAuthUrl({ redirectUri, state, codeChallenge, region = 'cn' }) {
  const base = region === 'global' ? ACCIO_LOGIN_GLOBAL : ACCIO_LOGIN_CN
  const params = new URLSearchParams({
    return_url: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    client_id: ACCIO_CLIENT_ID,
    ttid: `ttid_${randomBytes(16).toString('hex')}`,
    language: 'zh',
  })
  return `${base}/login?${params.toString()}`
}

/** 解析 token 响应（三者缺一不可） */
export function parseAccioTokenResponse(payload) {
  if (!payload || typeof payload !== 'object') return null
  const d = payload.data && typeof payload.data === 'object' ? payload.data : payload
  const access = typeof d.accessToken === 'string' ? d.accessToken
    : typeof d.access_token === 'string' ? d.access_token : ''
  const refresh = typeof d.refreshToken === 'string' ? d.refreshToken
    : typeof d.refresh_token === 'string' ? d.refresh_token : ''
  const expiresAt = Number.isFinite(d.expiresAt) ? d.expiresAt
    : (Number.isFinite(d.expires_at) ? d.expires_at : undefined)
  if (!access || !refresh || !expiresAt) return null
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: expiresAt > 1e12 ? expiresAt : expiresAt * 1000,
    sgcookie: typeof d.sgcookie === 'string' ? d.sgcookie : undefined,
  }
}

/** start：生成授权 URL（同步） */
export function startAccio(provider, ch, opts = {}) {
  const region = provider === 'accio' ? 'cn' : 'cn'
  const pkce = createAccioPkcePair()
  const state = createAccioState()
  const callbackUrl = opts.callbackUrl
    ?? `${String(opts.publicBase ?? '').replace(/\/+$/, '')}${opts.callbackPath ?? '/cs-myfree/login/callback'}`
  // 回调会原样带回 state；把 state 附加到回调地址上
  const redirectUri = callbackUrl.includes('?') ? `${callbackUrl}&accio_state=${state}` : `${callbackUrl}?accio_state=${state}`
  return {
    flow: 'browser',
    url: buildAccioAuthUrl({ redirectUri, state, codeChallenge: pkce.challenge, region }),
    interval: 2,
    instructions: [
      '点「打开登录页」，用 Accio 账号登录并授权',
      '授权完成后浏览器会自动跳回，本页几秒内自动完成',
      '若提示「请升级客户端」，是 PKCE 参数缺失（本插件已带齐）',
    ],
    _pkceVerifier: pkce.verifier,
    _state: state,
    _redirectUri: redirectUri,
    _region: region,
  }
}

/** poll：等回调 code → 换 token */
export async function pollAccio(session, opts = {}) {
  const fetcher = opts.fetchImpl ?? globalThis.fetch
  session._attempts = (session._attempts ?? 0) + 1
  if (session._attempts > 200) return { state: 'error', error: '登录超时（约 5 分钟），请重试' }

  const params = session.callbackParams ?? {}
  const code = String(params.code ?? params.authorization_code ?? session.callbackCode ?? '')
  if (!code) {
    return { state: 'waiting', hint: '已打开登录页，等待你在浏览器完成授权…' }
  }

  try {
    const res = await fetcher(`${ACCIO_GATEWAY_BASE}${ACCIO_TOKEN_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        code,
        codeVerifier: session._pkceVerifier,
        clientId: ACCIO_CLIENT_ID,
        redirectUri: session._redirectUri,
      }),
      signal: AbortSignal.timeout(ACCIO_REQUEST_TIMEOUT_MS),
    })
    const text = await res.text().catch(() => '')
    if (!res.ok) return { state: 'error', error: `Accio token 交换失败（HTTP ${res.status}）` }
    let payload = null
    try { payload = JSON.parse(text) } catch { payload = null }
    const parsed = parseAccioTokenResponse(payload)
    if (!parsed) return { state: 'error', error: 'Accio token 响应缺少 accessToken/refreshToken/expiresAt' }
    return {
      state: 'ok',
      hint: '登录成功',
      credential: {
        token: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: parsed.expiresAt,
        refreshSource: 'accio',
      },
    }
  } catch (err) {
    return { state: 'error', error: `Accio token 交换异常：${String(err?.message ?? err).slice(0, 120)}` }
  }
}

/** 续期（refreshToken 会轮换，调用方必须串行） */
export async function refreshAccio(session, opts = {}) {
  const fetcher = opts.fetchImpl ?? globalThis.fetch
  const res = await fetcher(`${ACCIO_GATEWAY_BASE}${ACCIO_REFRESH_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ accessToken: session.accessToken, refreshToken: session.refreshToken }),
    signal: AbortSignal.timeout(ACCIO_REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
  const payload = await res.json().catch(() => null)
  const parsed = parseAccioTokenResponse(payload)
  return parsed ? { ok: true, credential: { token: parsed.accessToken, refreshToken: parsed.refreshToken, expiresAt: parsed.expiresAt } } : { ok: false, error: '响应缺字段' }
}
