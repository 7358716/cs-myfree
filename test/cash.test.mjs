/**
 * 余额功能测试 —— 重点验**安全红线**：绝不泄漏 Key
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBalance, formatCash, queryCash, registerCashRoute, CASH_PATH } from '../src/web/cash.js'
import { judge, isLoopbackAddr, isLocalHostHeader, isTrustedHostHeader, hasAuthCookie, sendJson } from '../src/web/guard.js'

// ── 余额归一化 ──
test('只保留数字字段（丢弃原始响应其它内容）', () => {
  const r = normalizeBalance({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '2', topped_up_balance: '10.34', secret_field: 'MUST_NOT_LEAK' }],
    extra: 'MUST_NOT_LEAK',
  })
  const s = JSON.stringify(r)
  assert.equal(s.includes('MUST_NOT_LEAK'), false, '未知字段不得外泄')
  assert.equal(r.available, true)
  assert.equal(r.balances[0].total, 12.34)
})
test('formatCash 输出 ¥ 金额', () => {
  assert.equal(formatCash({ available: true, balances: [{ currency: 'CNY', total: 12.345 }] }), '¥12.35')
})
test('formatCash 无数据返回占位（不是 0）', () => {
  assert.equal(formatCash(null), '¥ —')
  assert.equal(formatCash({ balances: [] }), '¥ —')
})
test('多币种并列显示', () => {
  assert.match(formatCash({ balances: [{ currency: 'CNY', total: 1 }, { currency: 'USD', total: 2 }] }), /¥1\.00.*USD 2\.00/)
})

// ── 查询：绝不含 key ──
test('未配置 Key 时给出明确提示且不报错', async () => {
  const r = await queryCash({}, { fetchImpl: async () => { throw new Error('不应被调用') } })
  assert.equal(r.ok, true)
  assert.equal(r.deepseek, null)
  assert.ok(r.errors[0].includes('未配置'))
})
test('查询成功返回余额', async () => {
  const ctx = { get: () => ({ resolve: async () => ({ value: 'sk-test-key-123' }) }) }
  const r = await queryCash(ctx, {
    fetchImpl: async (url, init) => {
      assert.ok(String(url).includes('deepseek.com/user/balance'))
      assert.match(init.headers.authorization, /^Bearer /)
      return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '8.88' }] }) }
    },
  })
  assert.equal(r.deepseek.balances[0].total, 8.88)
})
test('🔴 返回结果里绝不含 API Key（安全红线）', async () => {
  const KEY = 'sk-super-secret-do-not-leak-9f8e7d'
  const ctx = { get: () => ({ resolve: async () => ({ value: KEY }) }) }
  const r = await queryCash(ctx, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ is_available: true, balance_infos: [] }) }),
  })
  const s = JSON.stringify(r)
  assert.equal(s.includes(KEY), false, '响应绝不能包含 Key')
  assert.equal(s.includes('sk-'), false, '响应里不能出现任何 sk- 前缀')
})
test('🔴 错误路径也不泄漏 Key', async () => {
  const KEY = 'sk-leak-test-abc123'
  const ctx = { get: () => ({ resolve: async () => ({ value: KEY }) }) }
  const r = await queryCash(ctx, { fetchImpl: async () => { throw new Error('network down') } })
  assert.equal(JSON.stringify(r).includes(KEY), false)
})
test('HTTP 非 2xx 时给出状态码而非崩溃', async () => {
  const ctx = { get: () => ({ resolve: async () => ({ value: 'k' }) }) }
  const r = await queryCash(ctx, { fetchImpl: async () => ({ ok: false, status: 401 }) })
  assert.ok(r.errors[0].includes('401'))
})

// ── 安全围栏 ──
test('isLoopbackAddr 判定', () => {
  assert.equal(isLoopbackAddr('127.0.0.1'), true)
  assert.equal(isLoopbackAddr('::1'), true)
  assert.equal(isLoopbackAddr('203.0.113.5'), false)
})
test('isLocalHostHeader 判定', () => {
  assert.equal(isLocalHostHeader('localhost:3080'), true)
  assert.equal(isLocalHostHeader('150.158.175.241'), false)
})
test('isTrustedHostHeader 需在清单内', () => {
  assert.equal(isTrustedHostHeader('a.com', []), false)
  assert.equal(isTrustedHostHeader('a.com', ['a.com']), true)
})
test('hasAuthCookie 识别内核 cookie', () => {
  assert.equal(hasAuthCookie({ headers: { cookie: 'x=1; dsh-auth-abc=2' } }), true)
  assert.equal(hasAuthCookie({ headers: { cookie: 'x=1' } }), false)
})
test('🔴 外部地址 + 无 cookie ⇒ 拒绝（防他人访问）', () => {
  const req = { socket: { remoteAddress: '203.0.113.5' }, headers: { host: '150.158.175.241' } }
  assert.equal(judge(req, { trustedHosts: ['150.158.175.241'] }).ok, false)
})
test('🔴 外部地址 + 伪造 cookie ⇒ 拒绝（v1.7.1 认证绕过修复）', () => {
  // 旧实现只看 cookie 名前缀就放行 ⇒ 任何人伪造 dsh-auth-xxx 即可读写插件。
  // 现在必须由宿主 connection 验签；拿不到校验能力时 fail-closed。
  const req = {
    socket: { remoteAddress: '203.0.113.5' },
    headers: { host: '150.158.175.241', cookie: 'dsh-auth-xx=1' },
  }
  const r = judge(req, { trustedHosts: ['150.158.175.241'] })
  assert.equal(r.ok, false)
  assert.equal(r.status, 403)
})

test('外部地址 + 宿主校验通过（真实会话）⇒ 放行', () => {
  const req = {
    socket: { remoteAddress: '203.0.113.5' },
    headers: { host: '150.158.175.241', cookie: 'dsh-auth-xx=1' },
  }
  // 宿主 connection.requestRejection 返回假值（undefined/null/0）表示已通过
  const conn = { requestRejection: () => undefined }
  assert.equal(judge(req, { trustedHosts: ['150.158.175.241'], getConnection: () => conn }).ok, true)
})

test('外部地址 + 宿主校验失败 ⇒ 401', () => {
  const req = {
    socket: { remoteAddress: '203.0.113.5' },
    headers: { host: '150.158.175.241', cookie: 'dsh-auth-xx=1' },
  }
  const conn = { requestRejection: () => 401 }
  const r = judge(req, { trustedHosts: ['150.158.175.241'], getConnection: () => conn })
  assert.equal(r.ok, false)
  assert.equal(r.status, 401)
})
test('回环 + localhost ⇒ 放行', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' } }
  assert.equal(judge(req, {}).ok, true)
})
test('🔴 跨源请求被拒（防 CSRF）', () => {
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost:3080', origin: 'https://evil.com' },
  }
  const r = judge(req, {})
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'cross-origin')
})
test('🔴 未知 Host 被拒（防 DNS rebinding）', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'evil.com' } }
  assert.equal(judge(req, {}).ok, false)
})
test('sendJson 带 no-store（防缓存泄漏）', () => {
  let captured = null
  const res = { writeHead: (s, h) => { captured = { s, h } }, end: () => {} }
  sendJson(res, 200, { ok: true })
  assert.equal(captured.h['cache-control'], 'no-store')
  assert.equal(captured.h['x-content-type-options'], 'nosniff')
})
test('registerCashRoute 路径与 guard 生效', async () => {
  const routes = []
  const ws = { register: (r) => routes.push(r) }
  const ok = registerCashRoute(ws, {}, { helpers: { judge, sendJson }, trustedHosts: [] })
  assert.equal(ok, true)
  assert.equal(routes[0].path, CASH_PATH)
})
test('registerCashRoute 无 webServer 时返回 false 不抛', () => {
  assert.equal(registerCashRoute(null, {}, { helpers: { judge, sendJson } }), false)
})
