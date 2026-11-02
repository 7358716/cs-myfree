import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SOURCES, KIND, sourceById, keylessSources, checkinSources, buildOrder } from '../src/pools/registry.js'

test('注册表含 18 个账号渠道', () => {
  assert.equal(SOURCES.filter((s) => s.kind === KIND.ACCOUNT).length, 18)
})
test('含 Loomy 与 Gemini', () => {
  assert.ok(sourceById('loomy')); assert.ok(sourceById('gemini'))
})
test('免密源永不带 paid', () => {
  for (const s of keylessSources()) assert.notEqual(s.paid, true)
})
test('付费源默认被排除', () => {
  assert.equal(buildOrder().some((s) => s.paid === true), false)
})
test('显式 allowPaid 时才含付费源', () => {
  assert.ok(buildOrder({ allowPaid: true }).some((s) => s.paid === true))
})
test('免密池排最前', () => {
  assert.equal(buildOrder()[0].kind, KIND.KEYLESS)
})
test('disabled 生效', () => {
  assert.equal(buildOrder({ disabled: new Set(['kilo-free']) }).some((s) => s.id === 'kilo-free'), false)
})
test('checkinSources 正确', () => {
  const c = checkinSources(); assert.ok(c.length > 0)
  for (const s of c) assert.equal(s.checkin, true)
})
test('Loomy 支持签到 / Gemini 不支持', () => {
  assert.equal(sourceById('loomy').checkin, true)
  assert.equal(sourceById('gemini').checkin, false)
})
