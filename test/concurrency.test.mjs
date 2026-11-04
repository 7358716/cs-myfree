/**
 * cs-myfree — 渠道并发闸门测试
 *
 * 背景（用户实测「直接中断停摆次数过多」的真实根因）：
 *   codearts 上游并发会话上限 3 个，超了直接拒绝。adapter 逐候选重试时
 *   不释放会话名额 ⇒ 名额被占满 ⇒ 后续请求全部失败（表现就是连续停摆）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConcurrencyGate, DEFAULT_LIMITS } from '../src/adapter/concurrency.js'
import { createAdapter } from '../src/adapter/index.js'

test('codearts 默认上限是 3（对齐上游实测的并发会话限制）', () => {
  assert.equal(DEFAULT_LIMITS.codearts, 3)
  assert.ok(DEFAULT_LIMITS.kilo >= 2, '免密源不该限成 1')
})

test('未超限 ⇒ 立即拿到名额', async () => {
  const g = createConcurrencyGate({ limits: { x: 2, default: 2 }, waitTimeoutMs: 500 })
  const a = await g.acquire('x')
  const b = await g.acquire('x')
  assert.equal(g.snapshot().x.active, 2)
  a.release(); b.release()
  assert.equal(g.snapshot().x.active, 0)
})

test('🔴 超限 ⇒ 排队等待（不是立即失败）', async () => {
  const g = createConcurrencyGate({ limits: { x: 1, default: 1 }, waitTimeoutMs: 2000 })
  const a = await g.acquire('x')
  let secondGot = false
  const p = g.acquire('x').then((r) => { secondGot = true; return r })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(secondGot, false, '名额满时应排队，而不是直接拒绝')
  assert.equal(g.snapshot().x.queued, 1)
  a.release()
  const b = await p
  assert.equal(secondGot, true, '释放后排队者应立即拿到')
  b.release()
  assert.equal(g.snapshot().x.active, 0)
})

test('排队超时 ⇒ 抛 RATE_LIMIT（不静默卡死）', async () => {
  const g = createConcurrencyGate({ limits: { x: 1, default: 1 }, waitTimeoutMs: 100 })
  const a = await g.acquire('x')
  await assert.rejects(() => g.acquire('x'), (e) => e.code === 'RATE_LIMIT' && /并发已满/.test(e.message))
  a.release()
})

test('名额不泄漏：重复 release 不会把 active 减成负数', async () => {
  const g = createConcurrencyGate({ limits: { x: 2, default: 2 }, waitTimeoutMs: 500 })
  const a = await g.acquire('x')
  a.release(); a.release(); a.release()
  assert.equal(g.snapshot().x.active, 0, 'active 不得为负')
})

test('不同渠道互不影响（各算各的名额）', async () => {
  const g = createConcurrencyGate({ limits: { a: 1, b: 1, default: 1 }, waitTimeoutMs: 500 })
  const sa = await g.acquire('a')
  const sb = await g.acquire('b')
  assert.equal(g.snapshot().a.active, 1)
  assert.equal(g.snapshot().b.active, 1)
  sa.release(); sb.release()
})

test('🔴 adapter：抛错的候选也必须释放名额（否则名额泄漏 ⇒ 停摆）', async () => {
  const gate = createConcurrencyGate({ limits: { bad: 1, good: 1, default: 1 }, waitTimeoutMs: 300 })
  const adapter = createAdapter({
    builtin: [{ provider: 'bad', model: 'm1', tier: 1 }, { provider: 'good', model: 'm2', tier: 2 }],
    send: async ({ provider }) => {
      if (provider === 'bad') throw Object.assign(new Error('boom'), { code: 'SERVER', status: 500 })
      return (async function* () { yield { type: 'text-delta', text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } } })()
    },
    concurrency: gate,
  })
  const chunks = []
  for await (const c of adapter.stream({ model: 'm1', messages: [] })) chunks.push(c)
  assert.ok(chunks.some((c) => c.type === 'text-delta'))
  // 关键：失败的 bad 渠道名额必须已释放
  assert.equal(gate.snapshot().bad.active, 0, '失败候选的名额必须释放，否则第二次调用会排队超时')
  // 再跑一次必须仍能成功（证明没有泄漏）
  const chunks2 = []
  for await (const c of adapter.stream({ model: 'm1', messages: [] })) chunks2.push(c)
  assert.ok(chunks2.some((c) => c.type === 'text-delta'), '第二次调用应仍成功（名额没泄漏）')
})

test('adapter：并发的多个 stream 会按渠道上限排队而不是全挂', async () => {
  const gate = createConcurrencyGate({ limits: { p: 1, default: 1 }, waitTimeoutMs: 3000 })
  let concurrent = 0
  let maxConcurrent = 0
  const adapter = createAdapter({
    builtin: [{ provider: 'p', model: 'm', tier: 1 }],
    send: async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      return (async function* () {
        try {
          await new Promise((r) => setTimeout(r, 60))
          yield { type: 'text-delta', text: 'x' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        } finally { concurrent-- }
      })()
    },
    concurrency: gate,
  })
  const runs = await Promise.all(Array.from({ length: 3 }, async () => {
    let n = 0
    for await (const _ of adapter.stream({ model: 'm', messages: [] })) n++
    return n
  }))
  assert.ok(runs.every((n) => n > 0), '3 个并发都必须成功（排队而非失败）')
  assert.equal(maxConcurrent, 1, '渠道上限 1 ⇒ 实际并发必须为 1（证明排队生效）')
})
