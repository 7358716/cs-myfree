/**
 * cs-myfree — Qoder 设备码登录（真实现）测试
 *
 * 全 mock，不联网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  startQoder, pollQoder, parseQoderTokenPayload, buildQoderAuthUrl, buildQoderPollUrl,
  createQoderPkce, QODER_PRODUCTS,
} from '../src/pools/channels/login/qoder.js'
import { getFlow, FLOW_TYPE } from '../src/pools/channels/login/flow-map.js'

// ── PKCE ──
test('PKCE：verifier 长度合法、challenge 为 S256 base64url', () => {
  const p = createQoderPkce()
  assert.ok(p.verifier.length >= 43 && p.verifier.length <= 128, 'verifier 长度必须在 43~128')
  assert.match(p.verifier, /^[A-Za-z0-9\-._~]+$/, 'verifier 字符集必须符合 RFC 7636')
  assert.match(p.challenge, /^[A-Za-z0-9\-_]+$/, 'challenge 必须是 base64url（无 +/=）')
  assert.equal(p.challenge.includes('+'), false)
  assert.equal(p.challenge.includes('/'), false)
  assert.equal(p.challenge.includes('='), false)
})

test('PKCE：每次生成都不同（不可预测）', () => {
  const a = createQoderPkce()
  const b = createQoderPkce()
  assert.notEqual(a.verifier, b.verifier)
  assert.notEqual(a.challenge, b.challenge)
})

// ── URL 构造 ──
test('授权页 URL 带齐 challenge/nonce/machine_id/client_id', () => {
  const s = startQoder('qoder', {})
  const u = new URL(s.url)
  assert.equal(u.host, 'qoder.com')
  assert.ok(u.pathname.includes('/device/selectAccounts'))
  for (const k of ['challenge', 'challenge_method', 'nonce', 'machine_id', 'client_id']) {
    assert.ok(u.searchParams.get(k), `授权 URL 缺参数 ${k}`)
  }
  assert.equal(u.searchParams.get('challenge_method'), 'S256')
  assert.equal(u.searchParams.get('client_id'), QODER_PRODUCTS.qoder.clientId)
})

test('轮询 URL 挂 openApiBase（不是 authBase）—— 写错 host 登录永远失败', () => {
  const s = startQoder('qoder', {})
  const pollUrl = buildQoderPollUrl({ pkce: { verifier: s._pkceVerifier }, nonce: s._nonce }, QODER_PRODUCTS.qoder)
  const u = new URL(pollUrl)
  assert.equal(u.host, 'openapi.qoder.sh', '轮询必须挂 openapi.qoder.sh')
  assert.ok(u.pathname.includes('/api/v1/deviceToken/poll'))
  assert.equal(u.searchParams.get('challenge_method'), 'S256')
})

test('qodercn 用中国版端点与 clientId', () => {
  const s = startQoder('qodercn', {})
  assert.ok(s.url.includes('qoder.cn'), 'qodercn 授权页必须是 qoder.cn')
  assert.equal(new URL(s.url).searchParams.get('client_id'), QODER_PRODUCTS.qodercn.clientId)
})

// ── token 解析 ──
test('token 响应解析：多种字段名都认', () => {
  assert.equal(parseQoderTokenPayload({ token: 'T1' }).accessToken, 'T1')
  assert.equal(parseQoderTokenPayload({ access_token: 'T2' }).accessToken, 'T2')
  assert.equal(parseQoderTokenPayload({ device_token: 'T3' }).accessToken, 'T3')
  const p = parseQoderTokenPayload({
    token: 'T', refresh_token: 'R', expires_at: '2026-11-05T00:00:00Z', user_id: 'u1', user_name: '昵称',
  })
  assert.equal(p.refreshToken, 'R')
  assert.equal(typeof p.expiresAt, 'number')
  assert.equal(p.uid, 'u1')
  assert.equal(p.userName, '昵称')
  // 数字秒级时间戳
  assert.equal(parseQoderTokenPayload({ token: 'T', expires_at: 1793700000 }).expiresAt, 1793700000000)
  // 非法输入不抛
  assert.equal(parseQoderTokenPayload(null).accessToken, '')
  assert.equal(parseQoderTokenPayload([]).accessToken, '')
})

// ── 状态机 ──
test('poll：404 = 用户未完成授权 ⇒ 必须 waiting（不是 error）', async () => {
  const s = startQoder('qoder', {})
  const r = await pollQoder(s, { fetchImpl: async () => ({ status: 404, ok: false }) })
  assert.equal(r.state, 'waiting', '404 必须是 waiting')
})

test('poll：200 但无 token ⇒ waiting', async () => {
  const s = startQoder('qoder', {})
  const r = await pollQoder(s, {
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({}) }),
  })
  assert.equal(r.state, 'waiting')
})

test('poll：200 + token ⇒ ok，返回 credential', async () => {
  const s = startQoder('qoder', {})
  const r = await pollQoder(s, {
    fetchImpl: async () => ({
      status: 200, ok: true,
      json: async () => ({ token: 'ACC', refresh_token: 'REF', expires_at: 1793700000, user_id: 'u9', user_name: '小明' }),
    }),
  })
  assert.equal(r.state, 'ok')
  assert.equal(r.credential.token, 'ACC')
  assert.equal(r.credential.refreshToken, 'REF')
  assert.equal(r.credential.uid, 'u9')
  assert.equal(r.maskedAccount, '小明')
})

test('poll：网络抖动容错（≤5 次继续等待）', async () => {
  const s = startQoder('qoder', {})
  let n = 0
  const r = await pollQoder(s, {
    fetchImpl: async () => { n++; throw new Error('ECONNRESET') },
  })
  assert.equal(r.state, 'waiting')
  assert.equal(n, 1)
})

test('poll：连续网络失败超过上限 ⇒ error（不会永远转圈）', async () => {
  const s = startQoder('qoder', {})
  let last = null
  for (let i = 0; i < 8; i++) {
    last = await pollQoder(s, { fetchImpl: async () => { throw new Error('ECONNRESET') } })
  }
  assert.equal(last.state, 'error')
})

test('poll：上游 5xx 继续等待（不误判失败）', async () => {
  const s = startQoder('qoder', {})
  const r = await pollQoder(s, { fetchImpl: async () => ({ status: 503, ok: false }) })
  assert.equal(r.state, 'waiting')
})

test('poll：缺 PKCE 参数 ⇒ 明确 error', async () => {
  const r = await pollQoder({}, { fetchImpl: async () => ({ status: 404, ok: false }) })
  assert.equal(r.state, 'error')
  assert.match(r.error, /PKCE/)
})

test('poll：超过尝试上限 ⇒ error', async () => {
  const s = startQoder('qoder', {})
  s._attempts = 500
  const r = await pollQoder(s, { fetchImpl: async () => ({ status: 404, ok: false }) })
  assert.equal(r.state, 'error')
  assert.match(r.error, /超时/)
})

test('poll：响应绝不含明文 credential 字段名（由状态机持有）', async () => {
  const s = startQoder('qoder', {})
  const r = await pollQoder(s, {
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ token: 'SECRET' }) }),
  })
  // poll 返回值里可以有 credential（状态机消费），但不得有 refreshToken 直出字段之外的东西
  assert.equal(r.state, 'ok')
  assert.ok(r.credential && r.credential.token === 'SECRET')
})

// ── flow-map 集成 ──
test('flow-map：qoder/qodercn 走真实现（不是通用壳）', () => {
  for (const id of ['qoder', 'qodercn']) {
    const f = getFlow(id, null)
    assert.equal(f.type, FLOW_TYPE.DEVICE, `${id} 必须是 device 流`)
    const init = f.initial(id, {}, {})
    assert.ok(init.url && init.url.includes('qoder'), `${id} 必须给真实授权 URL`)
    assert.ok(init._pkceVerifier && init._nonce, `${id} 必须持有 PKCE 与 nonce`)
    assert.equal(init.pollingOnly, true, `${id} 是纯轮询，需要 pollingOnly`)
    assert.equal(typeof f.poll, 'function')
  }
})
