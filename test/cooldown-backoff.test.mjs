/**
 * cs-myfree — 冷却期**指数退避**测试（契约 §4 / §7.6）
 *
 * 要证明的事：
 *   1. 曲线 15s → 30s → 60s → 120s → 120s（连续 429 逐次翻倍、封顶）
 *   2. 成功一次 ⇒ 计数归零，下次冲突重新从 15s 起算
 *   3. 显式 `markBusy(p, ms)` 仍以显式值为准（兼容既有调用/测试）
 *   4. `stats(provider)` / `snapshot()` 暴露准入器需要的字段
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createConcurrencyGate, COOLDOWN_BASE_MS, COOLDOWN_MAX_MS,
} from '../src/adapter/concurrency.js'
import { createAdapter } from '../src/adapter/index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('退避曲线：15s → 30s → 60s → 120s → 120s（封顶）', () => {
  const g = createConcurrencyGate()   // 默认 base 15s / max 120s
  assert.equal(COOLDOWN_BASE_MS, 15_000)
  assert.equal(COOLDOWN_MAX_MS, 120_000)
  const got = [1, 2, 3, 4, 5, 6].map(() => g.markBusy('x'))
  assert.deepEqual(got, [15_000, 30_000, 60_000, 120_000, 120_000, 120_000])
  assert.equal(g.stats('x').streak429, 6)
})

test('成功一次 ⇒ streak429 归零，下次冲突重新 15s（并清冷却）', () => {
  const g = createConcurrencyGate()
  g.markBusy('x'); g.markBusy('x'); g.markBusy('x')
  assert.equal(g.stats('x').streak429, 3)
  g.markSuccess('x')
  assert.equal(g.stats('x').streak429, 0, '成功必须重置退避曲线')
  assert.equal(g.stats('x').coolingMs, 0, '成功必须清冷却')
  assert.ok(g.stats('x').lastSuccessAt > 0)
  assert.equal(g.markBusy('x'), 15_000, '重置后从基础值重新起算')
})

test('显式 markBusy(p, ms) 以显式值为准（兼容旧调用）', () => {
  const g = createConcurrencyGate({ busyCooldownMs: 15_000 })
  assert.equal(g.markBusy('x', 2_000), 2_000)
  assert.ok(g.stats('x').coolingMs <= 2_000)
  // 连续冲突也不会把显式值放大
  assert.equal(g.markBusy('x', 2_000), 2_000)
})

test('stats(provider)：字段齐全且语义正确', async () => {
  const g = createConcurrencyGate({ limits: { x: 2, default: 2 } })
  const empty = g.stats('x')
  assert.deepEqual(
    { active: empty.active, limit: empty.limit, ratio: empty.ratio, streak429: empty.streak429, last429At: empty.last429At },
    { active: 0, limit: 2, ratio: 0, streak429: 0, last429At: 0 },
  )
  const a = await g.acquire('x')
  const s1 = g.stats('x')
  assert.equal(s1.active, 1)
  assert.equal(s1.ratio, 0.5)
  a.release()
  assert.equal(g.stats('x').active, 0)

  g.markBusy('x', 500)
  const s2 = g.stats('x')
  assert.ok(s2.coolingMs > 0 && s2.coolingMs <= 500)
  assert.equal(s2.streak429, 1)
  assert.ok(s2.last429At > 0)
})

test('snapshot() 增加 streak429 / last429At / lastSuccessAt（诊断页字段）', () => {
  const g = createConcurrencyGate({ limits: { x: 1, default: 1 } })
  g.markBusy('x')
  const snap = g.snapshot()
  assert.equal(snap.x.active, 0)
  assert.equal(snap.x.limit, 1)
  assert.equal(snap.x.streak429, 1)
  assert.ok(snap.x.last429At > 0)
  assert.equal(snap.x.lastSuccessAt, 0)
  g.markSuccess('x')
  const snap2 = g.snapshot()
  assert.equal(snap2.x.streak429, 0)
  assert.ok(snap2.x.lastSuccessAt > 0)
})

test('冷却期内的 acquire 直接判忙（cooling:true），退避生效', async () => {
  const g = createConcurrencyGate({ limits: { x: 1, default: 1 }, busyCooldownMs: 40, maxCooldownMs: 200 })
  g.markBusy('x')                                  // 40ms
  const r = await g.acquire('x')
  assert.equal(r.ok, false)
  assert.equal(r.cooling, true)
  await sleep(60)
  const r2 = await g.acquire('x')
  assert.equal(r2.ok, true, '冷却到期应恢复')
  r2.release()
})

test('🔴 adapter 成功 ⇒ gate.markSuccess（冷却/计数归零）', async () => {
  const gate = createConcurrencyGate({ limits: { p: 2, default: 2 }, busyCooldownMs: 30, maxCooldownMs: 200 })
  const adapter = createAdapter({
    builtin: [{ provider: 'p', model: 'm', tier: 1 }],
    send: async () => (async function* () {
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
    concurrency: gate,
  })
  gate.markBusy('p')
  assert.equal(gate.stats('p').streak429, 1)
  await sleep(40)                                   // 等冷却过期
  const out = []
  for await (const c of adapter.stream({ model: 'm', messages: [] })) out.push(c)
  assert.ok(out.some((c) => c.type === 'text-delta'))
  assert.equal(gate.stats('p').streak429, 0, '成功分支必须调 markSuccess')
  assert.equal(gate.stats('p').coolingMs, 0)
})

test('🔴 adapter 连续报满 ⇒ streak 递增、单次冷却变长（退避驱动降级）', async () => {
  const gate = createConcurrencyGate({ limits: { codearts: 2, backup: 2, default: 2 }, busyCooldownMs: 20, maxCooldownMs: 500 })
  const adapter = createAdapter({
    builtin: [
      { provider: 'codearts', model: 'm', tier: 1 },
      { provider: 'backup', model: 'mb', tier: 2 },
    ],
    send: async ({ provider }) => {
      if (provider === 'codearts') {
        throw Object.assign(new Error('渠道 codearts 并发会话已满（上游限制 3 个）'), { status: 400, code: 'INVALID_REQUEST' })
      }
      return (async function* () {
        yield { type: 'text-delta', text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    concurrency: gate,
  })
  const run = async () => { for await (const _c of adapter.stream({ model: 'm', messages: [] })) { /* drain */ } }

  await run()
  assert.equal(gate.stats('codearts').streak429, 1)
  assert.ok(gate.stats('codearts').coolingMs > 0)
  await sleep(25)                                    // 20ms 冷却过期
  await run()
  assert.equal(gate.stats('codearts').streak429, 2, '第二次报满 ⇒ 计数递增')
  await sleep(45)                                    // 第二次冷却 40ms 过期（否则会被准入器按冷却跳过）
  const before = gate.stats('codearts').coolingMs
  await run()
  assert.equal(gate.stats('codearts').streak429, 3)
  // 第三次冷却（40ms）必须比第一次（20ms）长：退避真的在拉长
  assert.ok(gate.stats('codearts').coolingMs > before, '退避曲线必须逐次变长')
})

// ── 429 必须喂闸门（改造 4 在真实路径生效的唯一前提）──────────────────

/** 排空一个流 */
async function drain(iter) { for await (const _c of iter) { /* drain */ } }

test('🔴 429（KIND.RATE_LIMIT）⇒ 写 rate 冷却、streak429 递增（退避曲线真实可跑）', async () => {
  // 429 走 rate 冷却（契约 v1.4，基础值默认 15s）；这里调小以便在测试内观察两次连续 429
  const gate = createConcurrencyGate({ limits: { rl: 2, ok: 2, default: 2 }, busyCooldownMs: 30, rateLimitCooldownMs: 30, maxCooldownMs: 400 })
  let rlShouldFail = true
  const adapter = createAdapter({
    builtin: [
      { provider: 'rl', model: 'm1', tier: 1 },
      { provider: 'ok', model: 'm2', tier: 2 },
    ],
    send: async ({ provider }) => {
      if (provider === 'rl' && rlShouldFail) {
        throw Object.assign(new Error('HTTP 429: rate limit exceeded'), { status: 429 })
      }
      return (async function* () {
        yield { type: 'text-delta', text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    concurrency: gate,
  })

  await drain(adapter.stream({ model: 'm1', messages: [] }))
  assert.equal(gate.stats('rl').streak429, 1, '429 必须喂闸门（旧实现只认「并发已满」⇒ 恒 0）')
  assert.ok(gate.stats('rl').last429At > 0, 'last429At 必须记录（准入排序第 4 项依赖它）')
  assert.ok(gate.stats('rl').rateCoolingMs > 0, '429 后该渠道应进入 **rate** 冷却（并发满才是 busy 冷却）')
  assert.equal(gate.stats('rl').rateCooling, true)

  // 冷却过期后再 429 一次 ⇒ streak 递增（退避 30ms → 60ms）
  await sleep(35)
  await drain(adapter.stream({ model: 'm1', messages: [] }))
  assert.equal(gate.stats('rl').streak429, 2, '连续 429 ⇒ streak 递增')
  assert.ok(gate.stats('rl').rateCoolingMs > 30, 'rate 冷却必须按指数退避变长')

  // 成功一次 ⇒ markSuccess 清零（曲线重置）
  rlShouldFail = false
  await sleep(65)
  const out = []
  for await (const c of adapter.stream({ model: 'm1', messages: [] })) out.push(c)
  assert.ok(out.some((c) => c.type === 'text-delta'))
  assert.equal(gate.stats('rl').streak429, 0, '成功分支必须 markSuccess ⇒ 计数归零')
  assert.equal(gate.stats('rl').coolingMs, 0)
})

test('🔴 全冷却 ⇒ 有且仅有一次 cooldown-retry，且 billing 绝不放宽（paid 仍 0 次尝试）', async () => {
  const events = []
  const attempts = []
  // 冷却期设得比重试等待（1200ms）长，确保「主循环全被冷却挡住」这条路径必然触发
  const gate = createConcurrencyGate({ limits: { f1: 2, f2: 2, 'paid-src': 2, default: 2 }, busyCooldownMs: 5_000 })
  gate.markBusy('f1')
  gate.markBusy('f2')
  const adapter = createAdapter({
    builtin: [
      { provider: 'paid-src', model: 'paid-1', tier: 1, paid: true },
      { provider: 'f1', model: 'm1', tier: 2 },
      { provider: 'f2', model: 'm2', tier: 3 },
    ],
    send: async ({ provider }) => {
      attempts.push(provider)
      throw Object.assign(new Error('HTTP 500: boom'), { status: 500 })
    },
    concurrency: gate,
    onEvent: (e) => events.push(e),
  })

  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  // ① 有且仅有一次兜底重试
  const retries = events.filter((e) => e.type === 'cooldown-retry')
  assert.equal(retries.length, 1, '兜底重试必须只有一次（有界、不循环）')
  assert.equal(retries[0].billingTier, 'free_only')
  assert.equal(retries[0].kept, 2, '冷却放宽后只保留 free 候选（paid 仍被授权过滤）')
  assert.equal(retries[0].cooldownSkips, 2)
  // ② billing 绝不放宽：付费候选一次都没被尝试（重试/最后兜底里也没有）
  assert.equal(attempts.includes('paid-src'), false, '付费候选在 free_only 下零尝试（任何重试都不放宽授权）')
  // ③ 前两次来自有界重试；第三次是 v1.4「二次尝试」（对最后失败的 f2 再试一次）
  assert.deepEqual(attempts.slice(0, 2), ['f1', 'f2'], '主循环被冷却挡住 ⇒ 重试按准入序试 f1/f2')
  assert.equal(attempts.length, 3, '二次尝试再发 1 次（每请求至多一次，不循环）')
  assert.equal(events.filter((e) => e.type === 'second-attempt').length, 1)
  assert.equal(events.filter((e) => e.type === 'last-resort').length, 0, '已用二次尝试 ⇒ 不再叠加 last-resort')
})

// ── 同请求内「同一候选不得尝试两次」（Lead v1.2 硬要求）─────────────────

test('🔴 兜底重试不回打已尝试过的候选：单候选链只发送 1 次（失败即失败）', async () => {
  const calls = []
  // 冷却很短（20ms）⇒ 等待 1200ms 后它早已不在冷却；若去重失效就会被二次发送
  const gate = createConcurrencyGate({ limits: { only: 2, default: 2 }, busyCooldownMs: 20, maxCooldownMs: 100 })
  const adapter = createAdapter({
    builtin: [{ provider: 'only', model: 'm', tier: 1 }],
    send: async ({ provider }) => {
      calls.push(provider)
      throw Object.assign(new Error('HTTP 429 rate limited'), { status: 429 })
    },
    concurrency: gate,
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.deepEqual(calls, ['only'], '同一候选在一次请求里不得被发送两次')
})

test('🔴 重试只打「本轮没发送过」的候选（冷却中的 B 会被重试，已失败的 A 不会）', async () => {
  const calls = []
  const gate = createConcurrencyGate({ limits: { a: 2, b: 2, default: 2 }, busyCooldownMs: 5_000 })
  gate.markBusy('b')                     // B 一开始就在冷却 ⇒ 主循环不会发送它
  const events = []
  const adapter = createAdapter({
    builtin: [
      { provider: 'a', model: 'ma', tier: 1 },
      { provider: 'b', model: 'mb', tier: 2 },
    ],
    send: async ({ provider }) => {
      calls.push(provider)
      throw Object.assign(new Error('HTTP 500 boom'), { status: 500 })
    },
    concurrency: gate,
    onEvent: (e) => events.push(e),
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  // 前两次：主循环 a + 重试里的 b（b 被冷却跳过、本轮未发送过）
  assert.deepEqual(calls.slice(0, 2), ['a', 'b'], 'A 只试一次；B（被冷却跳过）在兜底重试里试一次')
  // 第三次来自 v1.4「二次尝试」（对最后失败的 b 再试一次；不再叠加 last-resort）
  assert.equal(calls.length, 3, '非 429 瞬时失败允许一次二次尝试')
  assert.deepEqual(calls, ['a', 'b', 'b'])
  assert.equal(events.filter((e) => e.type === 'cooldown-retry').length, 1)
  assert.equal(events.filter((e) => e.type === 'second-attempt').length, 1)
  assert.equal(events.filter((e) => e.type === 'last-resort').length, 0)
})

// ── 契约 v1.3：纯本地饱和允许**第二段**有界等待（总计 ≤2 段 / ≤2.4s）───────

test('🔴 零发送 + 全被本地闸门判忙 ⇒ 允许第二段有界等待（round 1、2 各一次事件）', async () => {
  const calls = []
  const events = []
  const gate = createConcurrencyGate({ limits: { p: 1, default: 1 } })
  const hog = await gate.acquire('p')          // 占满唯一名额 ⇒ 全程本地饱和（零上游发送）
  const adapter = createAdapter({
    builtin: [{ provider: 'p', model: 'm', tier: 1 }],
    send: async ({ provider }) => { calls.push(provider); return (async function* () { yield { type: 'text-delta', text: 'ok' } })() },
    concurrency: gate,
    onEvent: (e) => events.push(e),
  })
  await assert.rejects(
    () => drain(adapter.stream({ model: 'x', messages: [] })),
    (e) => e.code === 'CHANNEL_BUSY',
  )
  const retries = events.filter((e) => e.type === 'cooldown-retry')
  assert.equal(retries.length, 2, '纯本地饱和允许第二段等待（仅此情形）')
  assert.deepEqual(retries.map((r) => r.round), [1, 2])
  assert.equal(retries[1].reason, 'LOCAL_SATURATION')
  assert.deepEqual(calls, [], '本地饱和期间不应有任何上游发送（不越并发上限）')
  hog.release()
})

test('🔴 有上游发送的失败 ⇒ **不**补第二段（避免变成排队）', async () => {
  const calls = []
  const events = []
  const gate = createConcurrencyGate({ limits: { a: 2, b: 2, default: 2 }, busyCooldownMs: 5_000 })
  gate.markBusy('b')
  const adapter = createAdapter({
    builtin: [
      { provider: 'a', model: 'ma', tier: 1 },
      { provider: 'b', model: 'mb', tier: 2 },
    ],
    send: async ({ provider }) => { calls.push(provider); throw Object.assign(new Error('HTTP 500 boom'), { status: 500 }) },
    concurrency: gate,
    onEvent: (e) => events.push(e),
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.equal(events.filter((e) => e.type === 'cooldown-retry').length, 1, '有发送 ⇒ 只做一次有界重试')
  assert.deepEqual(calls.slice(0, 2), ['a', 'b'], '主循环 a + 重试 b')
  assert.equal(events.filter((e) => e.type === 'second-attempt').length, 1, '非 429 瞬时失败 ⇒ 恰好一次二次尝试')
})
