/**
 * cs-myfree — 「最后兜底」单次尝试（契约 v1.3 最后一条）
 *
 * 触发条件（四者同时成立）：
 *   ① 主循环 + 有界重试都没成功；② ladder 预算未耗尽；
 *   ③ 最后错误属于瞬时类（TRANSPORT / TIMEOUT / SERVER / RATE_LIMIT / EMPTY_RESPONSE）；
 *   ④ 还有准入后的候选（**billing 硬过滤**后的集合）。
 * 行为：选 `candidateScore` 最小的候选（最可靠/最空闲），**不等待**、`countAttempt()` 记账、发**一次**。
 * 硬约束：每请求至多 1 次、不循环、不突破预算、不绕过 billing。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAdapter } from '../src/adapter/index.js'
import { createConcurrencyGate } from '../src/adapter/concurrency.js'

async function drain(iter) { for await (const _c of iter) { /* drain */ } }
const fail = (status = 500, msg = 'boom') => Object.assign(new Error(msg), { status })

/** 记录 send 调用；可按序号注入成功 */
function recorder(behaviors) {
  const calls = []
  const send = async ({ provider, model }) => {
    calls.push({ provider, model })
    const b = behaviors(calls.length - 1, provider)
    if (b === 'ok') {
      return (async function* () { yield { type: 'text-delta', text: 'ok' } })()
    }
    if (b === 'empty') return (async function* () { /* 无可见增量 */ })()
    throw b
  }
  return { calls, send }
}

const mkAdapter = ({ builtin, send, gateLimits, budget, events }) => createAdapter({
  builtin,
  send,
  budget,
  concurrency: createConcurrencyGate({ limits: gateLimits ?? { a: 2, b: 2, 'paid-src': 2, default: 2 }, busyCooldownMs: 5 }),
  onEvent: (e) => events.push(e),
})

test('① 全部候选瞬时失败（SERVER）⇒ v1.4 起由「二次尝试」接管（last-resort 不再叠加）', async () => {
  const events = []
  const { calls, send } = recorder(() => fail(500))
  const adapter = mkAdapter({
    builtin: [
      { provider: 'a', model: 'ma', tier: 1 },
      { provider: 'b', model: 'mb', tier: 2 },
    ],
    send,
    events,
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.equal(events.filter((e) => e.type === 'last-resort').length, 0, '已用二次尝试 ⇒ 不再叠加 last-resort')
  const sa = events.filter((e) => e.type === 'second-attempt')
  assert.equal(sa.length, 1, '每请求至多一次二次尝试')
  assert.equal(sa[0].kind, 'SERVER')
  assert.equal(calls.length, 3, '主循环 2 次 + 二次尝试 1 次（不循环）')
})

test('② 二次尝试成功 ⇒ 正常返回文本，不再抛错', async () => {
  const events = []
  // 前两次失败，第三次（last-resort）成功
  const { send } = recorder((i) => (i >= 2 ? 'ok' : fail(500)))
  const adapter = mkAdapter({
    builtin: [
      { provider: 'a', model: 'ma', tier: 1 },
      { provider: 'b', model: 'mb', tier: 2 },
    ],
    send,
    events,
  })
  const out = []
  for await (const c of adapter.stream({ model: 'x', messages: [] })) out.push(c)
  assert.ok(out.some((c) => c.type === 'text-delta'), 'last-resort 成功后应正常出流')
  assert.equal(events.filter((e) => e.type === 'second-attempt').length, 1)
  assert.ok(events.some((e) => e.type === 'success' && e.afterSecondAttempt === true))
})

test('③ 非瞬时类失败（AUTH）⇒ 不触发 last-resort', async () => {
  const events = []
  const { calls, send } = recorder(() => fail(401, 'HTTP 401 unauthorized'))
  const adapter = mkAdapter({
    builtin: [{ provider: 'a', model: 'ma', tier: 1 }],
    send,
    events,
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.equal(events.filter((e) => e.type === 'last-resort').length, 0, 'AUTH 属于终态，不该再兜底')
  assert.equal(events.filter((e) => e.type === 'second-attempt').length, 0, 'AUTH 不属于瞬时类')
  assert.equal(calls.length, 1, '只尝试主循环那一次')
})

test('④ free_only ⇒ last-resort 也不碰 paid（Billing 硬过滤优先于兜底）', async () => {
  const events = []
  // a（free）总是 500；paid-src 若被调用就会成功 —— 用来证明"没有绕过授权"
  const { calls, send } = recorder((_i, provider) => (provider === 'paid-src' ? 'ok' : fail(500)))
  const adapter = mkAdapter({
    builtin: [
      { provider: 'paid-src', model: 'paid-1', tier: 1, paid: true },
      { provider: 'a', model: 'ma', tier: 2 },
    ],
    send,
    events,
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.equal(calls.some((c) => c.provider === 'paid-src'), false, 'free_only 下 last-resort 也不得试 paid')
  assert.equal(events.filter((e) => e.type === 'last-resort').length, 0, '已由二次尝试接管')
  const sa = events.filter((e) => e.type === 'second-attempt')
  assert.equal(sa.length, 1)
  assert.equal(sa[0].provider, 'a', '二次尝试也只能打免费候选')
})

test('⑤ 预算已耗尽 ⇒ 不触发 last-resort（不突破预算）', async () => {
  const events = []
  const { calls, send } = recorder(() => fail(500))
  const adapter = mkAdapter({
    builtin: [
      { provider: 'a', model: 'ma', tier: 1 },
      { provider: 'b', model: 'mb', tier: 2 },
    ],
    send,
    budget: { maxAttempts: 2 },            // 主循环两次就把预算用光
    events,
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.equal(events.filter((e) => e.type === 'last-resort').length, 0, '预算耗尽不得再发')
  assert.equal(events.filter((e) => e.type === 'second-attempt').length, 0, '预算耗尽也不得二次尝试')
  assert.equal(calls.length, 2)
})

test('⑥ 空答案（EMPTY_RESPONSE）属非 429 瞬时类 ⇒ 由二次尝试接管', async () => {
  const events = []
  const { send, calls } = recorder(() => 'empty')
  const adapter = mkAdapter({
    builtin: [{ provider: 'a', model: 'ma', tier: 1 }],
    send,
    events,
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.equal(events.filter((e) => e.type === 'second-attempt').length, 1)
  assert.equal(calls.length, 2, '主循环 1 次 + 二次尝试 1 次')
})
