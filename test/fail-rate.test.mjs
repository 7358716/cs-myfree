/**
 * cs-myfree — 行为反馈校准（失败率 EWMA）测试（契约 v1.1 §11 修订 1/2）
 *
 * 要证明的事：
 *   1. EWMA 数值：α=0.2，429 权重 1.0、其它失败 0.6、成功 0（首败 1.0 → 次败 0.92 → 成功 0.736）
 *   2. `stats/snapshot` 暴露 `failRate`（无样本 ⇒ 0，不预设"它不可靠"）
 *   3. `failRate` 参与准入排序：同 tier 同负载 ⇒ 失败率低的先上（弱源靠后）
 *   4. adapter 每个失败分支都喂 markFailure（429 / 5xx / 空答案），成功分支走 markSuccess 衰减
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createConcurrencyGate, failSampleWeight, FAIL_EWMA_ALPHA,
} from '../src/adapter/concurrency.js'
import { admitCandidates, candidateScore, ADMISSION_WEIGHTS } from '../src/adapter/admission.js'
import { createAdapter } from '../src/adapter/index.js'
import { createRoutingSnapshot } from '../src/web/routing.js'

async function drain(iter) { for await (const _c of iter) { /* drain */ } }

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps

test('EWMA 参数：α=0.2，429 权重 1.0、其它失败 0.6', () => {
  assert.equal(FAIL_EWMA_ALPHA, 0.2)
  assert.equal(failSampleWeight('RATE_LIMIT'), 1.0)
  assert.equal(failSampleWeight('SERVER'), 0.6)
  assert.equal(failSampleWeight('EMPTY_RESPONSE'), 0.6)
  assert.equal(failSampleWeight(null), 0.6)
})

test('EWMA 数值：首败 1.0 → 次败 0.92 → 成功 0.736（精确断言）', () => {
  const g = createConcurrencyGate()
  assert.equal(g.markFailure('x', 'RATE_LIMIT'), 1.0, '首个样本直接定值')
  assert.ok(near(g.markFailure('x', 'SERVER'), 0.92), '0.2*0.6 + 0.8*1.0 = 0.92')
  g.markSuccess('x')
  assert.ok(near(g.stats('x').failRate, 0.736), '成功权重 0 ⇒ 0.8*0.92 = 0.736')
  // 连续成功逐步衰减（不清零：一次成功洗不白弱源）
  g.markSuccess('x')
  assert.ok(near(g.stats('x').failRate, 0.5888))
  assert.equal(g.stats('x').failSamples, 4)
})

test('无样本的渠道 failRate = 0（"没证据说它不可靠"）', () => {
  const g = createConcurrencyGate()
  assert.equal(g.stats('never-seen').failRate, 0)
  assert.equal(g.snapshot()['never-seen'], undefined, '没访问过的渠道不进快照')
  g.markBusy('y')      // 冷却不进失败率样本
  assert.equal(g.stats('y').failRate, 0, 'markBusy/退避不影响 failRate')
})

test('snapshot() 与 snapshotStats 含 failRate（/state.routing.gate 同口径）', () => {
  const g = createConcurrencyGate()
  g.markFailure('p', 'RATE_LIMIT')
  const snap = g.snapshot()
  assert.equal(snap.p.failRate, 1)
  assert.equal(snap.p.failSamples, 1)
  const routing = createRoutingSnapshot({ gateOf: () => g })()
  assert.equal(routing.gate.p.failRate, 1, '/state.routing.gate 必须暴露 failRate')
})

// ── failRate 参与准入排序（第 5 键）──────────────────────────────────────

test('🔴 同 tier 同负载同 last429At ⇒ failRate 低的排前面（把流量从弱源挪开）', () => {
  const failRates = { weak: 0.9, strong: 0.1 }
  const r = admitCandidates({
    candidates: [
      { provider: 'weak', model: 'mw', tier: 1, _i: 0 },
      { provider: 'strong', model: 'ms', tier: 1, _i: 1 },
    ],
    billingTier: 'free_only',
    failRateOf: (p) => failRates[p] ?? 0,
  })
  assert.deepEqual(r.eligible.map((e) => e.provider), ['strong', 'weak'])
})

test('v1.3 默认（blended）：tier 与 billing 仍最优先，其次才是「负载+可靠性」合成分', () => {
  // tier 优先：tier1 的高失败率候选仍排在 tier2 的可靠候选之前
  const r1 = admitCandidates({
    candidates: [
      { provider: 'tier2-strong', model: 'a', tier: 2 },
      { provider: 'tier1-weak', model: 'b', tier: 1 },
    ],
    failRateOf: (p) => (p === 'tier1-weak' ? 0.9 : 0),
  })
  assert.deepEqual(r1.eligible.map((e) => e.provider), ['tier1-weak', 'tier2-strong'])

  // billing 优先：再可靠的付费候选也排在免费候选之后（授权/成本口径不变）
  const r2 = admitCandidates({
    candidates: [
      { provider: 'paid-perfect', model: 'a', tier: 1, billing: 'paid' },
      { provider: 'free-flaky', model: 'b', tier: 1, billing: 'free' },
    ],
    billingTier: 'paid_allowed',
    failRateOf: (p) => (p === 'free-flaky' ? 1 : 0),
  })
  assert.deepEqual(r2.eligible.map((e) => e.provider), ['free-flaky', 'paid-perfect'])

  // 合成分：同 tier 同 billing ⇒ 「空但失败率高」会输给「有点挤但可靠」
  //   （满载 active>=limit 的候选会先被并发过滤剔除，所以这里用"半满"）
  const loads = { crowded: { active: 2, limit: 4 }, idle: { active: 0, limit: 4 } }
  const failRates = { crowded: 0, idle: 0.3 }
  const r3 = admitCandidates({
    candidates: [
      { provider: 'crowded', model: 'a', tier: 1, billing: 'free' },
      { provider: 'idle', model: 'b', tier: 1, billing: 'free' },
    ],
    loadOf: (p) => loads[p],
    failRateOf: (p) => failRates[p] ?? 0,
  })
  // crowded: 负载 0.5 + 失败率 0 = 0.5 ｜ idle: 负载 0 + 失败率 0.3 = 0.3 ⇒ idle 先
  assert.deepEqual(r3.eligible.map((e) => e.provider), ['idle', 'crowded'])
})

test('candidateScore 是纯函数：权重写死、输入归一化（0..2）、单调', () => {
  assert.deepEqual(ADMISSION_WEIGHTS, { load: 1, failRate: 1 })
  assert.equal(candidateScore({ loadRatio: 0, failRate: 0 }), 0)
  assert.equal(candidateScore({ loadRatio: 1, failRate: 1 }), 2)
  assert.equal(candidateScore({ loadRatio: 0.5, failRate: 0 }), 0.5)
  assert.equal(candidateScore({ loadRatio: 0, failRate: 0.25 }), 0.25)
  // 单调：负载/失败率任一上升，分数不减
  assert.ok(candidateScore({ loadRatio: 0.4, failRate: 0.2 }) < candidateScore({ loadRatio: 0.6, failRate: 0.2 }))
  assert.ok(candidateScore({ loadRatio: 0.4, failRate: 0.2 }) < candidateScore({ loadRatio: 0.4, failRate: 0.5 }))
  // 归一化：越界/非法输入被夹到 0..1，不产生 NaN
  assert.equal(candidateScore({ loadRatio: 9, failRate: -3 }), 1)
  assert.equal(candidateScore({ loadRatio: NaN, failRate: undefined }), 0)
  assert.equal(candidateScore(), 0)
})

test('候选自带 failRate 也生效（没有探针时退回条目字段）', () => {
  const r = admitCandidates({
    candidates: [
      { provider: 'w', model: 'a', tier: 1, failRate: 0.8 },
      { provider: 's', model: 'b', tier: 1, failRate: 0.05 },
    ],
  })
  assert.deepEqual(r.eligible.map((e) => e.provider), ['s', 'w'])
})

// ── adapter 把每个失败喂进 EWMA ──────────────────────────────────────────

test('🔴 adapter 失败分支喂 markFailure：429=1.0、5xx=0.6、空答案=0.6；成功走 markSuccess 衰减', async () => {
  const mk = (provider, send) => {
    const gate = createConcurrencyGate({ limits: { [provider]: 2, default: 2 } })
    const adapter = createAdapter({
      builtin: [{ provider, model: `m-${provider}`, tier: 1 }],
      send,
      concurrency: gate,
    })
    return { gate, adapter }
  }

  // ① 429（RATE_LIMIT）⇒ 权重 1.0
  const a = mk('rl', async () => { throw Object.assign(new Error('HTTP 429 too many'), { status: 429 }) })
  await assert.rejects(() => drain(a.adapter.stream({ model: 'x', messages: [] })))
  assert.equal(a.gate.stats('rl').failRate, 1.0, '429 ⇒ 权重 1.0 的首样本')

  // ② 5xx（SERVER）⇒ 权重 0.6
  const b = mk('err', async () => { throw Object.assign(new Error('HTTP 500 boom'), { status: 500 }) })
  await assert.rejects(() => drain(b.adapter.stream({ model: 'x', messages: [] })))
  assert.ok(near(b.gate.stats('err').failRate, 0.6), '5xx ⇒ 权重 0.6 的首样本')

  // ③ 空答案（EMPTY_RESPONSE）⇒ 权重 0.6（这条分支不抛错，必须显式记样本）
  const c = mk('empty', async () => (async function* () { /* 无可见增量 */ })())
  await assert.rejects(() => drain(c.adapter.stream({ model: 'x', messages: [] })))
  assert.ok(near(c.gate.stats('empty').failRate, 0.6), '空答案 ⇒ 权重 0.6 的首样本')

  // ④ 成功 ⇒ markSuccess 衰减（1.0 → 0.8，不清零）
  const d = mk('ok', async () => (async function* () { yield { type: 'text-delta', text: 'ok' } })())
  d.gate.markFailure('ok', 'RATE_LIMIT')
  await drain(d.adapter.stream({ model: 'x', messages: [] }))
  assert.ok(near(d.gate.stats('ok').failRate, 0.8), '成功必须让失败率按 α=0.2 衰减：1.0 → 0.8')
})

test('准入排序用闸门 failRate：弱源在真实 adapter 里被排到后面', async () => {
  const gate = createConcurrencyGate({ limits: { weak: 2, strong: 2, default: 2 } })
  gate.markFailure('weak', 'RATE_LIMIT')     // weak 有失败史
  const order = []
  const adapter = createAdapter({
    builtin: [
      { provider: 'weak', model: 'mw', tier: 1, _i: 0 },
      { provider: 'strong', model: 'ms', tier: 1, _i: 1 },
    ],
    send: async ({ provider }) => {
      order.push(provider)
      throw Object.assign(new Error('HTTP 500 boom'), { status: 500 })
    },
    concurrency: gate,
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.deepEqual(order.slice(0, 2), ['strong', 'weak'], '失败率低的候选必须先被尝试')
  // 第 3 次是 v1.4「二次尝试」：对最后失败的 weak 再试一次（仍不改准入顺序）
  assert.deepEqual(order, ['strong', 'weak', 'weak'])
})
