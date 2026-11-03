import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recommendMode, supportedModes, LOGIN_MODE } from '../src/pools/channels/login-mode.js'
import { CHANNELS } from '../src/pools/channels/protocols.js'

test('AK/SK 类渠道推荐一步制', () => {
  for (const id of ['qiniu', 'officeace', 'codearts', 'zcode', 'accio']) {
    assert.equal(recommendMode(id, CHANNELS[id]).id, 'aksk', id + ' 应推荐 AK/SK')
    assert.equal(recommendMode(id, CHANNELS[id]).steps, 1, id + ' 应是一步')
  }
})

test('扫码/浏览器类渠道走「登录后自动识别」', () => {
  for (const id of ['loomy', 'gemini', 'trae', 'raccoon']) {
    assert.equal(recommendMode(id, CHANNELS[id]).id, 'oauth', id)
    assert.equal(recommendMode(id, CHANNELS[id]).steps, 2, id + ' 应是两步')
  }
})

test('🔴 每种推荐方式都不超过 2 步（主管硬要求）', () => {
  for (const [id, ch] of Object.entries(CHANNELS)) {
    const m = recommendMode(id, ch)
    assert.ok(m.steps <= 2, id + ' 的推荐方式是 ' + m.steps + ' 步，超标')
  }
})

test('所有渠道都有推荐方式且说明不是空话', () => {
  for (const [id, ch] of Object.entries(CHANNELS)) {
    const m = recommendMode(id, ch)
    assert.ok(m.label, id)
    assert.ok(m.how && m.how.length > 10, id + ' 的说明太短')
  }
})

test('supportedModes 按步骤数升序（少步骤的在前）', () => {
  const ms = supportedModes('codearts', CHANNELS.codearts)
  for (let i = 1; i < ms.length; i++) {
    assert.ok(ms[i - 1].steps <= ms[i].steps, '必须按步骤升序')
  }
})

test('supportedModes 不重复', () => {
  const ms = supportedModes('loomy', CHANNELS.loomy)
  const ids = ms.map((m) => m.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('一步制的渠道数应占多数（体验优先）', () => {
  let oneStep = 0
  for (const [id, ch] of Object.entries(CHANNELS)) {
    if (recommendMode(id, ch).steps === 1) oneStep++
  }
  assert.ok(oneStep >= 10, '一步制渠道应有 10 家以上，实际 ' + oneStep)
})
