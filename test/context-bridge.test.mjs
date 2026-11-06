/**
 * 外部对话上下文桥测试（DeepSeek 网页版 → DSH）
 *
 * 核心纪律：「传得少」—— 窗口上限、单条截断、总字节上限、过期丢弃。
 * 扩展每次发全量最近 N 条（整段覆盖），因此「传得少」由这四个约束共同保证。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createContextBridge, normalizeMessage, CONTEXT_DEFAULTS } from '../src/context/bridge.js'
import { registerRoutes, PREFIX } from '../src/web/routes.js'
import { findSensitiveKey } from '../src/config/store.js'

// ══════════════════════════════════════════════════════════════════════════
// 归一化
// ══════════════════════════════════════════════════════════════════════════

test('normalizeMessage：合法角色原样保留', () => {
  for (const r of ['user', 'assistant', 'system']) {
    const m = normalizeMessage({ role: r, text: 'hi' })
    assert.equal(m.role, r)
  }
})

test('🟥 normalizeMessage：非法角色必须回落 user（不能凭空造出 assistant）', () => {
  assert.equal(normalizeMessage({ role: 'evil-attacker', text: 'x' }).role, 'user')
  assert.equal(normalizeMessage({ text: 'x' }).role, 'user')
})

test('normalizeMessage：超过 maxChars 要截断并如实标记', () => {
  const m = normalizeMessage({ role: 'user', text: 'a'.repeat(500) }, 200)
  assert.equal(m.text.length, 200)
  assert.equal(m.truncated, true, '必须标记被截断（否则用户以为拿到了全文）')
  assert.equal(m.originalChars, 500, '要保留原始长度便于排查')
})

test('normalizeMessage：空白压缩', () => {
  const m = normalizeMessage({ role: 'user', text: '  a\n\n  b   c  ' })
  assert.equal(m.text, 'a b c')
})

// ══════════════════════════════════════════════════════════════════════════
// 滑动窗口与限流
// ══════════════════════════════════════════════════════════════════════════

test('ingest：超过窗口只留最近 N 条，且 dropped 如实回报', () => {
  const b = createContextBridge()
  const msgs = Array.from({ length: 50 }, (_, i) => ({ role: 'user', text: `m${i}` }))
  const r = b.ingest({ messages: msgs })
  assert.equal(r.accepted, CONTEXT_DEFAULTS.maxMessages)
  assert.equal(r.dropped, 50 - CONTEXT_DEFAULTS.maxMessages)
  const got = b.read().messages
  assert.equal(got.length, CONTEXT_DEFAULTS.maxMessages)
  assert.equal(got[got.length - 1].text, 'm49', '必须保留最新的')
})

test('ingest：整段覆盖（用户在网页删消息 ⇒ 这里也要消失）', () => {
  const b = createContextBridge()
  b.ingest({ messages: [{ role: 'user', text: 'old' }] })
  assert.equal(b.read().messages.length, 1)
  b.ingest({ messages: [] })
  assert.equal(b.read().messages.length, 0, '空上报必须清空，不能留着上一条')
})

test('🟥 ingest：超总字节上限时保留最新的（丢旧的）', () => {
  // 每条 100 字 × 5 条 = 500 字，但总上限只给 250 字 ⇒ 最多留 2~3 条，且必须是尾部
  const b = createContextBridge({ maxTotalBytes: 250 })
  const msgs = Array.from({ length: 5 }, (_, i) => ({ role: 'user', text: 'x'.repeat(100) + i }))
  b.ingest({ messages: msgs })
  const got = b.read().messages
  assert.ok(got.length > 0, '至少要留一条')
  assert.equal(got[got.length - 1].text.endsWith('4'), true, '最新的必须保留')
  assert.equal(got[0].text.endsWith('4'), false, '丢的应该是最早的')
})

test('read：maxMessages 可进一步收紧', () => {
  const b = createContextBridge()
  b.ingest({ messages: [1, 2, 3, 4, 5].map((i) => ({ role: 'user', text: 't' + i })) })
  const got = b.read({ maxMessages: 2 }).messages
  assert.equal(got.length, 2)
  assert.equal(got[1].text, 't5', '取的仍是最新的两条')
})

test('read：过期后如实报空（6 小时前的网页对话不该继续占用上下文）', () => {
  let clock = Date.now()
  const b = createContextBridge({ now: () => clock })
  b.ingest({ messages: [{ role: 'user', text: 'hello' }] })
  assert.equal(b.read().messages.length, 1)
  clock += 7 * 3600 * 1000
  const r = b.read()
  assert.equal(r.empty, true)
  assert.equal(r.messages.length, 0)
  assert.ok(String(r.note).includes('过期'), '要说明为什么是空的')
})

test('clear：主动清空', () => {
  const b = createContextBridge()
  b.ingest({ messages: [{ role: 'user', text: 'x' }] })
  assert.equal(b.clear().ok, true)
  assert.equal(b.read().empty, true)
})

test('summary：只含预览不含正文（别把长文再搬一次）', () => {
  const b = createContextBridge()
  b.ingest({ messages: [{ role: 'user', text: '很长的对话内容'.repeat(50) }] })
  const s = b.summary()
  assert.equal(s.empty, false)
  assert.ok(Array.isArray(s.preview))
  assert.ok(s.preview.length <= 2)
  assert.ok(JSON.stringify(s).length < 500, '摘要必须很小')
})

// ══════════════════════════════════════════════════════════════════════════
// 配置项落盘可行性（settings 的敏感字段拦截器不能挡掉）
// ══════════════════════════════════════════════════════════════════════════

test('🟥 contextBridgeCode 不会被 settings 的敏感字段拦截器挡掉', () => {
  const SENSITIVE_RE = /(key|token|secret|password|passwd|authorization|cookie|credential)/i
  assert.equal(SENSITIVE_RE.test('contextBridgeCode'), false,
    '键名含 token 会被拦，扩展就永远配不上 —— 这是真会卡住用户的缺陷')
  assert.equal(findSensitiveKey({ contextBridgeCode: 'abc' }), null)
})

// 路由行为测试见 test/routes.test.mjs（HTTP 层守卫测试）
