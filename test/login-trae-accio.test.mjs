/**
 * cs-myfree — TRAE / Accio 浏览器一键登录测试
 * 全 mock，不联网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  startTrae, pollTrae, buildTraeLoginUrl, parseTraeExchangeResponse,
  TRAE_PRODUCT, TRAE_EXCHANGE_PATH, TRAE_OAUTH_HOST,
} from '../src/pools/channels/login/trae.js'
import {
  startAccio, pollAccio, buildAccioAuthUrl, parseAccioTokenResponse,
  createAccioPkcePair, ACCIO_GATEWAY_BASE, ACCIO_TOKEN_EXCHANGE_PATH, ACCIO_CLIENT_ID,
} from '../src/pools/channels/login/accio.js'
import { getFlow, FLOW_TYPE } from '../src/pools/channels/login/flow-map.js'

const PUB = 'http://150.158.175.241'
const CB = '/cs-myfree/login/callback'

// ── TRAE ──
test('TRAE：授权 URL 用 auth_callback_url（不是 callback_url/redirect_uri）', () => {
  const { url } = buildTraeLoginUrl(TRAE_PRODUCT, 'M1', 'D1', `${PUB}${CB}`)
  const u = new URL(url)
  assert.equal(u.host, 'www.trae.cn')
  assert.equal(u.pathname, '/authorization')
  assert.equal(u.searchParams.get('auth_callback_url'), `${PUB}${CB}`)
  assert.equal(u.searchParams.get('callback_url'), null, '不能是 callback_url')
  assert.equal(u.searchParams.get('redirect_uri'), null, '不能是 redirect_uri')
  assert.ok(u.searchParams.get('login_trace_id'), '必须带 login_trace_id（回调反查唯一凭据）')
  assert.equal(u.searchParams.get('auth_type'), 'local')
  assert.equal(u.searchParams.get('login_channel'), 'native_ide')
  assert.equal(u.searchParams.get('auth_from'), 'solo')
  assert.equal(u.searchParams.get('client_id'), TRAE_PRODUCT.clientId)
  // 17 参（含 client_id 等）= 至少 17
  assert.ok([...u.searchParams.keys()].length >= 17, '参数至少要 17 个')
  assert.equal(u.searchParams.get('x_device_brand'), 'PC')
})

test('TRAE：startTrae 返回公网回调 + 说明', () => {
  const r = startTrae('trae', {}, { publicBase: PUB, callbackPath: CB })
  assert.equal(r.flow, 'browser')
  assert.ok(r.url.includes('auth.huaweicloud') === false)
  assert.ok(r._machineId && r._deviceId && r._traceId)
  assert.ok(r.instructions.length >= 2)
})

test('TRAE：ExchangeToken 响应解析', () => {
  const a = parseTraeExchangeResponse({ Token: 'AT', RefreshToken: 'RT', TokenExpireAt: 1793700000 })
  assert.equal(a.accessToken, 'AT')
  assert.equal(a.refreshToken, 'RT')
  assert.equal(typeof a.expiresAt, 'number')
  // data 信封
  const b = parseTraeExchangeResponse({ data: { token: 'T2' } })
  assert.equal(b.accessToken, 'T2')
  assert.equal(parseTraeExchangeResponse({}), null)
  assert.equal(parseTraeExchangeResponse(null), null)
})

test('TRAE poll：没回调 ⇒ waiting', async () => {
  const r = await pollTrae({ callbackParams: {} }, {})
  assert.equal(r.state, 'waiting')
})

test('TRAE poll：有 refreshToken ⇒ ExchangeToken 成功', async () => {
  let seenUrl = ''
  let seenBody = ''
  const r = await pollTrae({ callbackParams: { refreshToken: 'RT' }, _attempts: 0 }, {
    fetchImpl: async (u, init) => {
      seenUrl = u; seenBody = String(init.body)
      return { ok: true, status: 200, text: async () => JSON.stringify({ Token: 'AT', RefreshToken: 'RT2', TokenExpireAt: 1793700000 }) }
    },
  })
  assert.equal(seenUrl, `${TRAE_OAUTH_HOST}${TRAE_EXCHANGE_PATH}`)
  assert.ok(seenBody.includes('"RefreshToken":"RT"'))
  assert.ok(seenBody.includes('"ClientSecret":"-"'), 'ClientSecret 必须是占位 "-"')
  assert.equal(r.state, 'ok')
  assert.equal(r.credential.token, 'AT')
  assert.equal(r.credential.refreshToken, 'RT2')
})

test('TRAE poll：ExchangeToken 失败 ⇒ 可读错误', async () => {
  const r = await pollTrae({ callbackParams: { refreshToken: 'RT' } }, {
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'bad' }),
  })
  assert.equal(r.state, 'error')
  assert.match(r.error, /401/)
})

test('TRAE poll：只有 userJwt ⇒ 兜底当 accessToken', async () => {
  const r = await pollTrae({ callbackParams: { userJwt: 'JWT' } }, {})
  assert.equal(r.state, 'ok')
  assert.equal(r.credential.token, 'JWT')
})

test('TRAE poll：超时上限', async () => {
  const r = await pollTrae({ callbackParams: {}, _attempts: 500 }, {})
  assert.equal(r.state, 'error')
  assert.match(r.error, /超时/)
})

// ── Accio ──
test('Accio：PKCE 合法', () => {
  const p = createAccioPkcePair()
  assert.ok(p.verifier.length >= 43)
  assert.equal(p.challenge.includes('='), false)
  assert.notEqual(createAccioPkcePair().verifier, p.verifier)
})

test('Accio：授权 URL 带 return_url + code_challenge（缺了会被判 legacy 客户端）', () => {
  const url = buildAccioAuthUrl({
    redirectUri: `${PUB}${CB}?accio_state=x`, state: 'S', codeChallenge: 'CC', region: 'cn',
  })
  const u = new URL(url)
  assert.equal(u.host, 'www.accio-ai.com')
  assert.equal(u.pathname, '/login')
  assert.equal(u.searchParams.get('return_url'), `${PUB}${CB}?accio_state=x`)
  assert.equal(u.searchParams.get('code_challenge'), 'CC')
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(u.searchParams.get('client_id'), ACCIO_CLIENT_ID)
  assert.ok(u.searchParams.get('ttid'))
})

test('Accio：startAccio 返回公网回调与 PKCE', () => {
  const r = startAccio('accio', {}, { publicBase: PUB, callbackPath: CB })
  assert.equal(r.flow, 'browser')
  assert.ok(r.url.includes('accio-ai.com'))
  assert.ok(r._pkceVerifier && r._state)
  assert.ok(r._redirectUri.includes('accio_state='))
})

test('Accio：token 解析三者缺一不可', () => {
  const ok = parseAccioTokenResponse({ accessToken: 'A', refreshToken: 'R', expiresAt: 1793700000 })
  assert.equal(ok.accessToken, 'A')
  assert.equal(ok.refreshToken, 'R')
  assert.equal(parseAccioTokenResponse({ accessToken: 'A', refreshToken: 'R' }), null, '缺 expiresAt ⇒ null')
  assert.equal(parseAccioTokenResponse({ accessToken: 'A', expiresAt: 1 }), null, '缺 refreshToken ⇒ null')
  assert.equal(parseAccioTokenResponse(null), null)
})

test('Accio poll：没 code ⇒ waiting；有 code ⇒ 换 token 成功', async () => {
  const w = await pollAccio({ callbackParams: {}, _attempts: 0 }, {})
  assert.equal(w.state, 'waiting')

  let seenUrl = ''
  let seenBody = ''
  const r = await pollAccio({
    callbackParams: { code: 'C1' }, _attempts: 0,
    _pkceVerifier: 'V', _redirectUri: 'http://x/cb',
  }, {
    fetchImpl: async (u, init) => {
      seenUrl = u; seenBody = String(init.body)
      return { ok: true, status: 200, text: async () => JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: 1793700000 }) }
    },
  })
  assert.equal(seenUrl, `${ACCIO_GATEWAY_BASE}${ACCIO_TOKEN_EXCHANGE_PATH}`)
  const body = JSON.parse(seenBody)
  assert.equal(body.code, 'C1')
  assert.equal(body.codeVerifier, 'V')
  assert.equal(body.clientId, ACCIO_CLIENT_ID)
  assert.equal(body.clientSecret, undefined, '公开客户端不能有 client_secret')
  assert.equal(r.state, 'ok')
  assert.equal(r.credential.token, 'A')
})

test('Accio poll：换 token 失败 ⇒ 可读错误', async () => {
  const r = await pollAccio({ callbackParams: { code: 'C' }, _attempts: 0 }, {
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }),
  })
  assert.equal(r.state, 'error')
  assert.match(r.error, /500/)
})

// ── flow-map ──
test('flow-map：trae/accio 走真实现', () => {
  for (const id of ['trae', 'accio']) {
    const f = getFlow(id, null)
    assert.equal(f.type, FLOW_TYPE.BROWSER)
    assert.equal(typeof f.start, 'function')
    assert.equal(typeof f.poll, 'function')
  }
})
