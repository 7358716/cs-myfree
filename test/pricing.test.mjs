/**
 * cs-myfree — 计价与付费统计测试
 *
 * 🐛 用户实测「昨天有花费付款 api，你没统计到」：
 *    adapter 把 cost:0 / paid:false 硬编码 ⇒ 付费调用永不计费。
 *    旧插件账本 240 条 paid:true 但 cost 全 0 —— 同样缺价格表。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeCost, priceOf, isOffPeak, normalizeModel,
  FREE_PROVIDERS, CHANNEL_FREE, PRICING,
} from '../src/audit/pricing.js'

test('免密源 ⇒ 确定性免费（cost 0, paid false）', () => {
  for (const p of FREE_PROVIDERS) {
    const r = computeCost({ provider: p, model: 'anything', inTokens: 1e6, outTokens: 1e6 })
    assert.equal(r.costCNY, 0)
    assert.equal(r.paid, false)
    assert.equal(r.known, true)
  }
})

test('渠道自带额度 ⇒ 也记免费', () => {
  for (const p of CHANNEL_FREE) {
    const r = computeCost({ provider: p, model: 'x', inTokens: 1e6, outTokens: 1e6 })
    assert.equal(r.costCNY, 0, p + ' 应记免费')
    assert.equal(r.paid, false)
  }
})

test('🔴 付费源必须真算钱（此前恒 0）', () => {
  const peak = new Date('2026-11-03T10:00:00+08:00').getTime()
  const r = computeCost({ provider: 'deepseek', model: 'deepseek-v4-flash', inTokens: 1_000_000, outTokens: 0, at: peak })
  assert.equal(r.paid, true)
  assert.equal(r.known, true)
  assert.equal(r.costCNY, 2, '峰时 inputMiss=2/百万 ⇒ 100万输入 = ¥2')
})

test('输出 token 按 output 单价', () => {
  const peak = new Date('2026-11-03T10:00:00+08:00').getTime()
  const r = computeCost({ provider: 'deepseek', model: 'deepseek-v4-flash', inTokens: 0, outTokens: 1_000_000, at: peak })
  assert.equal(r.costCNY, 8)
})

test('缓存命中按 inputHit 低价计', () => {
  const peak = new Date('2026-11-03T10:00:00+08:00').getTime()
  const r = computeCost({ provider: 'deepseek', model: 'deepseek-v4-flash', inTokens: 0, outTokens: 0, cacheReadTokens: 1_000_000, at: peak })
  assert.ok(r.costCNY < 0.1, '缓存命中应远便宜于未命中：' + r.costCNY)
})

test('谷时比峰时便宜一半', () => {
  const peak = new Date('2026-11-03T10:00:00+08:00').getTime()
  const off = new Date('2026-11-03T03:00:00+08:00').getTime()
  const a = computeCost({ provider: 'deepseek', model: 'deepseek-v4-flash', inTokens: 1e6, outTokens: 0, at: peak })
  const b = computeCost({ provider: 'deepseek', model: 'deepseek-v4-flash', inTokens: 1e6, outTokens: 0, at: off })
  assert.equal(b.costCNY, a.costCNY / 2)
  assert.match(b.note, /谷时/)
})

test('峰谷时段判据（00:30–08:30 为谷时）', () => {
  const mk = (hhmm) => new Date(`2026-11-03T${hhmm}:00+08:00`).getTime()
  assert.equal(isOffPeak(mk('03:00')), true)
  assert.equal(isOffPeak(mk('00:29')), false)
  assert.equal(isOffPeak(mk('00:30')), true)
  assert.equal(isOffPeak(mk('08:29')), true)
  assert.equal(isOffPeak(mk('08:30')), false)
  assert.equal(isOffPeak(mk('10:00')), false)
})

test('🔴 价格未知 ⇒ cost=null（不能当 0）', () => {
  const r = computeCost({ provider: 'deepseek', model: 'some-new-model', inTokens: 1000 })
  assert.equal(r.costCNY, null, '未知价格必须记 null，不能折成 0')
  assert.equal(r.paid, true)
  assert.equal(r.known, false)
  assert.match(r.note, /价格未知/)
})

test('模型名归一：渠道前缀要剥掉', () => {
  assert.equal(normalizeModel('codearts/deepseek-v4.1-flash'), 'deepseek-v4.1-flash')
  assert.equal(normalizeModel('deepseek-v4-flash'), 'deepseek-v4-flash')
  assert.equal(normalizeModel(''), '')
  assert.equal(normalizeModel(null), '')
})

test('priceOf 查表', () => {
  assert.ok(priceOf('deepseek-v4-flash'))
  assert.equal(priceOf('nonexistent'), null)
  assert.ok(Object.keys(PRICING).length >= 1)
})

test('代码里不再有硬编码的 cost:0/paid:false 记账', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../src/adapter/index.js', import.meta.url), 'utf8')
  assert.equal(/cost:\s*0,\s*paid:\s*false/.test(src), false, '不得再硬编码 cost:0/paid:false')
  assert.match(src, /computeCost/)
})
