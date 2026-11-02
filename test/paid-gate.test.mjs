import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, DECISION } from '../src/policy/paid-gate.js'

const BUDGET = { perCallCNY: 1, dailyCNY: 10, monthlyCNY: 100 }
const base = (o = {}) => ({
  paid: true, costCNY: 0.1, agentPreset: 'paid-repair',
  budget: BUDGET, spentTodayCNY: 0, spentMonthCNY: 0,
  confirmEachTurn: false, confirmed: false,
  paidPresets: ['paid-repair'], ...o,
})

test('免费调用一律放行', () => {
  assert.equal(evaluate({ paid: false }).decision, DECISION.ALLOW)
})

test('闸门③：非白名单预设被拒', () => {
  const r = evaluate(base({ agentPreset: 'normal' }))
  assert.equal(r.decision, DECISION.DENY)
  assert.match(r.gate, /③/)
})

test('闸门④：价格未知 ⇒ 拒绝（deny-by-default）', () => {
  const r = evaluate(base({ costCNY: null }))
  assert.equal(r.decision, DECISION.DENY)
  assert.match(r.reason, /未知/)
})

test('闸门④：单次超限被拒', () => {
  const r = evaluate(base({ costCNY: 1.5 }))
  assert.equal(r.decision, DECISION.DENY)
  assert.match(r.gate, /④/)
})

test('闸门④：限额为 0 视为禁止付费（治死信）', () => {
  const r = evaluate(base({ budget: { ...BUDGET, perCallCNY: 0 } }))
  assert.equal(r.decision, DECISION.DENY)
})

test('闸门⑤：月度超限被拒', () => {
  const r = evaluate(base({ spentMonthCNY: 99.95, costCNY: 0.1 }))
  assert.equal(r.decision, DECISION.DENY)
  assert.match(r.gate, /⑤/)
})

test('闸门⑤：月度限额未配置视为禁止', () => {
  const r = evaluate(base({ budget: { ...BUDGET, monthlyCNY: 0 } }))
  assert.equal(r.decision, DECISION.DENY)
})

test('闸门⑤：日限超限被拒', () => {
  const r = evaluate(base({ spentTodayCNY: 9.95, costCNY: 0.1 }))
  assert.equal(r.decision, DECISION.DENY)
})

test('闸门②：需逐次确认时返回 need-confirm', () => {
  const r = evaluate(base({ confirmEachTurn: true, confirmed: false }))
  assert.equal(r.decision, DECISION.NEED_CONFIRM)
  assert.match(r.gate, /②/)
})

test('闸门②：已确认则放行', () => {
  const r = evaluate(base({ confirmEachTurn: true, confirmed: true }))
  assert.equal(r.decision, DECISION.ALLOW)
})

test('全部满足则放行', () => {
  assert.equal(evaluate(base()).decision, DECISION.ALLOW)
})

test('五道闸门都能被独立触发（可演示）', () => {
  const gates = [
    evaluate(base({ agentPreset: 'x' })).gate,
    evaluate(base({ confirmEachTurn: true })).gate,
    evaluate(base({ costCNY: 5 })).gate,
    evaluate(base({ spentMonthCNY: 200 })).gate,
  ].filter(Boolean)
  assert.ok(gates.length >= 3, '至少三道能被独立触发')
})
