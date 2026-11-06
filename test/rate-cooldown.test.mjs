/**
 * cs-myfree — 429 限流冷却**不得被重试放宽**（契约 v1.4 / task-11）
 *
 * 真实缺陷（verifier 终验）：闸门此前只有一条 `coolUntil`，重试路径（cooldown-retry /
 * 第二段等待 / last-resort）对它调 `relaxCooldown()` ⇒ 把 **429 冷却**也放宽了
 * ⇒ 在限流窗口里再打一次 429（实测 110 次 429 里 54 次是这种白打）。
 *
 * 现在两种冷却分开记账：
 *   · `busyCoolUntil`（并发满，上游会话未归还）⇒ 重试**可以**放宽
 *   · `rateCoolUntil`（429 请求级限流，指数退避）⇒ 任何重试**都不得**放宽
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConcurrencyGate } from '../src/adapter/concurrency.js'
import { createAdapter } from '../src/adapter/index.js'

async function drain(iter) { for await (const _c of iter) { /* drain */ } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rateErr = () => Object.assign(new Error('HTTP 429 too many requests'), { status: 429 })

test('① 429 ⇒ 进 rate 冷却；重试/last-resort 都不会重打同一候选（只发送 1 次）', async () => {
  const calls = []
  const events = []
  const gate = createConcurrencyGate({ limits: { p: 2, default: 2 } })
  const adapter = createAdapter({
    builtin: [{ provider: 'p', model: 'm', tier: 1 }],
    send: async ({ provider }) => { calls.push(provider); throw rateErr() },
    concurrency: gate,
    onEvent: (e) => events.push(e),
  })
  await assert.rejects(
    () => drain(adapter.stream({ model: 'x', messages: [] })),
    (e) => e.code === 'RATE_LIMIT',
  )
  assert.deepEqual(calls, ['p'], '429 后不得在限流窗口里重打（重试与 last-resort 都必须跳过）')
  assert.equal(gate.isRateCooling('p'), true, '必须进入 rate 冷却')
  assert.ok(gate.stats('p').rateCoolingMs > 0)
  assert.equal(events.filter((e) => e.type === 'last-resort').length, 0, 'last-resort 也不得碰 rate 冷却候选')
})

test('② 成对：并发忙（busy）冷却在重试里**可以**被放宽 ⇒ 会真的再试一次', async () => {
  const calls = []
  const events = []
  const gate = createConcurrencyGate({ limits: { p: 2, default: 2 }, busyCooldownMs: 60_000 })
  gate.markBusy('p')                        // 并发满冷却（长）⇒ 主循环跳过
  const adapter = createAdapter({
    builtin: [{ provider: 'p', model: 'm', tier: 1 }],
    send: async ({ provider }) => {
      calls.push(provider)
      return (async function* () { yield { type: 'text-delta', text: 'ok' } })()
    },
    concurrency: gate,
    onEvent: (e) => events.push(e),
  })
  const out = []
  for await (const c of adapter.stream({ model: 'x', messages: [] })) out.push(c)
  assert.ok(out.some((c) => c.type === 'text-delta'), 'busy 冷却被放宽后应能成功')
  assert.deepEqual(calls, ['p'], '放宽 busy 冷却 ⇒ 真正发送 1 次')
  assert.ok(events.some((e) => e.type === 'cooldown-retry'), '走了有界重试路径')
})

test('③ 两种冷却独立到期：relaxCooldown 只清 busy，rate 仍生效', async () => {
  const gate = createConcurrencyGate({ limits: { p: 2, default: 2 }, busyCooldownMs: 20, rateLimitCooldownMs: 80 })
  gate.markBusy('p')
  gate.markRateLimited('p')
  const s0 = gate.stats('p')
  assert.ok(s0.busyCoolingMs > 0 && s0.rateCoolingMs > 0, '两种冷却同时存在')
  assert.equal(gate.relaxCooldown('p'), true, '放宽的是 busy')
  const s1 = gate.stats('p')
  assert.equal(s1.busyCoolingMs, 0, 'busy 冷却已清')
  assert.ok(s1.rateCoolingMs > 0, 'rate 冷却**必须**仍在')
  assert.equal(gate.isCooling('p'), true, 'rate 未到期 ⇒ 整体仍在冷却')
  const blocked = await gate.acquire('p')
  assert.equal(blocked.ok, false)
  assert.equal(blocked.rateCooling, true, '判忙原因必须标注是 429 限流')
  // 确定性等待：轮询到冷却结束（不依赖裸 sleep 与退避时长精确对齐，避免全量跑时事件循环繁忙导致抖动）
  const deadline = Date.now() + 2_000
  while (gate.isCooling('p') && Date.now() < deadline) await sleep(10)
  assert.equal(gate.isCooling('p'), false, 'rate 到期后自动恢复')
  const ok = await gate.acquire('p')
  assert.equal(ok.ok, true)
  ok.release()
})

test('④ last-resort 不碰 rate 冷却候选（全链 429 ⇒ 两次发送后如实失败）', async () => {
  const calls = []
  const events = []
  const gate = createConcurrencyGate({ limits: { a: 2, b: 2, default: 2 } })
  const adapter = createAdapter({
    builtin: [
      { provider: 'a', model: 'ma', tier: 1 },
      { provider: 'b', model: 'mb', tier: 2 },
    ],
    send: async ({ provider }) => { calls.push(provider); throw rateErr() },
    concurrency: gate,
    onEvent: (e) => events.push(e),
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.deepEqual(calls, ['a', 'b'], '两个候选各发送 1 次（不在限流窗口里重打）')
  assert.equal(gate.isRateCooling('a') && gate.isRateCooling('b'), true)
  assert.equal(events.filter((e) => e.type === 'last-resort').length, 0, 'rate 冷却候选不得进 last-resort')
})
