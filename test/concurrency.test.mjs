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

test('🔴 超限 ⇒ 立即返回 busy（主管要求：不排队，由上层降级）', async () => {
  const g = createConcurrencyGate({ limits: { x: 1, default: 1 } })
  const a = await g.acquire('x')
  const r = await g.acquire('x')          // 必须**立即**返回，不能等
  assert.equal(r.ok, false, '满了要立刻拒绝')
  assert.equal(r.code, 'CHANNEL_BUSY')
  assert.equal(r.active, 1)
  assert.equal(r.limit, 1)
  assert.match(r.reason, /并发已满/)
  assert.equal(g.snapshot().x.queued, 0, '不排队 ⇒ queue 必须为 0')
  a.release()
  const b = await g.acquire('x')
  assert.equal(b.ok, true, '释放后应能立即拿到')
  b.release()
})

test('queue 模式仍可用（显式开启时才排队）', async () => {
  const g = createConcurrencyGate({ limits: { x: 1, default: 1 }, mode: 'queue', waitTimeoutMs: 2000 })
  const a = await g.acquire('x')
  let got = false
  const p = g.acquire('x').then((r) => { got = true; return r })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(got, false)
  assert.equal(g.snapshot().x.queued, 1)
  a.release()
  const b = await p
  assert.equal(got, true)
  b.release()
})

test('queue 模式排队超时 ⇒ 抛 CHANNEL_BUSY（不静默卡死）', async () => {
  const g = createConcurrencyGate({ limits: { x: 1, default: 1 }, mode: 'queue', waitTimeoutMs: 100 })
  const a = await g.acquire('x')
  await assert.rejects(() => g.acquire('x'), (e) => e.code === 'CHANNEL_BUSY' && /并发已满/.test(e.message))
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

test('🔴 adapter：并发超限 ⇒ 自动降级到备用渠道（不排队、不超并发）', async () => {
  // p 上限 1（会忙），backup 上限 5（有空位）
  const gate = createConcurrencyGate({ limits: { p: 1, backup: 5, default: 2 } })
  const used = []
  let pConcurrent = 0
  let pMax = 0
  const adapter = createAdapter({
    builtin: [
      { provider: 'p', model: 'm', tier: 1 },
      { provider: 'backup', model: 'mb', tier: 2 },
    ],
    send: async ({ provider }) => {
      used.push(provider)
      if (provider === 'p') { pConcurrent++; pMax = Math.max(pMax, pConcurrent) }
      return (async function* () {
        try {
          await new Promise((r) => setTimeout(r, 50))
          yield { type: 'text-delta', text: 'x' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        } finally { if (provider === 'p') pConcurrent-- }
      })()
    },
    concurrency: gate,
  })

  // 先占满 p 的名额
  const hog = await gate.acquire('p')
  const chunks = []
  for await (const c of adapter.stream({ model: 'm', messages: [] })) chunks.push(c)
  assert.ok(chunks.some((c) => c.type === 'text-delta'), '应降级到 backup 并成功')
  assert.ok(used.includes('backup'), '必须降级到备用渠道：' + used.join(','))
  assert.equal(pMax, 0, 'p 已满 ⇒ 不应该再对 p 发请求（不超并发）')
  hog.release()
})

// ── 共享闸门（真实缺陷回归）──
test('🔴 进程级共享闸门：adapter 与 login/test 必须共用同一份名额', async () => {
  const { getSharedGate, resetSharedGate, BUSY_CODE } = await import('../src/adapter/concurrency.js')
  resetSharedGate()
  const g1 = getSharedGate({ limits: { x: 1, default: 1 } })
  const g2 = getSharedGate()
  assert.equal(g1, g2, '必须是同一个实例（否则两条路径各算各的名额）')
  const a = await g1.acquire('x')
  const busy = await g2.acquire('x')
  assert.equal(busy.ok, false, '共享 ⇒ 第二个入口也应看到满')
  assert.equal(busy.code, BUSY_CODE)
  a.release()
  const c = await g2.acquire('x')
  assert.equal(c.ok, true)
  c.release()
  resetSharedGate()
})

test('adapter 默认使用共享闸门（不是自己 new 一个）', async () => {
  const { getSharedGate, resetSharedGate } = await import('../src/adapter/concurrency.js')
  resetSharedGate()
  const g = getSharedGate({ limits: { p: 1, default: 1 } })
  const hog = await g.acquire('p')
  const adapter = createAdapter({
    builtin: [{ provider: 'p', model: 'm', tier: 1 }, { provider: 'q', model: 'mq', tier: 2 }],
    send: async ({ provider }) => (async function* () {
      if (provider === 'p') throw Object.assign(new Error('should not reach p'), { code: 'SERVER', status: 500 })
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  })
  const chunks = []
  for await (const c of adapter.stream({ model: 'm', messages: [] })) chunks.push(c)
  assert.ok(chunks.some((c) => c.type === 'text-delta'), '应降级到 q 并成功')
  hog.release()
  resetSharedGate()
})
