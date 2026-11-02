import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ZONES, selfCheck, renderWorkbench, apply } from '../src/client.js'

test('12 个功能区齐全', () => {
  const r = selfCheck()
  assert.equal(r.ok, true)
  assert.equal(r.count, 12)
  assert.deepEqual(r.missing, [])
})
test('每个区都有 id/key/label', () => {
  for (const z of ZONES) { assert.match(z.id, /^W\d+$/); assert.ok(z.key); assert.ok(z.label) }
})
test('W3 链编辑器被标记为星级（核心区）', () => {
  assert.equal(ZONES.find((z) => z.id === 'W3').star, true)
})
test('renderWorkbench 返回 12 个区且各带 body', () => {
  const w = renderWorkbench({})
  assert.equal(w.zones.length, 12)
  for (const z of w.zones) assert.ok(z.body !== undefined)
})
test('W7 展示五道闸门', () => {
  const w = renderWorkbench({})
  const b = w.zones.find((z) => z.key === 'budget').body
  assert.equal(b.gates.length, 5)
})
test('W10 导入需预览（安全）', () => {
  const w = renderWorkbench({})
  assert.equal(w.zones.find((z) => z.key === 'io').body.importsRequiresPreview, true)
})
test('apply 用自有 id 注册（不覆盖内置页）', () => {
  const calls = []
  apply({ slots: { inject: (slot, fn) => calls.push({ slot, cell: fn() }) } })
  assert.equal(calls[0].slot, 'settings.section')
  assert.equal(calls[0].cell.id, 'cs-myfree-section')
})
test('无 slots 时不崩（缺服务只降级）', () => {
  assert.doesNotThrow(() => apply({}))
})
