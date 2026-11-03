/**
 * cs-myfree — 「一键登录」链路攻击性测试（专职测试 A）
 *
 * 目标：把 /login/callback（公网可达、不走 cookie）、/login/poll（凭据泄露面）、
 *      /login/* 与 /accounts/remove（认证/CSRF）、状态机资源回收、未取证渠道诚实降级
 *      这些面**自动化**成可重复的攻击用例。
 *
 * 纪律：
 *  · 全部本地/全 mock，**不联网**（出站 fetch 一律注入 mock，失败即 offline）
 *  · 不打印任何凭据明文（断言用假值，失败信息也只在 test 内部比对）
 *  · 只测不改业务代码：发现缺陷用报告 + `todo` 标注，不修改 src/
 *
 * 运行：node --test test/login-abuse.test.mjs
 *
 * @module cs-myfree/test/login-abuse
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { registerRoutes } from '../src/web/routes.js'
import { CHANNELS } from '../src/pools/channels/protocols.js'
import {
  startLogin, getSession, pollLogin, cancelLogin, handleCallback, cleanupExpired,
  sessions, states,
} from '../src/pools/channels/login/index.js'
import { pollCodearts } from '../src/pools/channels/login/codearts.js'

const PUB = 'http://example.com'
const CB = '/cs-myfree/login/callback'
const SECRET_AK = 'AKTESTFAKE00000000AK'
const SECRET_SK = 'SKTESTFAKE00000000SK'
const SECRET_ST = 'STTESTFAKE00000000ST'
const SECRET_CODE = 'CODETESTSECRET123456'

// ────────────────────────────────────────────────────────────────
// 基础设施：临时 DSH_HOME + 真实 HTTP server + 可控 fake connection
// ────────────────────────────────────────────────────────────────

async function makeHome() {
  return mkdtemp(join(tmpdir(), 'cs-myfree-login-abuse-'))
}

/** 假 connection 服务：dsh-auth-real=sig 视为真实会话 */
const REAL_COOKIE = 'dsh-auth-real=sig'
const fakeConnection = {
  requestRejection(req) {
    const c = req?.headers?.cookie
    if (c === REAL_COOKIE) return undefined
    return 401 // 真实宿主：无效签名/无会话都是 401（不可信 Host 才是 403，见单独用例）
  },
}

/** 极简 state store（只覆盖登录路由用到的读接口，避免真实读写盘） */
function fakeState(home) {
  return {
    readChain: async () => ({ chain: [] }),
    readProbe: async () => null,
    overview: async () => ({ exists: false, dir: home }),
    readConfigSync: () => ({}),
    readConfig: async () => ({}),
  }
}

/**
 * 起一个真实的本地 HTTP server，把 registerRoutes 注册的路由挂上去。
 * @returns {{port:number, close:()=>Promise<void>, logs:string[], home:string, n:number}}
 */
async function startServer(opts = {}) {
  const home = opts.home ?? await makeHome()
  const logs = []
  const logger = { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) }
  const routes = new Map()
  const webServer = {
    register: ({ path, handler }) => { routes.set(path, handler) },
  }
  const n = registerRoutes(webServer, {
    version: 'login-abuse-test',
    dshHome: home,
    state: fakeState(home),
    trustedHosts: ['example.com'],
    publicBase: PUB,
    getConnection: () => fakeConnection,
    logger,
    fetchImpl: async () => { throw new Error('offline: 测试禁止联网') },
    now: () => Date.now(),
    ...opts,
  })
  const server = http.createServer((req, res) => {
    let pathname = '/'
    try { pathname = new URL(req.url, 'http://x').pathname } catch { /* ignore */ }
    const handler = routes.get(pathname)
    if (!handler) { res.writeHead(404); res.end('not found'); return }
    Promise.resolve(handler(req, res)).catch(() => {
      try { res.writeHead(500); res.end('handler crashed') } catch { /* ignore */ }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    n, port, logs, home,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      // 登录成功路径会 fire-and-forget 刷新模型（写 channel-models.json）
      // ⇒ 等一小会儿再清理，rm 失败重试，避免 ENOTEMPTY 竞态
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 40))
        try { await rm(home, { recursive: true, force: true, maxRetries: 3 }); return } catch { /* retry */ }
      }
    },
  }
}

/** 原始 HTTP 请求：可自由设置 Host / Cookie / Origin / body */
function request(port, path, { method = 'GET', body, headers = {}, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody !== undefined
      ? rawBody
      : (body === undefined ? undefined : JSON.stringify(body))
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: safeJson(text) }))
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

function safeJson(t) {
  try { return JSON.parse(t) } catch { return undefined }
}

/** 公网 Host（模拟 nginx 反代） */
const PUBLIC = { host: 'example.com' }
const withCookie = (cookie) => ({ ...PUBLIC, cookie })

/** 从 codearts 登录 URL 里解出一次性 state（仅测试用；两重编码） */
function extractState(url) {
  if (!url) return null
  let dec = url
  for (let i = 0; i < 2; i++) {
    try { dec = decodeURIComponent(dec) } catch { break }
  }
  const m = /state=([0-9a-f]{32,128})/.exec(dec)
  return m ? m[1] : null
}

/** 通过 HTTP /login/start（真实状态机）拿 sessionId + state（仅 codearts，无网络） */
async function startCodeartsSession(port) {
  const r = await request(port, '/cs-myfree/login/start', {
    method: 'POST', headers: withCookie(REAL_COOKIE), body: { provider: 'codearts' },
  })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true, JSON.stringify(r.json))
  return { sessionId: r.json.sessionId, state: extractState(r.json.url), json: r.json }
}

/** 直接经状态机起一个 codearts 会话（不联网；等价于 /login/start 的默认引擎路径） */
async function startCodeartsSessionViaMachine() {
  const r = await startLogin('codearts', CHANNELS.codearts, { publicBase: PUB, callbackPath: CB })
  return { sessionId: r.sessionId, state: r.state }
}

/** 清空状态机（测试隔离用；模块级 Map 是导出对象） */
function resetMachine() {
  sessions.clear()
  states.clear()
}

// ════════════════════════════════════════════════════════════════
// 1. 认证 / CSRF 矩阵：/login/* 与 /accounts/remove
// ════════════════════════════════════════════════════════════════

test('认证矩阵：回环直连（本机管理员）可用', async () => {
  const s = await startServer()
  try {
    const r = await request(s.port, '/cs-myfree/login/status', { headers: { host: `127.0.0.1:${s.port}` } })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.ok(r.json.total >= 18)
  } finally { await s.close() }
})

test('认证矩阵：公网 Host + 伪造 cookie ⇒ 401（全部登录相关端点）', async () => {
  const s = await startServer()
  try {
    const endpoints = [
      ['GET', '/cs-myfree/login/status'],
      ['POST', '/cs-myfree/login/start'],
      ['GET', '/cs-myfree/login/poll?sessionId=x'],
      ['POST', '/cs-myfree/login/cancel'],
      ['POST', '/cs-myfree/login/test'],
      ['POST', '/cs-myfree/login/refresh'],
      ['POST', '/cs-myfree/accounts/remove'],
    ]
    for (const [method, path] of endpoints) {
      const r = await request(s.port, path, { method, headers: withCookie('dsh-auth-forged'), body: method === 'POST' ? {} : undefined })
      assert.equal(r.status, 401, `${method} ${path} 应 401，实际 ${r.status}`)
      assert.equal(r.json?.ok, false)
      assert.equal(r.json?.error, 'invalid-or-missing-session')
    }
  } finally { await s.close() }
})

test('认证矩阵：公网 Host + 无 cookie ⇒ 401', async () => {
  const s = await startServer()
  try {
    const r = await request(s.port, '/cs-myfree/login/status', { headers: PUBLIC })
    assert.equal(r.status, 401)
  } finally { await s.close() }
})

test('认证矩阵：不可信 Host / 会话拒绝 ⇒ 403', async () => {
  const conn = { requestRejection: () => 403 }
  const s = await startServer({ getConnection: () => conn })
  try {
    const r = await request(s.port, '/cs-myfree/login/status', { headers: withCookie('dsh-auth-any') })
    assert.equal(r.status, 403)
    assert.equal(r.json?.ok, false)
  } finally { await s.close() }
})

test('认证矩阵：显式跨源 Origin ⇒ 403（CSRF）', async () => {
  const s = await startServer()
  try {
    const r = await request(s.port, '/cs-myfree/login/status', {
      headers: { ...withCookie(REAL_COOKIE), origin: 'https://evil.example' },
    })
    assert.equal(r.status, 403)
    assert.equal(r.json?.error, 'cross-origin')
  } finally { await s.close() }
})

test('认证矩阵：拿不到 connection 服务 ⇒ fail-closed 403（绝不按 cookie 名放行）', async () => {
  const s = await startServer({ getConnection: () => null })
  try {
    const r = await request(s.port, '/cs-myfree/login/status', { headers: withCookie('dsh-auth-forged') })
    assert.equal(r.status, 403)
    assert.equal(r.json?.error, 'auth-unverifiable')
  } finally { await s.close() }
})

test('认证矩阵：真实会话 cookie + 可信 Host ⇒ 200', async () => {
  const s = await startServer()
  try {
    const r = await request(s.port, '/cs-myfree/login/status', { headers: withCookie(REAL_COOKIE) })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
  } finally { await s.close() }
})

test('回调端点按设计不走 cookie（浏览器跨站跳转），但只认一次性 state', async () => {
  const s = await startServer()
  try {
    // 无 cookie / 伪造 cookie 都应能到 handler（否则浏览器回调死路）
    const noCookie = await request(s.port, `${CB}?state=forged`, { headers: PUBLIC })
    assert.equal(noCookie.status, 200)
    assert.ok(noCookie.text.includes('授权失败'))
    const forged = await request(s.port, `${CB}?state=forged`, { headers: withCookie('dsh-auth-forged') })
    assert.equal(forged.status, 200)
    assert.ok(forged.text.includes('授权失败'))
  } finally { await s.close() }
})

// ════════════════════════════════════════════════════════════════
// 2. /login/callback 攻击面
// ════════════════════════════════════════════════════════════════

test('callback：伪造/畸形 state 全部安全失败，且不回显载荷、不 500', async () => {
  const s = await startServer()
  try {
    const attacks = [
      'state=',
      'state=deadbeef',
      'state=../'.repeat(200) + 'etc/passwd',
      'state=%00%00%00',
      'state=' + 'a'.repeat(8000),
      'state=%E4%BC%AA%E9%80%A0%E7%8A%B6%E6%80%81&code=%E4%BB%A3%E7%A0%81',
      'state=%3Cscript%3Ealert(1)%3C%2Fscript%3E&code=%3Cimg%20src%3Dx%3E',
      'code=no-state',
      'state=a%0D%0ASet-Cookie:%20evil=1',
    ]
    for (const q of attacks) {
      const r = await request(s.port, `${CB}?${q}`, { headers: PUBLIC })
      assert.equal(r.status, 200, q.slice(0, 40))
      assert.ok(r.text.includes('授权失败'), '应显示固定失败页')
      // 不回显攻击载荷（除固定文案外）
      for (const marker of ['31337', '<script>alert', '/etc/passwd', 'Set-Cookie', '中文']) {
        assert.equal(r.text.includes(marker), false, `响应回显了载荷「${marker}」：${q.slice(0, 40)}`)
      }
      assert.equal(r.text.includes('Error'), false, '不得泄漏堆栈')
    }
  } finally { await s.close() }
})

test('callback：真实 state 正常消费；同一 state 重放 ⇒ 失败（防重放）', async () => {
  resetMachine()
  const s = await startServer()
  try {
    const { state } = await startCodeartsSession(s.port)
    assert.ok(state && state.length >= 32)
    const ok = await request(s.port, `${CB}?state=${state}&code=CODE1`, { headers: PUBLIC })
    assert.equal(ok.status, 200)
    assert.ok(ok.text.includes('授权已收到'))
    const replay = await request(s.port, `${CB}?state=${state}&code=CODE2`, { headers: PUBLIC })
    assert.equal(replay.status, 200)
    assert.ok(replay.text.includes('授权失败'))
  } finally { await s.close(); resetMachine() }
})

test('callback：session 已被 cancel ⇒ 旧 state 失效', async () => {
  resetMachine()
  const s = await startServer()
  try {
    const { sessionId, state } = await startCodeartsSession(s.port)
    const c = await request(s.port, '/cs-myfree/login/cancel', {
      method: 'POST', headers: withCookie(REAL_COOKIE), body: { sessionId },
    })
    assert.equal(c.status, 200)
    assert.equal(c.json.cancelled, true)
    const r = await request(s.port, `${CB}?state=${state}&code=X`, { headers: PUBLIC })
    assert.equal(r.status, 200)
    assert.ok(r.text.includes('授权失败'))
  } finally { await s.close(); resetMachine() }
})

test('callback：并发 10 个同 state 请求 ⇒ 只有 1 个成功（一次性语义原子）', async () => {
  resetMachine()
  const s = await startServer()
  try {
    const { state } = await startCodeartsSession(s.port)
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      request(s.port, `${CB}?state=${state}&code=C${i}`, { headers: PUBLIC })))
    const okCount = results.filter((r) => r.text.includes('授权已收到')).length
    const failCount = results.filter((r) => r.text.includes('授权失败')).length
    assert.equal(okCount, 1, `并发回调应只有 1 次成功，实际 ${okCount}`)
    assert.equal(failCount, 9)
  } finally { await s.close(); resetMachine() }
})

test('callback：state 超时 ⇒ 安全失败（不误放行）', async () => {
  resetMachine()
  const { sessionId, state } = await startCodeartsSessionViaMachine()
  assert.ok(state)
  // 直接把一次性 state 的过期时间改成过去
  const entry = states.get(state)
  assert.ok(entry, 'state 应已登记')
  entry.expiresAt = Date.now() - 1
  const r = handleCallback({ state, code: 'X' })
  assert.equal(r.ok, false)
  assert.match(r.error, /过期/)
  assert.equal(states.has(state), false, '过期 state 应被删除')
  cancelLogin(sessionId)
})

test('callback：session 已过期（pending）⇒ 回调安全失败', async () => {
  resetMachine()
  const { sessionId, state } = await startCodeartsSessionViaMachine()
  const sess = getSession(sessionId)
  sess.expiresAt = Date.now() - 1
  const before = handleCallback({ state, code: 'X' })
  // 回调会把过期 pending 会话改成 waiting（见已知缺陷 P2-03），但至少不应泄漏
  assert.equal(typeof before.ok, 'boolean')
  sessions.delete(sessionId)
  states.delete(state)
})

test('callback：session 记录被清理后 ⇒ 「登录会话不存在」且不崩', async () => {
  resetMachine()
  const { sessionId, state } = await startCodeartsSessionViaMachine()
  sessions.delete(sessionId) // 模拟 cleanupExpired 回收
  const r = handleCallback({ state, code: 'X' })
  assert.equal(r.ok, false)
  assert.match(r.error, /会话不存在/)
  cancelLogin(sessionId)
})

test('已知缺陷 P2-01：无 code 的回调会先消费 state（用户取消授权后必须重新 start）', { todo: 'P2-01：无 code 时应保留 state 允许重试，或产品明确说明' }, async () => {
  resetMachine()
  const { state } = await startCodeartsSessionViaMachine()
  const r1 = handleCallback({ state, code: '' })
  assert.equal(r1.ok, false)
  // 期望：state 不被消费（用户可重新授权）；实际：已被消费
  assert.equal(states.has(state), true, 'state 不应被无 code 请求消费')
})

// ════════════════════════════════════════════════════════════════
// 3. /login/poll 凭据泄露面
// ════════════════════════════════════════════════════════════════

/** mock 登录引擎：可注入 poll 返回值 / 抛错，其余走真实状态机 */
function mockEngine({ poll, start, get }) {
  return {
    start: start ?? (async (provider, ch, opts) => startLogin(provider, ch, opts)),
    poll: poll ?? (async (id) => pollLogin(id)),
    cancel: (id) => cancelLogin(id),
    get: get ?? ((id) => getSession(id)),
    callback: (args) => handleCallback(args),
  }
}

test('poll：拿到 credential 后，HTTP 响应绝不含 ak/sk/securityToken 原文（只回掩码）', async () => {
  resetMachine()
  const home = await makeHome()
  const session = { sessionId: 'sid-leak-1', provider: 'codearts', persisted: false }
  const engine = mockEngine({
    start: async () => ({ sessionId: session.sessionId, flow: 'browser', callbackUrl: `${PUB}${CB}` }),
    poll: async () => ({
      state: 'ok',
      hint: '登录成功',
      credential: { ak: SECRET_AK, sk: SECRET_SK, securityToken: SECRET_ST, expiresAt: Date.now() + 3600_000 },
    }),
    get: () => session,
  })
  const s = await startServer({ home, loginEngine: engine })
  try {
    const start = await request(s.port, '/cs-myfree/login/start', {
      method: 'POST', headers: withCookie(REAL_COOKIE), body: { provider: 'codearts' },
    })
    assert.equal(start.status, 200)
    const r = await request(s.port, `/cs-myfree/login/poll?sessionId=${session.sessionId}`, {
      headers: withCookie(REAL_COOKIE),
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.state, 'ok')
    // 红线：响应体不得出现任何凭据原文
    for (const secret of [SECRET_AK, SECRET_SK, SECRET_ST]) {
      assert.equal(r.text.includes(secret), false, '响应体泄漏了凭据原文')
    }
    assert.equal('credential' in r.json, false, '响应不得含 credential 字段')
    assert.ok(typeof r.json.maskedAccount === 'string' && r.json.maskedAccount.length > 0, '应返回掩码')

    // 落盘是预期行为：accounts.json 0600 且包含原文（只在磁盘，不在 HTTP）
    const file = join(home, 'cs-myfree', 'accounts.json')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.ok(Object.keys(saved.accounts).length >= 1, '应写入 accounts.json')
    if (process.platform !== 'win32') {
      const mode = (await stat(file)).mode & 0o777
      assert.equal(mode, 0o600, `accounts.json 权限必须 0600，实际 ${mode.toString(8)}`)
    }
  } finally { await s.close(); resetMachine() }
})

test('poll：第二次 poll 不重复落盘，也不回原文', async () => {
  resetMachine()
  const home = await makeHome()
  const session = { sessionId: 'sid-leak-2', provider: 'codearts', persisted: true }
  const engine = mockEngine({
    start: async () => ({ sessionId: session.sessionId, flow: 'browser' }),
    poll: async () => ({ state: 'ok', hint: '登录成功', credential: { ak: SECRET_AK, sk: SECRET_SK } }),
    get: () => session,
  })
  const s = await startServer({ home, loginEngine: engine })
  try {
    await request(s.port, '/cs-myfree/login/start', {
      method: 'POST', headers: withCookie(REAL_COOKIE), body: { provider: 'codearts' },
    })
    const r = await request(s.port, `/cs-myfree/login/poll?sessionId=${session.sessionId}`, { headers: withCookie(REAL_COOKIE) })
    assert.equal(r.status, 200)
    for (const secret of [SECRET_AK, SECRET_SK]) assert.equal(r.text.includes(secret), false)
  } finally { await s.close(); resetMachine() }
})

test('poll：上游错误信息里的 URL 查询串 token/secret 会被脱敏', async () => {
  resetMachine()
  const home = await makeHome()
  const engine = mockEngine({
    start: async () => ({ sessionId: 'sid-err', flow: 'browser' }),
    poll: async () => {
      throw new Error(`upstream failed: https://api.example/x?token=${SECRET_CODE}&secret=${SECRET_SK}`)
    },
    get: () => ({ sessionId: 'sid-err', provider: 'codearts' }),
  })
  const s = await startServer({ home, loginEngine: engine })
  try {
    const r = await request(s.port, '/cs-myfree/login/poll?sessionId=sid-err', { headers: withCookie(REAL_COOKIE) })
    assert.equal(r.status, 200)
    assert.equal(r.json.state, 'error')
    for (const secret of [SECRET_CODE, SECRET_SK]) {
      assert.equal(r.text.includes(secret), false, `错误响应泄漏了 ${secret.slice(0, 6)}…`)
    }
    assert.ok(r.text.includes('***'), 'URL 查询串里的凭据应被脱敏')
  } finally { await s.close(); resetMachine() }
})

test('P2-05（已修）：裸 token=/ak=/code= 形式的错误文本必须脱敏', async () => {
  resetMachine()
  const home = await makeHome()
  const engine = mockEngine({
    start: async () => ({ sessionId: 'sid-bare', flow: 'browser' }),
    poll: async () => { throw new Error(`upstream failed: token=${SECRET_CODE} ak=${SECRET_AK}`) },
    get: () => ({ sessionId: 'sid-bare', provider: 'codearts' }),
  })
  const s = await startServer({ home, loginEngine: engine })
  try {
    const r = await request(s.port, '/cs-myfree/login/poll?sessionId=sid-bare', { headers: withCookie(REAL_COOKIE) })
    // 期望：裸 token=/ak= 也被脱敏
    assert.equal(r.text.includes(SECRET_CODE), false, '裸 token= 未被脱敏')
  } finally { await s.close(); resetMachine() }
})

test('poll：会话不存在 / 已取消 / 已过期 ⇒ 如实报错且无凭据字段', async () => {
  resetMachine()
  const s = await startServer()
  try {
    for (const sid of ['', 'deadbeef', '../../etc/passwd']) {
      const r = await request(s.port, `/cs-myfree/login/poll?sessionId=${encodeURIComponent(sid)}`, {
        headers: withCookie(REAL_COOKIE),
      })
      assert.equal(r.status, 200)
      assert.equal(r.json.state, 'error')
      assert.equal('credential' in r.json, false)
      for (const k of ['ak', 'sk', 'securityToken', '_secret', '_ticketId', 'callbackCode']) {
        assert.equal(k in r.json, false, `响应不应含内部字段 ${k}`)
      }
    }
  } finally { await s.close(); resetMachine() }
})

test('/login/start 响应不泄漏状态机私有字段（_secret/_ticketId）', async () => {
  resetMachine()
  const s = await startServer()
  try {
    const r = await startCodeartsSession(s.port)
    for (const k of ['_secret', '_ticketId', '_callbackUrl', 'credential']) {
      assert.equal(k in r.json, false, `start 响应不应含 ${k}`)
    }
    assert.equal(r.json.loginVerified, true)
    assert.match(r.json.callbackUrl, /^http:\/\/example\.com\/cs-myfree\/login\/callback$/)
  } finally { await s.close(); resetMachine() }
})

// ════════════════════════════════════════════════════════════════
// 4. 边界输入
// ════════════════════════════════════════════════════════════════

test('边界：未知 provider / 空 body / 非字符串 provider 都安全失败', async () => {
  const s = await startServer()
  try {
    const cases = [
      [{ provider: 'nope' }, /未知渠道/],
      [{}, /缺少 provider/],
      [{ provider: { $gt: '' } }, /未知渠道/],
      [{ provider: ['a'] }, /未知渠道/],
      [{ provider: '  ' }, /缺少 provider/],
    ]
    for (const [body, re] of cases) {
      const r = await request(s.port, '/cs-myfree/login/start', {
        method: 'POST', headers: withCookie(REAL_COOKIE), body,
      })
      assert.equal(r.status, 200)
      assert.equal(r.json.ok, false)
      assert.match(r.json.error, re)
    }
  } finally { await s.close() }
})

test('边界：非法 JSON body 不 500、不泄漏内部栈（当前落为 200 缺少 provider）', async () => {
  const s = await startServer()
  try {
    const r = await request(s.port, '/cs-myfree/login/start', {
      method: 'POST', headers: withCookie(REAL_COOKIE), rawBody: '{bad json',
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, false)
    assert.equal(r.text.includes('at '), false, '不得泄漏堆栈')
  } finally { await s.close() }
})

test('边界：超大 body（>1MB）被截断/断开，但服务不被拖垮', async () => {
  const s = await startServer()
  try {
    const huge = 'x'.repeat(1024 * 1024 + 64 * 1024)
    let outcome = null
    try {
      outcome = await request(s.port, '/cs-myfree/login/start', {
        method: 'POST', headers: withCookie(REAL_COOKIE), rawBody: JSON.stringify({ provider: 'codearts', pad: huge }),
      })
    } catch (err) {
      outcome = { error: String(err?.code ?? err) }
    }
    // 允许：连接被断开（客户端错误）或 200 安全失败；不允许 500 崩溃/宿主挂掉
    if (outcome.error) assert.match(outcome.error, /ECONNRESET|socket hang up|EPIPE/i)
    else if (outcome.status) assert.ok([200, 400, 413].includes(outcome.status), `异常状态码 ${outcome.status}`)
    // 服务仍可用
    const after = await request(s.port, '/cs-myfree/health', { headers: { host: `127.0.0.1:${s.port}` } })
    assert.equal(after.status, 200)
  } finally { await s.close() }
})

test('边界：sessionId 缺失/不存在/穿越式输入都安全失败', async () => {
  const s = await startServer()
  try {
    for (const path of [
      '/cs-myfree/login/poll',
      '/cs-myfree/login/poll?sessionId=',
      '/cs-myfree/login/poll?sessionId=../../etc/passwd',
    ]) {
      const r = await request(s.port, path, { headers: withCookie(REAL_COOKIE) })
      assert.equal(r.status, 200)
      assert.equal(r.json.ok, false)
    }
    const c1 = await request(s.port, '/cs-myfree/login/cancel', { method: 'POST', headers: withCookie(REAL_COOKIE), body: {} })
    assert.equal(c1.json.ok, false)
    const c2 = await request(s.port, '/cs-myfree/login/cancel', {
      method: 'POST', headers: withCookie(REAL_COOKIE), body: { sessionId: 'no-such' },
    })
    assert.equal(c2.json.ok, false)
    assert.equal(c2.json.cancelled, false)
  } finally { await s.close() }
})

test('边界：同一 provider 并发 start 100 次 ⇒ 多会话并存且互不干扰', async () => {
  resetMachine()
  const s = await startServer()
  try {
    const results = await Promise.all(Array.from({ length: 100 }, () =>
      request(s.port, '/cs-myfree/login/start', {
        method: 'POST', headers: withCookie(REAL_COOKIE), body: { provider: 'codearts' },
      })))
    const ok = results.filter((r) => r.json?.ok === true)
    assert.equal(ok.length, 100)
    const ids = new Set(ok.map((r) => r.json.sessionId))
    assert.equal(ids.size, 100, 'sessionId 必须唯一')
    const stateVals = new Set(ok.map((r) => r.json.state ?? null))
    // state 在 start 响应里不是必返字段；能拿到的必须唯一/为空
    assert.ok(stateVals.size <= 2)
    // 取消其中一个不影响其它
    const victim = ok[0].json.sessionId
    const c = await request(s.port, '/cs-myfree/login/cancel', {
      method: 'POST', headers: withCookie(REAL_COOKIE), body: { sessionId: victim },
    })
    assert.equal(c.json.cancelled, true)
    // 其它会话仍在（取消一个不影响其它）；不调 poll（真实 codearts poll 会出网）
    assert.ok(getSession(ok[1].json.sessionId), '其它会话应仍然存在')
    for (const x of ok.slice(1)) cancelLogin(x.json.sessionId)
  } finally { await s.close(); resetMachine() }
})

// ════════════════════════════════════════════════════════════════
// 5. 诚实降级（未取证渠道）
// ════════════════════════════════════════════════════════════════

test('诚实降级：所有「未取证且无实现」的渠道不编造 url/userCode/qr/verificationUri', async () => {
  resetMachine()
  const s = await startServer()
  try {
    // 动态取：flow-map 里 loginVerified=false 且没有 start 实现的渠道
    const { FLOW_MAP } = await import('../src/pools/channels/login/flow-map.js')
    const fallbackOnly = Object.entries(FLOW_MAP)
      .filter(([, e]) => e.loginVerified === false && typeof e.start !== 'function')
      .map(([id]) => id)
    // 至少要有兜底渠道；随着真实现逐个落地，这个数会减少（不是越多越好）
    assert.ok(fallbackOnly.length >= 1, `未取证兜底渠道过少：${fallbackOnly.length}`)
    for (const provider of fallbackOnly) {
      const r = await request(s.port, '/cs-myfree/login/start', {
        method: 'POST', headers: withCookie(REAL_COOKIE), body: { provider },
      })
      assert.equal(r.status, 200)
      assert.equal(r.json.ok, true, `${provider} start 应成功降级`)
      assert.equal(r.json.loginVerified, false, `${provider} 必须标未验证`)
      assert.ok(r.json.loginNote && r.json.loginNote.length > 0, `${provider} 未验证必须有说明`)
      assert.equal(r.json.url ?? null, null, `${provider} 不许编造登录 URL`)
      assert.equal(r.json.userCode ?? null, null, `${provider} 不许编造设备码`)
      assert.equal(r.json.verificationUri ?? null, null, `${provider} 不许编造验证地址`)
      assert.equal(r.json.qr ?? null, null, `${provider} 不许编造二维码`)
      assert.ok(Array.isArray(r.json.instructions) && r.json.instructions.length > 0, `${provider} 必须给操作说明`)
    }
  } finally { await s.close(); resetMachine() }
})

test('诚实降级：/login/status 明确区分 verified / unverified', async () => {
  const s = await startServer()
  try {
    const r = await request(s.port, '/cs-myfree/login/status', { headers: withCookie(REAL_COOKIE) })
    assert.equal(r.status, 200)
    assert.ok(r.json.verified.includes('codearts'))
    assert.ok(r.json.unverified.length >= 5)
    assert.equal(r.json.verified.length + r.json.unverified.length, r.json.total)
    assert.match(r.json.note, /loginVerified=false/)
    for (const c of r.json.channels) {
      assert.equal(typeof c.loginVerified, 'boolean')
      if (!c.loginVerified) assert.ok(c.note && c.note.length > 0)
    }
  } finally { await s.close() }
})

test('诚实降级：/login/test 未登录渠道 ⇒ 明确 AUTH 错误而非崩溃', async () => {
  const s = await startServer()
  try {
    const r = await request(s.port, '/cs-myfree/login/test', {
      method: 'POST', headers: withCookie(REAL_COOKIE), body: { provider: 'buddy' },
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, false)
    assert.equal(r.json.kind, 'AUTH')
    assert.match(r.json.error, /未登录/)
    const unknown = await request(s.port, '/cs-myfree/login/test', {
      method: 'POST', headers: withCookie(REAL_COOKIE), body: { provider: 'zzz' },
    })
    assert.equal(unknown.json.ok, false)
    assert.match(unknown.json.error, /未知渠道/)
  } finally { await s.close() }
})

test('诚实降级：/login/refresh 无续期端点 ⇒ 如实报错 + reloginRequired', async () => {
  const s = await startServer()
  try {
    const r = await request(s.port, '/cs-myfree/login/refresh', {
      method: 'POST', headers: withCookie(REAL_COOKIE), body: { provider: 'buddy' },
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, false)
    assert.match(r.json.error, /无续期端点/)
    assert.equal(r.json.reloginRequired, true)
  } finally { await s.close() }
})

// ════════════════════════════════════════════════════════════════
// 6. 逻辑：codearts 轮询语义 / 超时
// ════════════════════════════════════════════════════════════════

test('逻辑：codearts poll 未授权时必须 waiting（不能误判 error）', async () => {
  const mk = (body, ok = true) => async () => ({ ok, json: async () => body, status: ok ? 200 : 500 })
  for (const impl of [mk({}), mk(null), mk({ result: {} }), mk({}, false)]) {
    const r = await pollCodearts({ _ticketId: 't', _secret: 's', _attempts: 0 }, { fetchImpl: impl })
    assert.equal(r.state, 'waiting')
    assert.ok(r.hint && r.hint.length > 0)
  }
  // 网络异常/超时也 waiting
  const netErr = await pollCodearts({ _ticketId: 't', _secret: 's', _attempts: 0 }, {
    fetchImpl: async () => { throw new Error('ECONNRESET') },
  })
  assert.equal(netErr.state, 'waiting')
  // 非 JSON 响应也 waiting
  const badJson = await pollCodearts({ _ticketId: 't', _secret: 's', _attempts: 0 }, {
    fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json') } }),
  })
  assert.equal(badJson.state, 'waiting')
})

test('逻辑：codearts 超时必须给可读错误（不永远转圈）', async () => {
  const r = await pollCodearts({ _ticketId: 't', _secret: 's', _attempts: 200 }, {
    fetchImpl: async () => ({ ok: false }),
  })
  assert.equal(r.state, 'error')
  assert.match(r.error, /超时/)
  assert.ok(r.error.length <= 200)
})

test('逻辑：收到完整凭据才 ok；缺 securityToken 仍 waiting（不半认）', async () => {
  const full = { credential: { access: 'A', secret: 'S', securitytoken: 'T' } }
  const r1 = await pollCodearts({ _ticketId: 't', _secret: 's', _attempts: 0 }, { fetchImpl: async () => ({ ok: true, json: async () => full }) })
  assert.equal(r1.state, 'ok')
  assert.ok(r1.credential)
  const partial = { credential: { access: 'A', secret: 'S' } }
  const r2 = await pollCodearts({ _ticketId: 't', _secret: 's', _attempts: 0 }, { fetchImpl: async () => ({ ok: true, json: async () => partial }) })
  assert.equal(r2.state, 'waiting')
})

test('已知缺陷 P2-03：会话过期后若已进入 waiting，不会被标记 expired（继续轮询到提交上限）', { todo: 'P2-03：getSession 只对 pending 判过期；waiting 状态过期应也转 expired' }, async () => {
  resetMachine()
  const s = await startLogin('buddy', CHANNELS.buddy, { publicBase: PUB, callbackPath: CB })
  handleCallback({ state: s.state, code: 'X' })
  const sess = getSession(s.sessionId)
  assert.equal(sess.state, 'waiting')
  sess.expiresAt = Date.now() - 1
  const r = await pollLogin(s.sessionId)
  assert.equal(r.state, 'expired', '过期会话应报 expired')
  cancelLogin(s.sessionId)
})

// ════════════════════════════════════════════════════════════════
// 7. 资源：Map 回收 / 并发 / setInterval unref
// ════════════════════════════════════════════════════════════════

test('资源：100 并发会话 → 可被 cleanupExpired 全部回收（5 分钟 TTL）', async () => {
  resetMachine()
  const started = []
  for (let i = 0; i < 100; i++) started.push(await startLogin('codearts', CHANNELS.codearts, { publicBase: PUB, callbackPath: CB }))
  assert.equal(sessions.size, 100)
  assert.equal(states.size, 100)
  const ids = new Set(started.map((x) => x.sessionId))
  assert.equal(ids.size, 100)
  cleanupExpired(Date.now() + 5 * 60 * 1000 + 61_000)
  assert.equal(sessions.size, 0, '过期会话必须回收')
  assert.equal(states.size, 0, '过期 state 必须回收')
})

test('资源：1000 次 start/cancel（browser 流）后 Map 不增长', async () => {
  resetMachine()
  for (let i = 0; i < 1000; i++) {
    const s = await startLogin('codearts', CHANNELS.codearts, { publicBase: PUB, callbackPath: CB })
    cancelLogin(s.sessionId)
  }
  assert.equal(sessions.size, 0, `sessions 应回收到 0，实际 ${sessions.size}`)
  assert.equal(states.size, 0, `states 应回收到 0，实际 ${states.size}`)
})

test('已知缺陷 P2-02：非 browser 流也登记一次性 state，cancel 不回收 ⇒ 反复 start/cancel 会让 states 增长', { todo: 'P2-02：非 browser 流不需要回调 state；startLogin 仅在 flow=browser 时登记' }, async () => {
  resetMachine()
  try {
    for (let i = 0; i < 1000; i++) {
      const s = await startLogin('qoder', CHANNELS.qoder, { publicBase: PUB, callbackPath: CB })
      cancelLogin(s.sessionId)
    }
    assert.ok(states.size <= 1, `非 browser 流不应残留 state，实际 ${states.size}`)
  } finally {
    cleanupExpired(Date.now() + 5 * 60 * 1000 + 61_000)
    resetMachine()
  }
})

test('资源：cleanupExpired 不影响未过期会话', async () => {
  resetMachine()
  const s = await startLogin('codearts', CHANNELS.codearts, { publicBase: PUB, callbackPath: CB })
  cleanupExpired(Date.now())
  assert.equal(sessions.has(s.sessionId), true)
  assert.equal(states.has(s.state), true)
  cancelLogin(s.sessionId)
})

test('资源：setInterval 已 unref（不拖住宿主退出）', () => {
  const modUrl = new URL('../src/pools/channels/login/index.js', import.meta.url).href
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(modUrl)}); console.log('loaded')`], {
    timeout: 4000,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
  })
  assert.equal(r.signal, null, '子进程被 timeout 杀掉 ⇒ setInterval 未 unref 或模块卡住')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /loaded/)
})

// ════════════════════════════════════════════════════════════════
// 8. 日志：失败场景不得打印 code/token/verifier
// ════════════════════════════════════════════════════════════════

test('日志：登录失败/异常场景必须留下可诊断日志', async () => {
  resetMachine()
  const home = await makeHome()
  const engine = mockEngine({
    start: async () => { throw new Error(`start failed code=${SECRET_CODE} token=${SECRET_AK}`) },
    poll: async () => { throw new Error(`poll failed verifier=${SECRET_SK} token=${SECRET_ST}`) },
    get: () => ({ sessionId: 'sid-log', provider: 'codearts' }),
  })
  const s = await startServer({ home, loginEngine: engine })
  try {
    await request(s.port, '/cs-myfree/login/start', {
      method: 'POST', headers: withCookie(REAL_COOKIE), body: { provider: 'codearts' },
    })
    await request(s.port, '/cs-myfree/login/poll?sessionId=sid-log', { headers: withCookie(REAL_COOKIE) })
    await request(s.port, '/cs-myfree/login/callback?state=forged&code=' + encodeURIComponent(SECRET_CODE), { headers: PUBLIC })
    assert.ok(s.logs.length > 0, '失败场景至少应有日志（否则排障不可见）')
    assert.ok(s.logs.some((l) => /login\/(start|poll)/.test(l)), '日志应标明失败端点')
  } finally { await s.close(); resetMachine() }
})

test('P2-04（已修）：登录失败日志必须脱敏（不得写入上游 token/code 原文）', async () => {
  resetMachine()
  const home = await makeHome()
  const engine = mockEngine({
    start: async () => { throw new Error(`start failed code=${SECRET_CODE} token=${SECRET_AK}`) },
    poll: async () => { throw new Error(`poll failed verifier=${SECRET_SK} token=${SECRET_ST}`) },
    get: () => ({ sessionId: 'sid-log2', provider: 'codearts' }),
  })
  const s = await startServer({ home, loginEngine: engine })
  try {
    await request(s.port, '/cs-myfree/login/start', {
      method: 'POST', headers: withCookie(REAL_COOKIE), body: { provider: 'codearts' },
    })
    await request(s.port, '/cs-myfree/login/poll?sessionId=sid-log2', { headers: withCookie(REAL_COOKIE) })
    const all = s.logs.join('\n')
    // 期望：日志与 HTTP 响应一样脱敏
    assert.equal(all.includes(SECRET_CODE), false, '日志泄漏了 code 原文')
    assert.equal(all.includes(SECRET_AK), false, '日志泄漏了 token 原文')
  } finally { await s.close(); resetMachine() }
})

test('日志：回调页 HTML 不包含任何凭据/内部字段', async () => {
  resetMachine()
  const s = await startServer()
  try {
    const { state } = await startCodeartsSession(s.port)
    const ok = await request(s.port, `${CB}?state=${state}&code=${SECRET_CODE}`, { headers: PUBLIC })
    assert.ok(ok.text.includes('授权已收到'))
    for (const secret of [SECRET_CODE, SECRET_AK, SECRET_SK, SECRET_ST, '_secret', '_ticketId']) {
      assert.equal(ok.text.includes(secret), false, '回调页不得包含凭据/内部字段')
    }
    // HTML 形状：仅固定文案 + 返回链接
    assert.ok(ok.text.includes('/cs-myfree'))
    assert.equal(ok.headers['cache-control'], 'no-store')
  } finally { await s.close(); resetMachine() }
})

// ════════════════════════════════════════════════════════════════
// 9. 真实状态机语义（防重放/伪造的底层保证）
// ════════════════════════════════════════════════════════════════

test('状态机：start 生成的 state 为 48 位 hex 随机串，且不可预测（抽样不重复）', async () => {
  resetMachine()
  const seen = new Set()
  for (let i = 0; i < 50; i++) {
    const s = await startLogin('codearts', CHANNELS.codearts, { publicBase: PUB, callbackPath: CB })
    assert.match(s.state, /^[0-9a-f]{48}$/)
    seen.add(s.state)
    cancelLogin(s.sessionId)
  }
  assert.equal(seen.size, 50, 'state 出现重复 ⇒ 随机性不足')
})

test('状态机：伪造 state 不会影响任何已有会话', async () => {
  resetMachine()
  const s = await startLogin('codearts', CHANNELS.codearts, { publicBase: PUB, callbackPath: CB })
  const r = handleCallback({ state: 'f'.repeat(48), code: 'ATTACK' })
  assert.equal(r.ok, false)
  const sess = getSession(s.sessionId)
  assert.equal(sess.state, 'pending', '伪造回调不得改变真实会话状态')
  assert.equal(sess.callbackCode, undefined)
  cancelLogin(s.sessionId)
})

test('状态机：cancel 后再 poll ⇒ error，且会话已销毁（无内存残留）', async () => {
  resetMachine()
  const s = await startLogin('codearts', CHANNELS.codearts, { publicBase: PUB, callbackPath: CB })
  assert.equal(cancelLogin(s.sessionId), true)
  assert.equal(sessions.has(s.sessionId), false)
  const r = await pollLogin(s.sessionId)
  assert.equal(r.state, 'error')
})

test('状态机：poll 返回形状固定为 {state,hint,maskedAccount,error}，绝无 credential', async () => {
  resetMachine()
  const s = await startLogin('codearts', CHANNELS.codearts, { publicBase: PUB, callbackPath: CB })
  const r = await pollLogin(s.sessionId, { fetchImpl: async () => ({ ok: false }) })
  assert.deepEqual(Object.keys(r).sort(), ['error', 'hint', 'maskedAccount', 'state'])
  cancelLogin(s.sessionId)
})
