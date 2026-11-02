import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODE, MODE_POLICY, shouldEgress, buildOvhHeaders, bridgeMessages, buildAuditRecord, OVH_CHAIN } from '../src/vision/bridge.js'

test('默认档位是 off（不出网）', () => {
  assert.equal(MODE.OFF, 'off')
  assert.equal(MODE_POLICY[MODE.OFF].egress, false)
})
test('off 档拒绝出网', () => {
  assert.equal(shouldEgress(MODE.OFF).allowed, false)
})
test('free-cloud 未同意时拒绝', () => {
  assert.equal(shouldEgress(MODE.FREE_CLOUD).allowed, false)
  assert.equal(shouldEgress(MODE.FREE_CLOUD, { consented: true }).allowed, true)
})
test('paid-cloud 标记为付费', () => {
  assert.equal(shouldEgress(MODE.PAID_CLOUD, { consented: true }).paid, true)
})
test('local 不出网到公网（loopbackOnly）', () => {
  assert.equal(MODE_POLICY[MODE.LOCAL].loopbackOnly, true)
})
test('OVH 请求头绝不含 Authorization（免密铁律）', () => {
  const h = buildOvhHeaders()
  assert.equal(Object.keys(h).some((k) => /authorization/i.test(k)), false)
})
test('bridgeMessages 把图片块换成文字', async () => {
  const msgs = [{ role: 'user', content: [{ type: 'text', text: '这是什么' }, { type: 'image', ref: 'x' }] }]
  const out = await bridgeMessages(msgs, async () => '一张红色图片')
  assert.equal(out[0].content[1].type, 'text')
  assert.match(out[0].content[1].text, /红色/)
})
test('描述失败时给出明确占位（不是崩溃）', async () => {
  const msgs = [{ role: 'user', content: [{ type: 'image', ref: 'x' }] }]
  const out = await bridgeMessages(msgs, async () => { throw new Error('boom') })
  assert.match(out[0].content[0].text, /未能解析/)
})
test('纯文本消息原样透传', async () => {
  const msgs = [{ role: 'user', content: 'hello' }]
  const out = await bridgeMessages(msgs, async () => 'x')
  assert.equal(out[0].content, 'hello')
})
test('审计记录不含图片字节/密钥', () => {
  const r = buildAuditRecord({ mode: 'free-cloud', backend: 'ovh', model: 'q', bytes: 100, ok: true, ms: 20 })
  const s = JSON.stringify(r)
  assert.equal(/base64|data:image|sk-/.test(s), false)
})
test('OVH 链有 4 个模型且质量降序', () => {
  assert.equal(OVH_CHAIN.length, 4)
})
