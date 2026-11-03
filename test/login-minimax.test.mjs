/**
 * cs-myfree — MiniMax（国内/国际）设备码登录测试
 * 全 mock，不联网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  startMinimax, pollMinimax, createMinimaxPkce, parseMinimaxDeviceAuthorization,
  parseMinimaxTokenGrant, MINIMAX_PRODUCTS, MINIMAX_DEVICE_CODE_PATH, MINIMAX_TOKEN_PATH,
} from '../src/pools/channels/login/minimax.js'
import { getFlow, FLOW_TYPE } from '../src/pools/channels/login/flow-map.js'

const AUTH_OK = {
  device_code: 'DEV', user_code: 'ABCD-EFGH',
  verification_uri: 'https://account.minimax.cn/oauth-authorize',
  verification_uri_complete: 'https://account.minimax.cn/oauth-authorize?user_code=ABCD-EFGH',
  expires_in: 600, interval: 5,
}

test('PKCE：verifier 合法、challenge 为 S256 base64url', () => {
  const p = createMinimaxPkce()
  assert.ok(p.verifier.length >= 43 && p.verifier.length <= 128)
  assert.match(p.verifier, /^[A-Za-z0-9\-._~]+$/)
  assert.equal(p.challenge.includes('='), false)
  assert.notEqual(createMinimaxPkce().verifier, p.verifier)
})

test('设备码解析', () => {
  const a = parseMinimaxDeviceAuthorization(AUTH_OK)
  assert.equal(a.deviceCode, 'DEV')
  assert.equal(a.userCode, 'ABCD-EFGH')
  assert.equal(parseMinimaxDeviceAuthorization({ device_code: 'D' }), null)
  assert.equal(parseMinimaxDeviceAuthorization(null), null)
})

test('token 解析', () => {
  const t = parseMinimaxTokenGrant({ access_token: 'A', refresh_token: 'R', expires_in: 3600 })
  assert.equal(t.accessToken, 'A')
  assert.equal(t.refreshToken, 'R')
  assert.equal(typeof t.expiresAt, 'number')
  assert.equal(parseMinimaxTokenGrant({}), null)
})

test('国内站与国际站端点/参数正确', async () => {
  for (const [id, product] of Object.entries(MINIMAX_PRODUCTS)) {
    let url = ''
    let body = ''
    const r = await startMinimax(id, {}, {
      fetchImpl: async (u, init) => { url = u; body = String(init.body); return { ok: true, status: 200, json: async () => AUTH_OK } },
    })
    assert.equal(url, `${product.accountHost}${MINIMAX_DEVICE_CODE_PATH}`, `${id} 端点错`)
    assert.ok(body.includes(`client_id=${product.clientId}`))
    assert.ok(body.includes('code_challenge_method=S256'))
    assert.ok(body.includes(`audience=${product.audience}`))
    assert.equal(r.userCode, 'ABCD-EFGH')
    assert.ok(r.url.includes('user_code=ABCD-EFGH'))
  }
})

test('startMinimax：网络失败诚实降级', async () => {
  const r = await startMinimax('minimax', {}, { fetchImpl: async () => { throw new Error('ENOTFOUND') } })
  assert.equal(r.userCode, null)
  assert.ok(r._startError.includes('无法连接'))
})

test('startMinimax：HTTP 错误诚实降级', async () => {
  const r = await startMinimax('minimax', {}, { fetchImpl: async () => ({ ok: false, status: 503 }) })
  assert.equal(r.userCode, null)
  assert.match(r._startError, /503/)
})

test('pollMinimax：authorization_pending ⇒ waiting', async () => {
  const s = { _deviceCode: 'D', _pkceVerifier: 'v', _expiresAtMs: Date.now() + 60000, _product: 'minimax' }
  const r = await pollMinimax(s, {
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'authorization_pending' }) }),
  })
  assert.equal(r.state, 'waiting')
})

test('pollMinimax：成功拿到 token', async () => {
  const s = { _deviceCode: 'D', _pkceVerifier: 'v', _expiresAtMs: Date.now() + 60000, _product: 'minimaxintl' }
  let url = ''
  const r = await pollMinimax(s, {
    fetchImpl: async (u) => {
      url = u
      return { ok: true, status: 200, json: async () => ({ access_token: 'A', refresh_token: 'R', expires_in: 3600 }) }
    },
  })
  assert.equal(url, `${MINIMAX_PRODUCTS.minimaxintl.accountHost}${MINIMAX_TOKEN_PATH}`)
  assert.equal(r.state, 'ok')
  assert.equal(r.credential.token, 'A')
})

test('pollMinimax：终态错误码 ⇒ error', async () => {
  for (const code of ['access_denied', 'expired_token', 'invalid_grant']) {
    const s = { _deviceCode: 'D', _pkceVerifier: 'v', _expiresAtMs: Date.now() + 60000 }
    const r = await pollMinimax(s, { fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: code }) }) })
    assert.equal(r.state, 'error', `${code} 必须是终态`)
  }
})

test('pollMinimax：过期/缺参数/连续失败', async () => {
  assert.equal((await pollMinimax({}, { fetchImpl: async () => ({}) })).state, 'error')
  const expired = { _deviceCode: 'D', _expiresAtMs: Date.now() - 1 }
  assert.equal((await pollMinimax(expired, { fetchImpl: async () => ({}) })).state, 'error')
  const s = { _deviceCode: 'D', _pkceVerifier: 'v', _expiresAtMs: Date.now() + 600000 }
  let last = null
  for (let i = 0; i < 8; i++) last = await pollMinimax(s, { fetchImpl: async () => { throw new Error('x') } })
  assert.equal(last.state, 'error')
})

test('flow-map：minimax/minimaxintl 走真实现', () => {
  for (const id of ['minimax', 'minimaxintl']) {
    const f = getFlow(id, null)
    assert.equal(f.type, FLOW_TYPE.DEVICE)
    assert.equal(typeof f.start, 'function')
    assert.equal(typeof f.poll, 'function')
  }
})
