/**
 * cs-myfree — OfficeAce（华为 ModelArts MaaS）登录测试
 * 全 mock，不联网。DPoP 用真实 crypto 生成并校验结构。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  startOfficeAce, pollOfficeAce, generateDpopKeyPair, generateDpopJwt,
  createOfficeAcePkce, OFFICEACE_CLAW_BASE, OFFICEACE_TOKEN_URL,
  OFFICEACE_CLIENT_ID, OFFICEACE_REDIRECT_URI, OFFICEACE_LOGIN_PAGE,
} from '../src/pools/channels/login/officeace.js'
import { getFlow, FLOW_TYPE } from '../src/pools/channels/login/flow-map.js'

test('PKCE：challenge=SHA-256(base64url)，verifier 合法', () => {
  const p = createOfficeAcePkce()
  assert.ok(p.verifier.length >= 43)
  assert.equal(p.challenge.includes('='), false)
  assert.equal(p.challenge.includes('+'), false)
})

test('DPoP：ES256 JWS 结构合法（header/payload/raw 64 字节签名）', () => {
  const kp = generateDpopKeyPair()
  const jwt = generateDpopJwt(kp.privateJwk, kp.publicJwk, 'POST', OFFICEACE_TOKEN_URL)
  const parts = jwt.split('.')
  assert.equal(parts.length, 3, 'JWS 必须是三段')
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
  assert.equal(header.typ, 'dpop+jwt')
  assert.equal(header.alg, 'ES256')
  assert.equal(header.jwk.kty, 'EC')
  assert.equal(header.jwk.crv, 'P-256')
  assert.ok(header.jwk.x && header.jwk.y)
  assert.equal(header.jwk.d, undefined, '公钥 JWK 绝不能含私钥 d')
  assert.equal(payload.htm, 'POST')
  assert.equal(payload.htu, OFFICEACE_TOKEN_URL)
  assert.equal(typeof payload.iat, 'number')
  assert.ok(payload.jti)
  // JOSE 要求 raw r||s = 64 字节（不是 DER）
  assert.equal(Buffer.from(parts[2], 'base64url').length, 64)
})

test('DPoP：每次 jti 不同（防重放）', () => {
  const kp = generateDpopKeyPair()
  const a = JSON.parse(Buffer.from(generateDpopJwt(kp.privateJwk, kp.publicJwk, 'POST', OFFICEACE_TOKEN_URL).split('.')[1], 'base64url').toString())
  const b = JSON.parse(Buffer.from(generateDpopJwt(kp.privateJwk, kp.publicJwk, 'POST', OFFICEACE_TOKEN_URL).split('.')[1], 'base64url').toString())
  assert.notEqual(a.jti, b.jti)
})

test('startOfficeAce：登记云侧 state 并生成华为授权页', async () => {
  let stateUrl = ''
  const r = await startOfficeAce('officeace', {}, {
    fetchImpl: async (u) => { stateUrl = u; return { ok: true, status: 200, json: async () => ({ state: 'S123' }) } },
  })
  assert.equal(stateUrl, `${OFFICEACE_CLAW_BASE}/v1/claw/auth/state`)
  assert.equal(r.flow, 'browser')
  assert.ok(r.url.startsWith(OFFICEACE_LOGIN_PAGE), '必须走华为 authui 登录页')
  const decoded = decodeURIComponent(r.url)
  assert.ok(decoded.includes(OFFICEACE_CLIENT_ID))
  assert.ok(decoded.includes(encodeURIComponent(OFFICEACE_REDIRECT_URI)) || decoded.includes(OFFICEACE_REDIRECT_URI),
    'redirect_uri 必须是云侧回调（不是 127.0.0.1）')
  assert.equal(decoded.includes('127.0.0.1'), false, '绝不能出现回环地址')
  assert.ok(decoded.includes('code_challenge_method=SHA-256'), 'officeace 用 SHA-256 字面量')
  assert.ok(decoded.includes('state=S123'))
  assert.equal(r.pollingOnly, true)
  assert.ok(r._dpopPrivateJwk && r._dpopPublicJwk && r._codeVerifier)
})

test('startOfficeAce：网络失败 / HTTP 错误 / 无 state 均诚实降级', async () => {
  const a = await startOfficeAce('officeace', {}, { fetchImpl: async () => { throw new Error('ENOTFOUND') } })
  assert.equal(a.url, null)
  assert.ok(a._startError.includes('无法连接'))

  const b = await startOfficeAce('officeace', {}, { fetchImpl: async () => ({ ok: false, status: 500 }) })
  assert.equal(b.url, null)
  assert.match(b._startError, /500/)

  const c = await startOfficeAce('officeace', {}, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) })
  assert.equal(c.url, null)
  assert.match(c._startError, /未返回 state/)
})

test('pollOfficeAce：无 code ⇒ waiting', async () => {
  const s = { _state: 'S', _codeVerifier: 'v', _dpopPrivateJwk: generateDpopKeyPair().privateJwk, _dpopPublicJwk: {} }
  s._dpopPublicJwk = generateDpopKeyPair().publicJwk
  const r = await pollOfficeAce(s, { fetchImpl: async () => ({ ok: false, status: 202 }) })
  assert.equal(r.state, 'waiting')
})

test('pollOfficeAce：拿到 code ⇒ 走 STS 交换，成功返回 AK/SK/ST', async () => {
  const kp = generateDpopKeyPair()
  const s = { _state: 'S', _codeVerifier: 'v', _dpopPrivateJwk: kp.privateJwk, _dpopPublicJwk: kp.publicJwk }
  let tokenBody = ''
  let dpopHeader = ''
  const r = await pollOfficeAce(s, {
    fetchImpl: async (u, init) => {
      if (u.includes('/v1/claw/auth/code')) {
        return { ok: true, status: 200, json: async () => ({ code: 'CODE1' }) }
      }
      tokenBody = String(init.body)
      dpopHeader = init.headers.DPoP
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          credentials: { access_key_id: 'AK1', secret_access_key: 'SK1', security_token: 'ST1', expiration: '2026-11-05T00:00:00Z' },
          refresh_token: 'RT1',
        }),
      }
    },
  })
  assert.equal(r.state, 'ok')
  assert.equal(r.credential.ak, 'AK1')
  assert.equal(r.credential.sk, 'SK1')
  assert.equal(r.credential.securityToken, 'ST1')
  assert.equal(r.credential.refreshToken, 'RT1')
  assert.equal(typeof r.credential.expiresAt, 'number')
  assert.ok(dpopHeader && dpopHeader.split('.').length === 3, '必须带 DPoP JWS')
  assert.ok(tokenBody.includes('grant_type=authorization_code'))
  assert.ok(tokenBody.includes('code=CODE1'))
  assert.ok(tokenBody.includes('code_verifier=v'))
})

test('pollOfficeAce：STS 失败 ⇒ 可读错误（不吞）', async () => {
  const kp = generateDpopKeyPair()
  const s = { _state: 'S', _codeVerifier: 'v', _dpopPrivateJwk: kp.privateJwk, _dpopPublicJwk: kp.publicJwk, _code: 'C' }
  const r = await pollOfficeAce(s, {
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'bad' }),
  })
  assert.equal(r.state, 'error')
  assert.match(r.error, /401/)
})

test('pollOfficeAce：缺凭据字段 ⇒ error', async () => {
  const kp = generateDpopKeyPair()
  const s = { _state: 'S', _codeVerifier: 'v', _dpopPrivateJwk: kp.privateJwk, _dpopPublicJwk: kp.publicJwk, _code: 'C' }
  const r = await pollOfficeAce(s, {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ credentials: {} }) }),
  })
  assert.equal(r.state, 'error')
  assert.match(r.error, /缺少凭据/)
})

test('pollOfficeAce：缺 state / 超时', async () => {
  assert.equal((await pollOfficeAce({}, { fetchImpl: async () => ({}) })).state, 'error')
  const s = { _state: 'S', _attempts: 500 }
  assert.equal((await pollOfficeAce(s, { fetchImpl: async () => ({ ok: false, status: 202 }) })).state, 'error')
})

test('flow-map：officeace 走真实现', () => {
  const f = getFlow('officeace', null)
  assert.equal(f.type, FLOW_TYPE.BROWSER)
  assert.equal(typeof f.start, 'function')
  assert.equal(typeof f.poll, 'function')
})
