/**
 * cs-myfree — 登录成功后「凭据必须落盘」回归测试
 *
 * 🐛 真实缺陷（2026-11-03 用户实测）：
 *    腾讯 CodeBuddy / 讯飞 Loomy 登录显示「✅ 登录成功：186****7879」，
 *    但紧接着「测试连通」报 `❌ 该渠道未登录（无可用凭据）(AUTH)`。
 *
 * 根因：`pollLogin()` 的**返回值里没有 credential**（它只把 credential 存在
 *      内部 session 上），而 `/login/poll` 路由判断的是 `r.credential`
 *      ⇒ 落盘分支永远进不去 ⇒ 账号没保存。
 *
 * 本文件锁死这个行为：poll 返回 ok 后，账号**必须**出现在 /channels 里。
 *
 * 全 mock，不联网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerRoutes } from '../src/web/routes.js'

const PUBLIC = { host: 'example.com' }
const REAL_COOKIE = 'dsh-auth-real=sig'
const fakeConnection = {
  requestRejection: (req) => (req?.headers?.cookie === REAL_COOKIE ? undefined : 401),
}
const withCookie = { ...PUBLIC, cookie: REAL_COOKIE }

function fakeState(home) {
  return {
    readChain: async () => ({ chain: [] }),
    readProbe: async () => null,
    overview: async () => ({ exists: false, dir: home }),
    readConfigSync: () => ({}),
    readConfig: async () => ({}),
  }
}

function request(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: {
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        let json
        try { json = JSON.parse(text) } catch { json = undefined }
        resolve({ status: res.statusCode, text, json })
      })
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/**
 * @param {object} engineOpts
 * @param {(session:any)=>void} [engineOpts.onPoll] 每次 poll 时改写 session
 */
async function startServer(engineOpts = {}) {
  const home = await mkdtemp(join(tmpdir(), 'cs-myfree-persist-'))
  const routes = new Map()
  const webServer = { register: ({ path, handler }) => routes.set(path, handler) }

  const sessions = new Map()
  const loginEngine = {
    start: async (provider) => {
      const sessionId = 'sid-' + provider
      sessions.set(sessionId, { sessionId, provider, flow: 'browser', state: 'pending' })
      return { sessionId, flow: 'browser', instructions: ['x'] }
    },
    poll: async (sessionId) => {
      const s = sessions.get(sessionId)
      if (!s) return { state: 'error' }
      if (engineOpts.onPoll) engineOpts.onPoll(s)
      return {
        state: s.state,
        hint: s.hint ?? '',
        maskedAccount: s.maskedAccount ?? null,
        error: s.error ?? null,
      }
    },
    get: (sessionId) => sessions.get(sessionId) ?? null,
    cancel: () => true,
    callback: () => ({ ok: true }),
  }

  registerRoutes(webServer, {
    version: 'persist-test',
    dshHome: home,
    state: fakeState(home),
    trustedHosts: ['example.com'],
    publicBase: 'http://example.com',
    getConnection: () => fakeConnection,
    loginEngine,
    logger: { info: () => {}, warn: () => {} },
    fetchImpl: async () => { throw new Error('offline') },
  })

  const server = http.createServer((req, res) => {
    let pathname = '/'
    try { pathname = new URL(req.url, 'http://x').pathname } catch { /* ignore */ }
    const handler = routes.get(pathname)
    if (!handler) { res.writeHead(404); res.end('not found'); return }
    Promise.resolve(handler(req, res)).catch(() => { try { res.writeHead(500); res.end('x') } catch { /* ignore */ } })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: server.address().port,
    home,
    close: async () => {
      await new Promise((r) => server.close(r))
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 40))
        try { await rm(home, { recursive: true, force: true }); return } catch { /* retry */ }
      }
    },
  }
}

// ────────────────────────────────────────────────────────────────
// 核心回归
// ────────────────────────────────────────────────────────────────

test('🔴 登录成功 ⇒ 凭据必须落盘（否则「测试连通」永远 AUTH）', async () => {
  const s = await startServer({
    onPoll: (session) => {
      // 模拟 flow 拿到 credential 后由状态机存到 session 上
      session.state = 'ok'
      session.maskedAccount = '186****7879'
      session.credential = { token: 'TOKEN-FAKE-1234567890', refreshToken: 'RT-FAKE', expiresAt: Date.now() + 3600_000 }
    },
  })
  try {
    const st = await request(s.port, '/cs-myfree/login/start', { method: 'POST', headers: withCookie, body: { provider: 'buddy' } })
    assert.equal(st.json.ok, true)
    const sessionId = st.json.sessionId

    const p = await request(s.port, `/cs-myfree/login/poll?sessionId=${encodeURIComponent(sessionId)}`, { headers: withCookie })
    assert.equal(p.json.state, 'ok')
    // 关键：此时账号必须已落盘
    const ch = await request(s.port, '/cs-myfree/channels', { headers: withCookie })
    const buddy = (ch.json.channels || []).find((c) => c.id === 'buddy')
    assert.ok(buddy, '必须有 buddy 渠道')
    assert.equal(buddy.accounts.length, 1, '登录成功后账号必须落盘（此前 bug：一直 0）')
    assert.equal(buddy.loggedIn, true)
    // 只回掩码
    assert.ok(String(buddy.accounts[0].masked).includes('…') || String(buddy.accounts[0].masked).includes('****'))
    assert.equal('credential' in buddy.accounts[0], false, '绝不能回凭据原文')
  } finally { await s.close() }
})

test('轮询响应里绝不出现凭据原文', async () => {
  const s = await startServer({
    onPoll: (session) => {
      session.state = 'ok'
      session.maskedAccount = 'mask'
      session.credential = { token: 'SECRET-TOKEN-SHOULD-NOT-LEAK' }
    },
  })
  try {
    const st = await request(s.port, '/cs-myfree/login/start', { method: 'POST', headers: withCookie, body: { provider: 'loomy' } })
    const p = await request(s.port, `/cs-myfree/login/poll?sessionId=${encodeURIComponent(st.json.sessionId)}`, { headers: withCookie })
    assert.equal(p.text.includes('SECRET-TOKEN-SHOULD-NOT-LEAK'), false, 'poll 响应绝不能含 token 原文')
    assert.equal('credential' in (p.json || {}), false, 'poll 响应不应有 credential 字段')
  } finally { await s.close() }
})

test('AK/SK 型渠道：poll 后落盘为 ak/sk 结构且能取出', async () => {
  const s = await startServer({
    onPoll: (session) => {
      session.state = 'ok'
      session.maskedAccount = 'AK12…CD34'
      session.credential = { ak: 'AK1234567890ABCD34', sk: 'SK0987654321WXYZ98' }
    },
  })
  try {
    const st = await request(s.port, '/cs-myfree/login/start', { method: 'POST', headers: withCookie, body: { provider: 'codearts' } })
    await request(s.port, `/cs-myfree/login/poll?sessionId=${encodeURIComponent(st.json.sessionId)}`, { headers: withCookie })
    const ch = await request(s.port, '/cs-myfree/channels', { headers: withCookie })
    const ca = (ch.json.channels || []).find((c) => c.id === 'codearts')
    assert.equal(ca.accounts.length, 1)
    assert.equal(ca.loggedIn, true)
  } finally { await s.close() }
})

test('落盘幂等：同一会话 poll 多次不会重复创建账号', async () => {
  const s = await startServer({
    onPoll: (session) => {
      session.state = 'ok'
      session.maskedAccount = 'mask'
      session.credential = { token: 'TOKEN-IDEMPOTENT-123' }
    },
  })
  try {
    const st = await request(s.port, '/cs-myfree/login/start', { method: 'POST', headers: withCookie, body: { provider: 'buddy' } })
    const sid = st.json.sessionId
    await request(s.port, `/cs-myfree/login/poll?sessionId=${encodeURIComponent(sid)}`, { headers: withCookie })
    await request(s.port, `/cs-myfree/login/poll?sessionId=${encodeURIComponent(sid)}`, { headers: withCookie })
    const ch = await request(s.port, '/cs-myfree/channels', { headers: withCookie })
    const buddy = (ch.json.channels || []).find((c) => c.id === 'buddy')
    assert.equal(buddy.accounts.length, 1, '同一会话重复 poll 不能重复建号')
  } finally { await s.close() }
})
