import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeRecord, aggregate, spentToday, spentThisMonth, failureBreakdown, dateKeyCN } from '../src/audit/ledger.js'
import { rankCandidates, buildAggregatePanel, normalizeModelName, groupByCanonical, EXPIRY_CAPABLE } from '../src/pools/aggregate.js'

// ── 账本 ──
test('免费调用 cost=0 且 free=true（严格区分）', () => {
  const r = makeRecord({ provider: 'kilo', paid: false })
  assert.equal(r.costCNY, 0); assert.equal(r.free, true); assert.equal(r.costUnknown, false)
})
test('付费但价格未知 ⇒ cost=null 且 costUnknown（绝不当 0）', () => {
  const r = makeRecord({ provider: 'x', paid: true })
  assert.equal(r.costCNY, null); assert.equal(r.costUnknown, true)
})
test('付费且有价格 ⇒ 记录金额', () => {
  const r = makeRecord({ provider: 'x', paid: true, costCNY: 0.5 })
  assert.equal(r.costCNY, 0.5); assert.equal(r.costUnknown, false)
})
test('dateKeyCN 用 UTC+8 日界', () => {
  const t = Date.UTC(2026, 10, 2, 17, 0, 0)   // UTC 17:00 = 次日 01:00 (CN)
  assert.equal(dateKeyCN(t), '2026-11-03')
})
test('按天聚合并区分免费/付费/未知', () => {
  const at = Date.UTC(2026, 10, 2, 2, 0, 0)
  const recs = [
    makeRecord({ at, provider: 'a', paid: false }),
    makeRecord({ at, provider: 'b', paid: true, costCNY: 0.2 }),
    makeRecord({ at, provider: 'c', paid: true }),
  ]
  const agg = aggregate(recs)
  assert.equal(agg[0].calls, 3)
  assert.equal(agg[0].free, 1)
  assert.equal(agg[0].paid, 2)
  assert.equal(agg[0].costUnknown, 1)
  assert.equal(agg[0].costCNY, 0.2, '未知价格不得计入金额')
})
test('spentToday 汇总', () => {
  const at = Date.UTC(2026, 10, 2, 2, 0, 0)
  const recs = [makeRecord({ at, paid: true, costCNY: 0.3 }), makeRecord({ at, paid: true, costCNY: 0.2 })]
  assert.equal(Number(spentToday(recs, at).toFixed(2)), 0.5)
})
test('failureBreakdown 给出失明率（v3 V3 目标 <5%）', () => {
  const recs = [
    makeRecord({ ok: false, code: 'RATE_LIMIT' }),
    makeRecord({ ok: false, code: 'UNKNOWN' }),
    makeRecord({ ok: true }),
    makeRecord({ ok: true }),
  ]
  const f = failureBreakdown(recs)
  assert.equal(f.failTotal, 2)
  assert.equal(f.byCode.UNKNOWN, 1)
  assert.equal(f.blindRate, 25)
})

// ── 聚合 ──
const NOW = 1_800_000_000_000
test('模型名归一', () => {
  assert.equal(normalizeModelName('DeepSeek_V4.1 Flash'), 'deepseek-v4-1-flash')
})
test('同规范名归并', () => {
  const g = groupByCanonical([
    { channel: 'codearts', model: 'deepseek-v4.1-flash', canonical: 'deepseek' },
    { channel: 'buddy', model: 'deepseek-v4.1-flash', canonical: 'deepseek' },
  ])
  assert.equal(g.length, 1)
  assert.equal(g[0].candidates.length, 2)
})
test('临期最早的排最前（核心语义）', () => {
  const r = rankCandidates([
    { channel: 'late', model: 'm', expiresAt: NOW + 72 * 3600_000 },
    { channel: 'soon', model: 'm', expiresAt: NOW + 2 * 3600_000 },
  ], { now: NOW })
  assert.equal(r.preferred.channel, 'soon')
  assert.match(r.explain, /临期最早/)
})
test('无临期信息默认不参与轮换', () => {
  const r = rankCandidates([{ channel: 'gemini', model: 'm' }], { now: NOW })
  assert.equal(r.active.length, 0)
  assert.equal(r.inactive.length, 1)
})
test('显式放行后无临期渠道可参与', () => {
  const r = rankCandidates([{ channel: 'gemini', model: 'm' }], { now: NOW, allowNoExpiry: new Set(['gemini']) })
  assert.equal(r.active.length, 1)
  assert.match(r.explain, /手工放行/)
})
test('过期候选不参与', () => {
  const r = rankCandidates([{ channel: 'x', model: 'm', expiresAt: NOW - 1 }], { now: NOW })
  assert.equal(r.active.length, 0)
})
test('面板显示「未参与」原因', () => {
  const p = buildAggregatePanel([{ channel: 'gemini', model: 'flash' }], { now: NOW })
  assert.equal(p[0].candidates[0].note, '无临期信息 · 未参与')
})
test('EXPIRY_CAPABLE 来自协议表（不是适配器常量）', () => {
  assert.ok(EXPIRY_CAPABLE.includes('codearts'))
  assert.ok(EXPIRY_CAPABLE.includes('loomy'))
})
