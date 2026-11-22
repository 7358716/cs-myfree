/**
 * cs-myfree — P0-① 候选内原地重试（L0 接进主循环）
 *
 * 背景（真实缺陷，2026-11-22）：
 *   `ladder.onFailure()` 早就按 `retryPerRoute`（默认 2）判好了
 *   「瞬态失败 ⇒ 原地重试 / 超限 ⇒ 换渠道」，但主循环**只消费了 `'report'`**
 *   —— 收到 `action:'retry'` 与收到 `'swap-channel'` 一样都是直接进 for 的下一轮。
 *   实际行为：**一失败就换源**，一次 503 之后 0ms 就换了渠道，`retryPerRoute` 形同虚设。
 *
 * 本文件锁死的契约：
 *   ① 同一候选被调用 **2 次失败后才切换**（= 1 次首试 + retryPerRoute 次原地重试）；
 *   ② 原地重试带退避（非 0ms），且退避递增；
 *   ③ 只有瞬态类才原地重试：429 / 5xx 之外的分支行为不变；
 *   ④ 已提交后失败**绝不**重试（内容收不回来）；
 *   ⑤ 不越预算（maxAttempts / maxElapsed）；
 *   ⑥ 不碰 paid（free_only 下原地重试也不放宽授权）；
 *   ⑦ 不叠加 second-attempt / last-resort（否则同一渠道被打 3~4 次）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAdapter } from '../src/adapter/index.js'
import { createConcurrencyGate } from '../src/adapter/concurrency.js'

async function drain(iter) { for await (const _c of iter) { /* drain */ } }
const err = (status, msg = 'boom') => Object.assign(new Error(msg), { status })

function recorder(behaviors) {
  const calls = []
  const send = async ({ provider, model }) => {
    calls.push(`${provider}/${model}`)
    const b = behaviors(calls.length - 1, provider, calls.length)
    if (b === 'ok') return (async function* () { yield { type: 'text-delta', text: 'ok' } })()
    if (b === 'empty') return (async function* () { /* 无可见增量 */ })()
    throw b
  }
  return { calls, send }
}

const mk = ({ builtin, send, events, gate, budget, blacklist }) => createAdapter({
  builtin,
  send,
  budget,
  blacklist,
  concurrency: gate ?? createConcurrencyGate({
    limits: { a: 2, b: 2, c: 2, p: 2, 'paid-src': 2, default: 2 },
    busyCooldownMs: 5,
  }),
  onEvent: (e) => events.push(e),
})

// ══════════════════════════════════════════════════════════════════════════
// ① 核心验收：2 次失败后才换源
// ══════════════════════════════════════════════════════════════════════════

test('⭐ 核心：同一渠道被调用 2 次失败后才切换（1 首试 + retryPerRoute=1 重试）', async () => {
  const events = []
  // retryPerRoute=1 ⇒ 同一候选应被调用 2 次，第 3 次才轮到别的渠道
  const { calls, send } = recorder((i, provider) => (provider === 'a' ? err(503) : 'ok'))
  const adapter = mk({
    builtin: [
      { provider: 'a', model: 'ma', tier: 1 },
      { provider: 'b', model: 'mb', tier: 2 },
    ],
    send, events, budget: { retryPerRoute: 1 },
  })
  const out = []
  for await (const c of adapter.stream({ model: 'x', messages: [] })) out.push(c)

  assert.deepEqual(calls, ['a/ma', 'a/ma', 'b/mb'],
    '必须「同一渠道打 2 次」之后才换到 b —— 改造前是 a/ma, b/mb（一次 503 就换源）')
  assert.equal(events.filter((e) => e.type === 'in-place-retry').length, 1, '只重试 1 次（retryPerRoute=1）')
  assert.equal(events.filter((e) => e.type === 'in-place-retry')[0].attempt, 1)
  assert.ok(out.some((c) => c.type === 'text-delta'), '切到 b 之后正常出流')
})

test('⭐ 核心：retryPerRoute=2（默认）⇒ 同一渠道连续 3 次失败才换源', async () => {
  const events = []
  const { calls, send } = recorder((i, provider) => (provider === 'a' ? err(500) : 'ok'))
  const adapter = mk({
    builtin: [
      { provider: 'a', model: 'ma', tier: 1 },
      { provider: 'b', model: 'mb', tier: 2 },
    ],
    send, events,   // 用默认 budget（retryPerRoute=2）
  })
  await drain(adapter.stream({ model: 'x', messages: [] }))
  assert.deepEqual(calls, ['a/ma', 'a/ma', 'a/ma', 'b/mb'],
    '默认 retryPerRoute=2 ⇒ a 被调用 3 次（首试 + 2 次原地重试）后才换 b')
  assert.equal(events.filter((e) => e.type === 'in-place-retry').length, 2)
})

test('② 原地重试之间**有退避**（不是 0ms 连打），且逐次递增', async () => {
  const events = []
  const { send } = recorder(() => err(500))
  const adapter = mk({ builtin: [{ provider: 'a', model: 'ma', tier: 1 }], send, events })
  const t0 = Date.now()
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  const elapsed = Date.now() - t0

  const retries = events.filter((e) => e.type === 'in-place-retry')
  assert.equal(retries.length, 2)
  assert.ok(retries[0].backoffMs > 0, '第一次重试必须有退避')
  assert.ok(retries[1].backoffMs > retries[0].backoffMs, '退避应递增（200 → 400ms）')
  assert.ok(elapsed >= retries[0].backoffMs + retries[1].backoffMs,
    `实际耗时 ${elapsed}ms 必须覆盖两次退避之和`)
})

// ══════════════════════════════════════════════════════════════════════════
// ③ 只对瞬态类生效 —— 非瞬态分支行为**完全不变**
// ══════════════════════════════════════════════════════════════════════════

test('③ 429（限流）⇒ **不**原地重试，立刻换源（不走 L0）', async () => {
  const events = []
  const { calls, send } = recorder((i, provider) => (provider === 'a' ? err(429) : 'ok'))
  const adapter = mk({
    builtin: [
      { provider: 'a', model: 'ma', tier: 1 },
      { provider: 'b', model: 'mb', tier: 2 },
    ],
    send, events,
  })
  await drain(adapter.stream({ model: 'x', messages: [] }))
  assert.deepEqual(calls, ['a/ma', 'b/mb'], '429 属 L1（换号），不得在原地重打')
  assert.equal(events.filter((e) => e.type === 'in-place-retry').length, 0)
})

test('③ 403（区域/权限）⇒ 换渠道，不原地重试', async () => {
  const events = []
  const { calls, send } = recorder((i, provider) => (provider === 'a' ? err(403) : 'ok'))
  const adapter = mk({
    builtin: [
      { provider: 'a', model: 'ma', tier: 1 },
      { provider: 'b', model: 'mb', tier: 2 },
    ],
    send, events,
  })
  await drain(adapter.stream({ model: 'x', messages: [] }))
  assert.deepEqual(calls, ['a/ma', 'b/mb'])
  assert.equal(events.filter((e) => e.type === 'in-place-retry').length, 0)
})

test('③ 404（模型不存在）⇒ 换模型，不原地重试', async () => {
  const events = []
  const { calls, send } = recorder((i, provider) => (provider === 'a' ? err(404) : 'ok'))
  const adapter = mk({
    builtin: [
      { provider: 'a', model: 'ma', tier: 1 },
      { provider: 'b', model: 'mb', tier: 2 },
    ],
    send, events,
  })
  await drain(adapter.stream({ model: 'x', messages: [] }))
  assert.deepEqual(calls, ['a/ma', 'b/mb'])
  assert.equal(events.filter((e) => e.type === 'in-place-retry').length, 0)
})

// ══════════════════════════════════════════════════════════════════════════
// ④ 已提交后失败 —— 绝不重试、绝不换源
// ══════════════════════════════════════════════════════════════════════════

test('④ 已提交后失败 ⇒ 不原地重试、也不换源（内容收不回来）', async () => {
  const events = []
  const calls = []
  const adapter = mk({
    builtin: [
      { provider: 'a', model: 'ma', tier: 1 },
      { provider: 'b', model: 'mb', tier: 2 },
    ],
    events,
    send: async ({ provider, model }) => {
      calls.push(`${provider}/${model}`)
      return (async function* () {
        yield { type: 'text-delta', text: '已经吐出去的内容' }
        throw err(500)          // 提交之后的失败
      })()
    },
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.equal(calls.length, 1, '提交后失败只允许 1 次发送（既不重试也不换源）')
  assert.equal(events.filter((e) => e.type === 'in-place-retry').length, 0)
  assert.equal(events.filter((e) => e.type === 'committed-failure').length, 1, '必须留下 committed-failure 事件')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 预算 —— 原地重试不能突破上限
// ══════════════════════════════════════════════════════════════════════════

test('⑤ maxAttempts 收紧 ⇒ 原地重试也受预算约束，绝不超额', async () => {
  const events = []
  const { calls, send } = recorder(() => err(500))
  const adapter = mk({
    builtin: [{ provider: 'a', model: 'ma', tier: 1 }],
    send, events,
    budget: { retryPerRoute: 5, maxAttempts: 2 },   // 重试上限比预算还大
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.equal(calls.length, 2, 'maxAttempts=2 ⇒ 总共只允许发送 2 次')
})

test('⑤ 预算耗尽后不再产出 in-place-retry', async () => {
  const events = []
  const { calls, send } = recorder(() => err(500))
  const adapter = mk({
    builtin: [{ provider: 'a', model: 'ma', tier: 1 }],
    send, events,
    budget: { retryPerRoute: 9, maxAttempts: 2 },
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.equal(events.filter((e) => e.type === 'in-place-retry').length, 1, '第 2 次就耗尽 ⇒ 只重试过 1 次')
  assert.equal(calls.length, 2)
})

// ══════════════════════════════════════════════════════════════════════════
// ⑥ 不碰付费 / 不放大渠道次数
// ══════════════════════════════════════════════════════════════════════════

test('⑥ free_only ⇒ 原地重试只在免费候选上，绝不碰 paid', async () => {
  const events = []
  const { calls, send } = recorder((_i, provider) => (provider === 'paid-src' ? 'ok' : err(500)))
  const adapter = mk({
    builtin: [
      { provider: 'paid-src', model: 'paid-1', tier: 1, paid: true },
      { provider: 'a', model: 'ma', tier: 2 },
    ],
    send, events,
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.equal(calls.some((c) => c.startsWith('paid-src')), false, 'free_only 下 paid 一次都不许打')
  assert.deepEqual(calls, ['a/ma', 'a/ma', 'a/ma'], '免费候选 1 + 2 次原地重试')
})

test('⑥ 不叠加 second-attempt / last-resort（同一渠道最多 1+retryPerRoute 次）', async () => {
  const events = []
  const { calls, send } = recorder(() => err(500))
  const adapter = mk({
    builtin: [
      { provider: 'a', model: 'ma', tier: 1 },
      { provider: 'b', model: 'mb', tier: 2 },
    ],
    send, events,
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  const countOf = (p) => calls.filter((c) => c.startsWith(`${p}/`)).length
  assert.equal(countOf('a'), 3, 'a：首试 + 2 次原地重试')
  assert.equal(countOf('b'), 3, 'b：首试 + 2 次原地重试')
  assert.equal(events.filter((e) => e.type === 'second-attempt').length, 0, '已原地重试 ⇒ 二次尝试不叠加')
  assert.equal(events.filter((e) => e.type === 'last-resort').length, 0, '已原地重试 ⇒ last-resort 不叠加')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑦ 同渠道多模型 —— 重试计数按「路由」独立，不串味
// ══════════════════════════════════════════════════════════════════════════

test('⑦ 同一渠道的两个模型各自独立用完 retryPerRoute（计数不串味）', async () => {
  const events = []
  const { calls, send } = recorder(() => err(500))
  const adapter = mk({
    builtin: [
      { provider: 'a', model: 'm1', tier: 1 },
      { provider: 'a', model: 'm2', tier: 1 },
      { provider: 'b', model: 'm3', tier: 2 },
    ],
    send, events,
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.deepEqual(calls, [
    'a/m1', 'a/m1', 'a/m1',
    'a/m2', 'a/m2', 'a/m2',
    'b/m3', 'b/m3', 'b/m3',
  ], '每个 provider/model 组合各自 1 次首试 + 2 次原地重试')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑧ 关闭自动切换时行为不变
// ══════════════════════════════════════════════════════════════════════════

test('⑧ reasoning-only 不算提交 ⇒ 可以一直原地重试到拿到答案', async () => {
  const events = []
  const calls = []
  const adapter = mk({
    builtin: [{ provider: 'a', model: 'ma', tier: 1 }],
    events,
    send: async ({ provider, model }) => {
      calls.push(`${provider}/${model}`)
      if (calls.length <= 2) {
        return (async function* () {
          yield { type: 'reasoning-delta', text: '想了一下' }   // 不算提交
          throw err(500)
        })()
      }
      return (async function* () { yield { type: 'text-delta', text: '答案' } })()
    },
  })
  const out = []
  for await (const c of adapter.stream({ model: 'x', messages: [] })) out.push(c)
  // 提交点语义：`reasoning-delta` 不算提交 ⇒ 前两次「想了一下然后失败」不消耗提交点，
  // 所以还能继续原地重试，直到第 3 次拿到可见答案。
  assert.equal(calls.length, 3, '前两次都是 reasoning 后失败 ⇒ 可以重试到第 3 次成功')
  assert.ok(out.some((c) => c.type === 'text-delta'), '必须拿到可见答案')
  assert.equal(out.some((c) => JSON.stringify(c).includes('想了一下')), false,
    '提交点之前的 reasoning 不应出现在输出里')
})