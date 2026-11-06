/**
 * cs-myfree — 二次尝试（契约 v1.4）
 *
 * 允许：**非 429** 的瞬时失败（SERVER / TRANSPORT / TIMEOUT / EMPTY_RESPONSE）对**同一候选**再试一次；
 * 目的：救回"这条渠道只是一时抽风"的尾事件（如 seed 7 的 delta:error、19991 的 beta:error）。
 * 禁止：429（rate 冷却）与 CHANNEL_BUSY 因此重试；不碰处于 rate 冷却的候选；
 *       每请求 ≤1 次；`ladder.countAttempt()` 记账；失败同样 markFailure。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAdapter } from '../src/adapter/index.js'
import { createConcurrencyGate } from '../src/adapter/concurrency.js'

async function drain(iter) { for await (const _c of iter) { /* drain */ } }
const err = (status, msg = 'boom') => Object.assign(new Error(msg), { status })

function recorder(behaviors) {
  const calls = []
  const send = async ({ provider }) => {
    calls.push(provider)
    const b = behaviors(calls.length - 1, provider, calls.length)
    if (b === 'ok') return (async function* () { yield { type: 'text-delta', text: 'ok' } })()
    if (b === 'empty') return (async function* () { /* 无可见增量 */ })()
    throw b
  }
  return { calls, send }
}

const mk = ({ builtin, send, events, gate, budget }) => createAdapter({
  builtin,
  send,
  budget,
  concurrency: gate ?? createConcurrencyGate({ limits: { a: 2, b: 2, p: 2, 'paid-src': 2, default: 2 }, busyCooldownMs: 5 }),
  onEvent: (e) => events.push(e),
})

test('① 非 429 瞬时失败（SERVER）⇒ 同一候选第 2 次尝试成功，正常返回', async () => {
  const events = []
  const { calls, send } = recorder((i) => (i === 0 ? err(500) : 'ok'))
  const adapter = mk({ builtin: [{ provider: 'p', model: 'm', tier: 1 }], send, events })
  const out = []
  for await (const c of adapter.stream({ model: 'x', messages: [] })) out.push(c)
  assert.ok(out.some((c) => c.type === 'text-delta'), '第 2 次成功后必须正常出流')
  assert.deepEqual(calls, ['p', 'p'], '同一候选被尝试 2 次（第 2 次来自二次尝试）')
  assert.equal(events.filter((e) => e.type === 'second-attempt').length, 1)
  assert.ok(events.some((e) => e.type === 'success' && e.afterSecondAttempt === true))
})

test('② 第 2 次也失败 ⇒ 如实失败，且每请求只补 1 次（不叠加 last-resort）', async () => {
  const events = []
  const { calls, send } = recorder(() => err(500))
  const adapter = mk({ builtin: [{ provider: 'p', model: 'm', tier: 1 }], send, events })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.deepEqual(calls, ['p', 'p'], '主循环 1 次 + 二次尝试 1 次，不再有第 3 次')
  assert.equal(events.filter((e) => e.type === 'second-attempt').length, 1)
  assert.equal(events.filter((e) => e.type === 'last-resort').length, 0, '已用二次尝试 ⇒ 不叠加 last-resort')
})

test('③ 429（rate 冷却）⇒ **不**触发二次尝试（限流窗口里重打只有白打）', async () => {
  const events = []
  const { calls, send } = recorder(() => err(429, 'HTTP 429 too many'))
  const adapter = mk({ builtin: [{ provider: 'p', model: 'm', tier: 1 }], send, events })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.deepEqual(calls, ['p'], '429 后同候选不得再试')
  assert.equal(events.filter((e) => e.type === 'second-attempt').length, 0)
})

test('④ 每请求 ≤1 次：三个候选全 SERVER 失败 ⇒ 只补 1 次（共 4 次发送）', async () => {
  const events = []
  const { calls, send } = recorder(() => err(500))
  const adapter = mk({
    builtin: [
      { provider: 'a', model: 'ma', tier: 1 },
      { provider: 'b', model: 'mb', tier: 2 },
      { provider: 'p', model: 'mp', tier: 3 },
    ],
    send,
    events,
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.equal(calls.length, 4, '主循环 3 次 + 二次尝试 1 次')
  assert.equal(events.filter((e) => e.type === 'second-attempt').length, 1)
})

test('⑤ free_only ⇒ 二次尝试也只打免费候选（不碰 paid）', async () => {
  const events = []
  const { calls, send } = recorder((_i, provider) => (provider === 'paid-src' ? 'ok' : err(500)))
  const adapter = mk({
    builtin: [
      { provider: 'paid-src', model: 'paid-1', tier: 1, paid: true },
      { provider: 'a', model: 'ma', tier: 2 },
    ],
    send,
    events,
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.equal(calls.includes('paid-src'), false, 'free_only 下二次尝试也不得试 paid')
  assert.equal(events.filter((e) => e.type === 'second-attempt').length, 1)
})

test('⑥ 预算耗尽 ⇒ 不触发二次尝试', async () => {
  const events = []
  const { calls, send } = recorder(() => err(500))
  const adapter = mk({
    builtin: [{ provider: 'p', model: 'm', tier: 1 }],
    send,
    events,
    budget: { maxAttempts: 1 },
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.deepEqual(calls, ['p'], '预算只有 1 次 ⇒ 不补')
  assert.equal(events.filter((e) => e.type === 'second-attempt').length, 0)
})

test('⑦ 空答案（EMPTY_RESPONSE）属非 429 瞬时类 ⇒ 补 1 次', async () => {
  const events = []
  const { calls, send } = recorder(() => 'empty')
  const adapter = mk({ builtin: [{ provider: 'p', model: 'm', tier: 1 }], send, events })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.deepEqual(calls, ['p', 'p'])
  assert.equal(events.filter((e) => e.type === 'second-attempt').length, 1)
})

test('⑧ 候选已处于 rate 冷却 ⇒ 即便上一次是非 429 失败也不补（不碰限流窗口）', async () => {
  const events = []
  const gate = createConcurrencyGate({ limits: { p: 2, default: 2 }, busyCooldownMs: 5 })
  // 第一次发送先把自己标成 429 冷却（模拟并发请求刚把它打进限流窗口），然后抛 SERVER
  const { calls, send } = recorder(() => { gate.markRateLimited('p'); return err(500) })
  const adapter = mk({ builtin: [{ provider: 'p', model: 'm', tier: 1 }], send, events, gate })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.deepEqual(calls, ['p'], 'rate 冷却中不得再试')
  assert.equal(events.filter((e) => e.type === 'second-attempt').length, 0)
})
