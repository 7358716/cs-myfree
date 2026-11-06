/**
 * HTTP API 测试 —— 用假 webServer 捕获注册，再用假 req/res 调 handler
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerRoutes, PREFIX, PROBE_TTL_MS } from '../src/web/routes.js'

/** 采集注册的路由 */
function makeServer() {
  const routes = new Map()
  return {
    register: (r) => routes.set(r.path.replace(PREFIX, ''), r),
    get: (p) => routes.get(p),
    size: () => routes.size,
  }
}

/** 造一个假 req/res 调用 handler */
async function call(server, path, { method = 'GET', body, headers = {}, remote = '127.0.0.1' } = {}) {
  const r = server.get(path)
  if (!r) throw new Error('no route ' + path)
  const chunks = []
  const res = {
    writeHead: (s, h) => { res._status = s; res._headers = h },
    end: (body) => { try { res._body = JSON.parse(body) } catch { res._body = body } },
  }
  const req = {
    method,
    url: PREFIX + path,
    headers: Object.assign({ host: 'localhost:3080' }, headers),
    socket: { remoteAddress: remote },
    on: (ev, cb) => {
      if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
      if (ev === 'end') cb()
    },
  }
  await r.handler(req, res)
  return { status: res._status, body: res._body }
}

function makeState(init = {}) {
  const store = { config: init.config ?? {}, chain: init.chain ?? { chain: [] }, probe: init.probe ?? null }
  return {
    readConfig: async (d) => store.config ?? d,
    writeConfig: async (v) => { store.config = v; return true },
    readChain: async (d) => store.chain ?? d,
    writeChain: async (v) => { store.chain = v; return true },
    readProbe: async (d) => store.probe ?? d,
    writeProbe: async (v) => { store.probe = v; return true },
    overview: async () => ({ exists: true, dir: '/tmp/x', files: [] }),
    _store: store,
  }
}

const base = () => ({ state: makeState(), version: 'test', trustedHosts: [], getChain: () => [], getConfig: () => ({}), fetchImpl: async () => ({ ok: true, json: async () => ({ is_available: true, balance_infos: [] }) }) })

test('注册了预期的路由条数', () => {
  const srv = makeServer()
  const n = registerRoutes(srv, base())
  assert.ok(n >= 8, '至少 8 条路由')
  for (const p of ['/health', '/state', '/chain', '/probe', '/models', '/config', '/diag', '/ledger']) {
    assert.ok(srv.get(p), '缺少 ' + p)
  }
})
test('/health 可达', async () => {
  const srv = makeServer(); registerRoutes(srv, base())
  const r = await call(srv, '/health')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.plugin, 'cs-myfree')
})
test('🔴 外部无 cookie ⇒ 403', async () => {
  const srv = makeServer(); registerRoutes(srv, base())
  const r = await call(srv, '/health', { remote: '8.8.8.8', headers: { host: 'evil.com' } })
  assert.equal(r.status, 403)
})
test('/state 返回源与链概览', async () => {
  const srv = makeServer(); registerRoutes(srv, base())
  const r = await call(srv, '/state')
  assert.equal(r.status, 200)
  assert.equal(r.body.sources.counts.channels, 20)
  assert.ok(r.body.chain)
})
test('/chain GET 返回内置/覆盖/生效', async () => {
  const srv = makeServer()
  registerRoutes(srv, Object.assign(base(), { getChain: () => [{ provider: 'a', model: 'm', tier: 1 }] }))
  const r = await call(srv, '/chain')
  assert.equal(r.body.builtin.length, 1)
  assert.equal(r.body.effective.length, 1)
})
test('/chain POST 校验并保存覆盖层', async () => {
  const srv = makeServer(); const st = makeState()
  registerRoutes(srv, Object.assign(base(), { state: st }))
  const r = await call(srv, '/chain', { method: 'POST', body: { chain: [{ provider: 'kilo-free', model: 'kilo-auto/free', tier: 1 }] } })
  assert.equal(r.body.ok, true)
  assert.equal(st._store.chain.chain.length, 1)
})
test('/chain POST 拒绝非法 tier', async () => {
  const srv = makeServer(); registerRoutes(srv, base())
  const r = await call(srv, '/chain', { method: 'POST', body: { chain: [{ provider: 'a', model: 'm', tier: 99 }] } })
  assert.equal(r.body.ok, false)
  assert.ok(r.body.errors.length > 0)
})
test('🔴 /config POST 禁止写敏感字段', async () => {
  const srv = makeServer(); registerRoutes(srv, base())
  const r = await call(srv, '/config', { method: 'POST', body: { apiKey: 'sk-should-be-rejected' } })
  assert.equal(r.body.ok, false)
  assert.match(r.body.error, /敏感字段/)
})
test('/diag 返回检查项', async () => {
  const srv = makeServer(); registerRoutes(srv, base())
  const r = await call(srv, '/diag', { method: 'POST', body: {} })
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.body.checks))
  assert.ok(r.body.checks.length >= 5)
})
test('/state 的链为空时给出明确警告', async () => {
  const srv = makeServer(); registerRoutes(srv, base())
  const r = await call(srv, '/state')
  assert.match(r.body.chain.explain, /没有候选链|为空/)
})
test('探测缓存 TTL 是 5 分钟', () => { assert.equal(PROBE_TTL_MS, 300000) })
