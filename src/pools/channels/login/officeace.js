/**
 * cs-myfree — OfficeAce（华为 ModelArts MaaS / 果办）一键登录（真实实现）
 *
 * 协议来源：对拍 dsh-codearts-auth@1.10.261021 `lib/officeace-auth.js`。
 *
 * 流程（云侧 state 登记 + 公网回调 + 轮询 code + STS DPoP 换 token）：
 *   ① POST {CLAW}/v1/claw/auth/state  (body `{}`) → { state }
 *   ② 生成 PKCE（code_challenge_method = **SHA-256**，不是 S256）+ ES256 DPoP 密钥对
 *   ③ 打开授权页：
 *        https://auth.huaweicloud.com/authui/login.html?service=<authui/v1/oauth2/authorize?...>
 *      redirect_uri = `{CLAW}/v1/claw/auth/callback`（**云侧回调，不是 127.0.0.1**）
 *   ④ 轮询 GET {CLAW}/v1/claw/auth/code?state=… → { code }
 *      - 202/404/取不到 code ⇒ 用户还没授权，继续等
 *   ⑤ POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens
 *        form: client_id=pdp5_for_agentarts & code & code_verifier & grant_type=authorization_code
 *              & redirect_uri=<同上>
 *        header: DPoP: <ES256 JWS，htm=POST htu=TOKEN_URL>
 *      → credentials: { access_key_id, secret_access_key, security_token, expiration, project_id }
 *
 * 🔴 与 codearts 的区别：codearts 用 ticket 轮询（无需 DPoP）；officeace 必须 DPoP。
 *
 * @module cs-myfree/pools/channels/login/officeace
 */

import { createHash, randomBytes, createPrivateKey, sign as cryptoSign, generateKeyPairSync } from 'node:crypto'

export const OFFICEACE_CLAW_BASE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com'
export const OFFICEACE_REDIRECT_URI = `${OFFICEACE_CLAW_BASE}/v1/claw/auth/callback`
export const OFFICEACE_AUTHORIZE_BASE = 'https://auth.huaweicloud.com/authui/v1/oauth2/authorize'
export const OFFICEACE_LOGIN_PAGE = 'https://auth.huaweicloud.com/authui/login.html'
export const OFFICEACE_TOKEN_URL = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens'
export const OFFICEACE_CLIENT_ID = 'pdp5_for_agentarts'
export const OFFICEACE_HTTP_TIMEOUT_MS = 20_000

const b64url = (buf) => Buffer.from(buf).toString('base64url')

/** 生成 ES256（P-256）密钥对，返回私有 JWK（含 d）与公有坐标 */
export function generateDpopKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const priv = privateKey.export({ format: 'jwk' })
  const pub = publicKey.export({ format: 'jwk' })
  return { privateJwk: priv, publicJwk: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y } }
}

/** 生成 DPoP JWS（ES256，JOSE 格式签名：raw r||s） */
export function generateDpopJwt(privateJwk, publicJwk, htm, htu, nowMs = Date.now()) {
  const header = {
    typ: 'dpop+jwt',
    alg: 'ES256',
    jwk: { kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y, crv: publicJwk.crv },
  }
  const payload = { htm, htu, iat: Math.floor(nowMs / 1000), jti: randomBytes(16).toString('hex') }
  const input = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`
  const key = createPrivateKey({ key: privateJwk, format: 'jwk' })
  // 🔴 JOSE 要求 raw r||s（IEEE P1363），不是 DER
  const sig = cryptoSign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
  return `${input}.${b64url(sig)}`
}

/** PKCE（officeace 用 SHA-256 作为 challenge_method 字符串） */
export function createOfficeAcePkce() {
  const verifier = b64url(randomBytes(32))
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * start：向云侧登记 state + 生成授权页 URL。
 * @returns 失败时返回诚实降级（不编造 URL）
 */
export async function startOfficeAce(provider, ch, opts = {}) {
  const fetcher = opts.fetchImpl ?? globalThis.fetch
  let state = ''
  try {
    const res = await fetcher(`${OFFICEACE_CLAW_BASE}/v1/claw/auth/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(OFFICEACE_HTTP_TIMEOUT_MS),
    })
    if (!res.ok) {
      return {
        flow: 'browser', url: null,
        instructions: [`华为云 state 注册失败（HTTP ${res.status}）`, '可改用「粘贴凭据」'],
        _startError: `华为云 state 注册失败：HTTP ${res.status}`,
      }
    }
    const j = await res.json().catch(() => null)
    state = typeof j?.state === 'string' ? j.state : ''
  } catch (err) {
    return {
      flow: 'browser', url: null,
      instructions: ['无法连接华为云登录服务（网络问题）', '可改用「粘贴凭据」'],
      _startError: `无法连接华为云：${String(err?.message ?? err).slice(0, 120)}`,
    }
  }
  if (!state) {
    return { flow: 'browser', url: null, instructions: ['华为云未返回 state，请重试'], _startError: '华为云未返回 state' }
  }

  const pkce = createOfficeAcePkce()
  const { privateJwk, publicJwk } = generateDpopKeyPair()
  const params = new URLSearchParams({
    client_id: OFFICEACE_CLIENT_ID,
    code_challenge: pkce.challenge,
    code_challenge_method: 'SHA-256',
    state,
    scope: 'openid',
    redirect_uri: OFFICEACE_REDIRECT_URI,
    response_type: 'code',
  })
  const authorizeUrl = `${OFFICEACE_LOGIN_PAGE}?service=${encodeURIComponent(`${OFFICEACE_AUTHORIZE_BASE}?${params.toString()}`)}`

  return {
    flow: 'browser',
    url: authorizeUrl,
    pollingOnly: true,          // 云侧回调 + 轮询 code，不需要我们的回调地址
    interval: 2,
    instructions: [
      '点「打开登录页」，用华为云账号登录并授权',
      '授权完成后不用复制任何东西，本页会自动检测',
      '本渠道用云侧回调 + 轮询，不需要你手动粘贴',
    ],
    _state: state,
    _codeVerifier: pkce.verifier,
    _dpopPrivateJwk: privateJwk,
    _dpopPublicJwk: publicJwk,
  }
}

/**
 * poll：轮询云侧 code；拿到 code 后立刻做 STS 交换。
 */
export async function pollOfficeAce(session, opts = {}) {
  const fetcher = opts.fetchImpl ?? globalThis.fetch
  if (!session._state) return { state: 'error', error: '登录会话缺少 state，请重新发起' }
  session._attempts = (session._attempts ?? 0) + 1
  if (session._attempts > 200) return { state: 'error', error: '登录超时（约 5 分钟），请重试' }

  // ① 拿 code
  if (!session._code) {
    let res
    try {
      res = await fetcher(`${OFFICEACE_CLAW_BASE}/v1/claw/auth/code?state=${encodeURIComponent(session._state)}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(OFFICEACE_HTTP_TIMEOUT_MS),
      })
    } catch {
      session._failures = (session._failures ?? 0) + 1
      if (session._failures > 5) return { state: 'error', error: '无法连接华为云（连续多次失败）' }
      return { state: 'waiting', hint: '网络抖动，继续等待…' }
    }
    session._failures = 0
    if (!res.ok) return { state: 'waiting', hint: '已打开登录页，等待你在浏览器完成授权…' }
    let j = null
    try { j = await res.json() } catch { j = null }
    const code = typeof j?.code === 'string' ? j.code : (typeof j?.data?.code === 'string' ? j.data.code : '')
    if (!code) return { state: 'waiting', hint: '已打开登录页，等待你完成授权…' }
    session._code = code
  }

  // ② STS 交换（DPoP）
  try {
    const dpop = generateDpopJwt(session._dpopPrivateJwk, session._dpopPublicJwk, 'POST', OFFICEACE_TOKEN_URL)
    const body = new URLSearchParams({
      client_id: OFFICEACE_CLIENT_ID,
      code: session._code,
      code_verifier: session._codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: OFFICEACE_REDIRECT_URI,
    })
    const res = await fetcher(OFFICEACE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', DPoP: dpop },
      body: body.toString(),
      signal: AbortSignal.timeout(OFFICEACE_HTTP_TIMEOUT_MS),
    })
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      return { state: 'error', error: `华为云 token 交换失败（HTTP ${res.status}）` }
    }
    let tok = null
    try { tok = JSON.parse(text) } catch { tok = null }
    const c = tok?.credentials
    if (!c?.access_key_id || !c?.secret_access_key) {
      return { state: 'error', error: '华为云 token 响应缺少凭据字段' }
    }
    const expiresAt = (() => {
      const t = Date.parse(String(c.expiration ?? ''))
      return Number.isNaN(t) ? undefined : t
    })()
    return {
      state: 'ok',
      hint: '登录成功',
      maskedAccount: String(c.access_key_id).slice(0, 4) + '…' + String(c.access_key_id).slice(-4),
      credential: {
        ak: c.access_key_id,
        sk: c.secret_access_key,
        securityToken: c.security_token,
        refreshToken: tok.refresh_token,
        expiresAt,
      },
    }
  } catch (err) {
    return { state: 'error', error: `华为云 token 交换异常：${String(err?.message ?? err).slice(0, 120)}` }
  }
}
