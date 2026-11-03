/**
 * 路由安全围栏回归（认证绕过漏洞，与 cs-guard v1.8.0 同源）
 *
 * 🔴 真实漏洞：旧 judge() 只看 Cookie 名字是否以 `dsh-auth-` 开头、**不验签**
 *    ⇒ `Cookie: dsh-auth-forged` + 公网 Host 就能读写 /cs-myfree/*（生产实测 200）。
 *
 * v1.9.0 判据：
 *   ① Origin 同源（防 CSRF）
 *   ② 回环 + localhost 直连放行（本机管理员）
 *   ③ 其余委托宿主 connection.requestRejection（验签/会话/可信 Host）
 *   ④ 拿不到 connection ⇒ **fail-closed**（绝不按 cookie 名放行）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  judge, isLoopbackAddr, isLocalHostHeader, isTrustedHostHeader, hasAuthCookie,
  safeGetConnection, verifySession, redactText, hostNameOf,
} from '../src/web/guard.js'
import { registerRoutes, PREFIX } from '../src/web/routes.js'

const req = ({ host = 'localhost', origin, cookie, addr = '127.0.0.1', method = 'GET' } = {}) => ({
  method,
  headers: {
    ...(host === undefined ? {} : { host }),
    ...(origin === undefined ? {} : { origin }),
    ...(cookie === undefined ? {} : { cookie }),
  },
  socket: { remoteAddress: addr },
})

/** 假宿主 connection：只有特定 cookie 验签通过 */
const fakeConnection = (validCookie) => ({
  requestRejection(r) {
    const cookie = r.headers?.cookie ?? ''
    if (cookie === validCookie) return undefined   // 放行
    if (!cookie) return 401
    return 403
  },
})

// ── 纯 judge 矩阵 ──

test('回环 + localhost 直连放行（本机管理不受影响）', () => {
  assert.equal(judge(req(), {}).ok, true)
  assert.equal(judge(req({ host: '127.0.0.1:3080' }), {}).ok, true)
  assert.equal(judge(req({ addr: '::1', host: '[::1]:3080' }), {}).ok, true)
  assert.equal(isLocalHostHeader('[::1]:3080'), true)
  assert.equal(hostNameOf('[2001:db8::1]:443'), '2001:db8::1')
})

test('🔴 回归：伪造 dsh-auth-* cookie + 公网 Host，且拿不到 connection ⇒ fail-closed 403', () => {
  const v = judge(req({ host: 'example.com', cookie: 'dsh-auth-forged' }), {})
  assert.equal(v.ok, false)
  assert.equal(v.status, 403)
  assert.equal(v.reason, 'auth-unverifiable')
})

test('🔴 回归：伪造 cookie + 可信 Host + 回环（nginx 反代场景）⇒ 仍拒绝', () => {
  const v = judge(req({ host: '150.158.175.241', cookie: 'dsh-auth-forged', addr: '127.0.0.1' }), {
    trustedHosts: ['150.158.175.241'],
  })
  assert.equal(v.ok, false)
  assert.equal(v.status, 403)
})

test('无 cookie + 公网 Host ⇒ 403（401 由 connection 决定）', () => {
  const v = judge(req({ host: 'example.com', addr: '8.8.8.8' }))
  assert.equal(v.ok, false)
  assert.equal(v.status, 403)
})

test('委托 connection：真实有效会话 ⇒ 放行', () => {
  const conn = fakeConnection('dsh-auth-abc=v2.sig')
  assert.equal(judge(req({ host: 'example.com', cookie: 'dsh-auth-abc=v2.sig' }), { getConnection: () => conn }).ok, true)
})

test('委托 connection：伪造 cookie ⇒ 403；无 cookie ⇒ 401', () => {
  const conn = fakeConnection('dsh-auth-real=v2.sig')
  assert.equal(judge(req({ host: 'example.com', cookie: 'dsh-auth-forged' }), { getConnection: () => conn }).status, 403)
  assert.equal(judge(req({ host: 'example.com' }), { getConnection: () => conn }).status, 401)
})

test('Origin 不同源 ⇒ 403（防 CSRF，优先于一切）', () => {
  const v = judge(req({ host: 'example.com', origin: 'https://evil.com' }))
  assert.equal(v.ok, false)
  assert.equal(v.status, 403)
  assert.equal(v.reason, 'cross-origin')
})

test('connection 抛错 ⇒ 403（auth-check-failed，不放行）', () => {
  const conn = { requestRejection() { throw new Error('boom') } }
  const v = judge(req({ host: 'example.com', cookie: 'dsh-auth-x' }), { getConnection: () => conn })
  assert.equal(v.ok, false)
  assert.equal(v.status, 403)
  assert.equal(v.reason, 'auth-check-failed')
})

test('safeGetConnection 拿不到服务返回 null（不抛）', () => {
  assert.equal(safeGetConnection(undefined), null)
  assert.equal(safeGetConnection(() => { throw new Error('x') }), null)
  assert.equal(safeGetConnection(() => ({})), null)
})

test('hasAuthCookie 只作诊断，不参与放行', () => {
  assert.equal(hasAuthCookie(req({ cookie: 'dsh-auth-x' })), true)
  assert.equal(hasAuthCookie(req({ cookie: 'other=1' })), false)
})

test('redactText：token/Bearer/AKID 都脱敏', () => {
  const s = redactText('GET /cb?code=SECRET123&x=1 Authorization: Bearer abcdefghijklmnop AKIDABCDEFGHIJKLMNOP')
  assert.equal(s.includes('SECRET123'), false)
  assert.equal(s.includes('abcdefghijklmnop'), false)
  assert.equal(s.includes('AKIDABCDEFGHIJKLMNOP'), false)
})

// ── 路由层矩阵（真实 handler + 注入的 connection）──

function makeServer() {
  const routes = new Map()
  return { register: (r) => routes.set(String(r.path).replace(PREFIX, ''), r), get: (p) => routes.get(p) }
}
async function call(server, path, { method = 'GET', body, host = 'localhost:3080', cookie, addr = '127.0.0.1' } = {}) {
  const r = server.get(path)
  if (!r) throw new Error('no route ' + path)
  const res = { writeHead: (s) => { res._status = s }, end: (b) => { try { res._body = JSON.parse(b) } catch { res._body = b } } }
  const reqObj = {
    method,
    url: PREFIX + path,
    headers: { host, ...(cookie ? { cookie } : {}) },
    socket: { remoteAddress: addr },
    on: (ev, cb) => { if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body))); if (ev === 'end') cb() },
  }
  await r.handler(reqObj, res)
  return { status: res._status, body: res._body }
}

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'cs-myfree-guard-'))
  try { return await fn(home) } finally {
    for (let i = 0; i < 6; i++) { try { await rm(home, { recursive: true, force: true }); break } catch { await new Promise((r) => setTimeout(r, 50)) } }
  }
}

test('🔴 路由：公网 Host + 伪造 cookie ⇒ 403（GET /state 与 POST /config 都拒，文件未变）', async () => {
  await withHome(async (home) => {
    const srv = makeServer()
    const conn = fakeConnection('dsh-auth-real=v2.sig')
    registerRoutes(srv, {
      state: { readChain: async (d) => d, readProbe: async (d) => d, overview: async () => ({ exists: true, dir: home, files: [] }) },
      version: 'test',
      trustedHosts: ['150.158.175.241'],
      getConnection: () => conn,
      getChain: () => [],
      getConfig: () => ({}),
      setConfig: async () => true,
      fetchImpl: async () => ({ ok: true, json: async () => ({ is_available: false }) }),
    })
    const g = await call(srv, '/state', { host: '150.158.175.241', cookie: 'dsh-auth-forged' })
    assert.equal(g.status, 403, '伪造 cookie 读状态必须 403')
    const p = await call(srv, '/config', { method: 'POST', body: { vision: { mode: 'off' } }, host: '150.158.175.241', cookie: 'dsh-auth-forged' })
    assert.equal(p.status, 403, '伪造 cookie 写配置必须 403')
    // 真实会话 ⇒ 200
    const ok = await call(srv, '/state', { host: '150.158.175.241', cookie: 'dsh-auth-real=v2.sig' })
    assert.equal(ok.status, 200, '真实会话必须 200')
    // 无 cookie ⇒ 401（connection 判定）
    const noCookie = await call(srv, '/state', { host: '150.158.175.241' })
    assert.equal(noCookie.status, 401)
    // 直连 localhost ⇒ 200（本地管理不受影响）
    const local = await call(srv, '/state', { host: 'localhost:3080' })
    assert.equal(local.status, 200)
    // 拿不到 connection ⇒ 伪造 cookie fail-closed
    const srv2 = makeServer()
    registerRoutes(srv2, {
      state: { readChain: async (d) => d, readProbe: async (d) => d, overview: async () => ({ exists: true, dir: home, files: [] }) },
      version: 'test', trustedHosts: ['150.158.175.241'], getConnection: null,
      getChain: () => [], getConfig: () => ({}), setConfig: async () => true,
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    })
    const f = await call(srv2, '/state', { host: '150.158.175.241', cookie: 'dsh-auth-forged' })
    assert.equal(f.status, 403, '无 connection 服务时 fail-closed')
  })
})
