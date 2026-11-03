/**
 * cs-myfree — 统一登录状态机 + CodeArts 一键登录（真实实现）测试
 *
 * 纪律：全 mock，不联网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  startLogin, getSession, pollLogin, cancelLogin, handleCallback, sessions, states,
} from '../src/pools/channels/login/index.js'
import {
  buildLoginUrl, parseCredentialResponse, pollCodearts, startCodearts,
  CODEARTS_LOGIN_BASE, HUAWEI_AUTH_BASE, CODEARTS_TICKET_ENDPOINT,
} from '../src/pools/channels/login/codearts.js'
import { getFlow, FLOW_MAP, FLOW_TYPE } from '../src/pools/channels/login/flow-map.js'
import { CHANNELS } from '../src/pools/channels/protocols.js'

const PUB = 'http://150.158.175.241'
const CB = '/cs-myfree/login/callback'

// ── CodeArts URL 构造 ──
test('codearts 登录 URL 用公网回调（不是 127.0.0.1）', async () => {
  const url = buildLoginUrl(`${PUB}${CB}?state=abc`, 'ticket123')
  assert.ok(url.startsWith(HUAWEI_AUTH_BASE), '必须走华为 authui 登录页')
  const decoded = decodeURIComponent(url)
  assert.ok(decoded.includes(CODEARTS_LOGIN_BASE), 'service 里要带 doer/redirect')
  assert.ok(decoded.includes(encodeURIComponent(`${PUB}${CB}?state=abc`)) || decoded.includes(`${PUB}${CB}`),
    'auth_callback_url 必须是公网回调地址')
  assert.ok(!decoded.includes('127.0.0.1'), '绝不能再用 127.0.0.1（远程浏览器收不到）')
  assert.ok(decoded.includes('ticket_id=ticket123'))
  assert.ok(decoded.includes('plugin-name=snap_jetbrains'))
})

test('ticket 响应解析：credential 与 result 两种形状', async () => {
  const a = parseCredentialResponse({ credential: { access: 'AK1', secret: 'SK1', securitytoken: 'ST1', expires_at: '2026-11-05T00:00:00Z' } })
  assert.equal(a.ak, 'AK1'); assert.equal(a.sk, 'SK1'); assert.equal(a.securityToken, 'ST1')
  assert.equal(typeof a.expiresAt, 'number')
  const b = parseCredentialResponse({ result: { accessKeyId: 'AK2', secretAccessKey: 'SK2', securityToken: 'ST2' } })
  assert.equal(b.ak, 'AK2'); assert.equal(b.sk, 'SK2'); assert.equal(b.securityToken, 'ST2')
  assert.equal(parseCredentialResponse({}), null)
  assert.equal(parseCredentialResponse(null), null)
  // 缺 security_token 视为未完成（不能当成凭据）
  assert.equal(parseCredentialResponse({ credential: { access: 'A', secret: 'S' } }), null)
})

test('startCodearts 返回 flow=browser + 公网回调 + 说明', async () => {
  const r = startCodearts('codearts', CHANNELS.codearts, { publicBase: PUB, callbackPath: CB })
  assert.equal(r.flow, 'browser')
  assert.ok(r.url.includes('auth.huaweicloud.com'))
  assert.ok(r.instructions.length >= 2)
  assert.ok(r._ticketId && r._secret, '必须生成 ticketId 与 secret')
  assert.ok(r._secret.length === 64, 'secret 必须是 64 位 hex')
})

test('pollCodearts：未完成 → waiting；收到凭据 → ok', async () => {
  const mk = (body) => async () => ({
    ok: true,
    json: async () => body,
  })
  const s1 = { _ticketId: 't', _secret: 's', _attempts: 0 }
  const w = await pollCodearts(s1, { fetchImpl: mk({}) })
  assert.equal(w.state, 'waiting')

  const s2 = { _ticketId: 't', _secret: 's', _attempts: 0 }
  const ok = await pollCodearts(s2, {
    fetchImpl: mk({ credential: { access: 'AK', secret: 'SK', securitytoken: 'ST' } }),
  })
  assert.equal(ok.state, 'ok')
  assert.equal(ok.credential.ak, 'AK')
  assert.equal(ok.credential.securityToken, 'ST')
})

test('pollCodearts：网络异常也继续等（不当失败）', async () => {
  const s = { _ticketId: 't', _secret: 's', _attempts: 0 }
  const r = await pollCodearts(s, { fetchImpl: async () => { throw new Error('ECONNRESET') } })
  assert.equal(r.state, 'waiting')
})

test('pollCodearts：超过上限 → error（不会永远转圈）', async () => {
  const s = { _ticketId: 't', _secret: 's', _attempts: 200 }
  const r = await pollCodearts(s, { fetchImpl: async () => ({ ok: false }) })
  assert.equal(r.state, 'error')
  assert.match(r.error, /超时/)
})

// ── 状态机 ──
test('startLogin 注册一次性 state，回调消费后失效（防重放）', async () => {
  const s = await startLogin('codearts', CHANNELS.codearts, { publicBase: PUB, callbackPath: CB })
  assert.ok(s.state, '必须返回 state')
  assert.ok(s.callbackUrl.startsWith(PUB), '回调地址必须是公网')
  const r1 = handleCallback({ state: s.state, code: 'CODE1' })
  assert.equal(r1.ok, true)
  const r2 = handleCallback({ state: s.state, code: 'CODE2' })
  assert.equal(r2.ok, false, 'state 必须一次性')
  cancelLogin(s.sessionId)
})

test('handleCallback 带 code 后会话进入 waiting', async () => {
  const s = await startLogin('codearts', CHANNELS.codearts, { publicBase: PUB, callbackPath: CB })
  handleCallback({ state: s.state, code: 'C' })
  const sess = getSession(s.sessionId)
  assert.equal(sess.callbackCode, 'C')
  assert.equal(sess.state, 'waiting')
  cancelLogin(s.sessionId)
})

test('pollLogin：会话不存在返回 error', async () => {
  const r = await pollLogin('no-such-session')
  assert.equal(r.state, 'error')
})

test('cancelLogin 后 poll 不会再返回 ok', async () => {
  const s = await startLogin('codearts', CHANNELS.codearts, { publicBase: PUB, callbackPath: CB })
  cancelLogin(s.sessionId)
  const r = await pollLogin(s.sessionId)
  assert.equal(r.state, 'error')
})

test('过期会话 poll 返回 expired', async () => {
  const s = await startLogin('codearts', CHANNELS.codearts, { publicBase: PUB, callbackPath: CB })
  const sess = getSession(s.sessionId)
  sess.expiresAt = Date.now() - 1000
  const r = await pollLogin(s.sessionId)
  assert.equal(r.state, 'expired')
  cancelLogin(s.sessionId)
})

// ── flow-map 覆盖度 ──
test('18 家渠道全部有登录流类型', async () => {
  const ids = Object.keys(CHANNELS)
  assert.equal(ids.length, 18)
  for (const id of ids) {
    const f = FLOW_MAP[id]
    assert.ok(f, `${id} 缺 flow 定义`)
    assert.ok(Object.values(FLOW_TYPE).includes(f.type), `${id} 流类型非法：${f.type}`)
    assert.equal(typeof f.loginVerified, 'boolean', `${id} 缺 loginVerified`)
  }
})

test('未验证渠道必须诚实标注（不能全 true）', async () => {
  const verified = Object.entries(FLOW_MAP).filter(([, v]) => v.loginVerified).map(([k]) => k)
  assert.ok(verified.includes('codearts'), 'codearts 应已真机验证')
  assert.ok(verified.length < Object.keys(FLOW_MAP).length, '不可能 18 家全验证')
  for (const [id, v] of Object.entries(FLOW_MAP)) {
    if (!v.loginVerified) assert.ok(v.loginNote && v.loginNote.length > 0, `${id} 未验证但没有说明`)
  }
})

test('getFlow 对未取证渠道给诚实降级（不造假 userCode/url）', async () => {
  // buddy/workbuddy 已有真实现（见 test/login-buddy.test.mjs），这里改用仍无实现的 trae
  const f = getFlow('trae', CHANNELS.trae)
  assert.equal(f.type, FLOW_TYPE.BROWSER)
  const init = await f.initial('trae', CHANNELS.trae, {})
  assert.equal(init.userCode ?? null, null, '不许编造设备码')
  assert.equal(init.url ?? null, null, '未取证渠道不许编造登录 URL')
  assert.ok(Array.isArray(init.instructions) && init.instructions.length > 0, '必须给操作说明')
})

test('getFlow 对 codearts 用真实现（不会回落到通用壳）', async () => {
  const f = getFlow('codearts', CHANNELS.codearts)
  assert.equal(typeof f.poll, 'function')
  const init = f.initial('codearts', CHANNELS.codearts, { publicBase: PUB, callbackPath: CB })
  assert.ok(init.url.includes('huaweicloud'), 'codearts 必须给真实登录 URL')
  assert.ok(init._ticketId, 'codearts 必须有 ticketId')
})

test('poll 的 credential 绝不进 HTTP 可见字段（只有 state/hint/masked）', async () => {
  const s = await startLogin('codearts', CHANNELS.codearts, { publicBase: PUB, callbackPath: CB })
  const sess = getSession(s.sessionId)
  sess._attempts = 0
  sess.pollImpl = async () => ({ state: 'ok', credential: { ak: 'SECRETAK', sk: 'SECRETSK' } })
  // 用真实 pollCodearts 会打网，这里只验证状态机对外形状
  const r = await pollLogin(s.sessionId, { fetchImpl: async () => ({ ok: false }) })
  assert.equal('credential' in r, false, 'poll 响应不得含 credential')
  assert.ok('state' in r && 'hint' in r)
  cancelLogin(s.sessionId)
})

test('sessions/states 是内存结构，可清理', async () => {
  assert.ok(sessions instanceof Map)
  assert.ok(states instanceof Map)
})
