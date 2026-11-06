/**
 * cs-myfree — 候选准入流水线测试（契约 §2/§7.4/§7.5）
 *
 * 三组要证明的事：
 *   1. 纯函数的边界表（空集 / 全 paid / 未知 billing / limit=0 / 全冷却）
 *   2. 排序严格按 tier → billing → loadRatio → last429At → _i，pinned 保留首位
 *   3. **授权 fail-closed**：free_only 下付费候选一次都不会被尝试（用假 send 记录调用）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  admitCandidates, resolveBilling, normalizeBillingTier, BILLING, BILLING_TIER,
} from '../src/adapter/admission.js'
import { createAdapter } from '../src/adapter/index.js'
import { createConcurrencyGate } from '../src/adapter/concurrency.js'

/** 表驱动小工具：跑一组 [{name, input, expect}] */
function eachCase(cases, fn) {
  for (const c of cases) {
    if (c.skip) continue
    fn(c)
  }
}

async function collect(iter) { const out = []; for await (const x of iter) out.push(x); return out }

// ── ① 归一化与 billing 解析（纯函数）──────────────────────────────────

test('normalizeBillingTier：除 paid_allowed 外一律 free_only（fail-closed）', () => {
  eachCase([
    { input: 'paid_allowed', expect: BILLING_TIER.PAID_ALLOWED },
    { input: 'PAID_ALLOWED', expect: BILLING_TIER.PAID_ALLOWED },
    { input: ' paid_allowed ', expect: BILLING_TIER.PAID_ALLOWED },
    { input: 'free_only', expect: BILLING_TIER.FREE_ONLY },
    { input: 'FREE_ONLY', expect: BILLING_TIER.FREE_ONLY },
    { input: '', expect: BILLING_TIER.FREE_ONLY },
    { input: 'yes', expect: BILLING_TIER.FREE_ONLY },
    { input: undefined, expect: BILLING_TIER.FREE_ONLY },
    { input: null, expect: BILLING_TIER.FREE_ONLY },
    { input: 1, expect: BILLING_TIER.FREE_ONLY },
    { input: true, expect: BILLING_TIER.FREE_ONLY },
    { input: {}, expect: BILLING_TIER.FREE_ONLY },
  ], (c) => {
    assert.equal(normalizeBillingTier(c.input), c.expect, `输入 ${JSON.stringify(c.input)}`)
  })
})

test('resolveBilling：优先级 entry.billing > paid===true > channel > pricing > unknown', () => {
  eachCase([
    // entry.billing 显式声明最高优先级（即使 paid:true 也以显式声明为准）
    { name: 'entry=paid', entry: { billing: 'paid' }, opt: { channelBilling: 'free', priced: false }, expect: { billing: BILLING.PAID, source: 'entry' } },
    { name: 'entry=free 压过 paid', entry: { billing: 'free', paid: true }, opt: {}, expect: { billing: BILLING.FREE, source: 'entry' } },
    { name: 'entry=unknown 也尊重', entry: { billing: 'unknown' }, opt: {}, expect: { billing: BILLING.UNKNOWN, source: 'entry' } },
    // 非法 entry.billing 被忽略 ⇒ 落到下一级
    { name: '非法 entry.billing ⇒ channel', entry: { billing: 'weird' }, opt: { channelBilling: 'free' }, expect: { billing: BILLING.FREE, source: 'channel' } },
    { name: 'paid:true ⇒ entry-paid', entry: { paid: true }, opt: { channelBilling: 'free' }, expect: { billing: BILLING.PAID, source: 'entry-paid' } },
    { name: 'paid:false ⇒ free', entry: { paid: false }, opt: {}, expect: { billing: BILLING.FREE, source: 'entry-paid' } },
    { name: 'channelBilling=paid', entry: {}, opt: { channelBilling: 'paid' }, expect: { billing: BILLING.PAID, source: 'channel' } },
    { name: 'priced=true ⇒ paid', entry: {}, opt: { priced: true }, expect: { billing: BILLING.PAID, source: 'pricing' } },
    { name: 'priced=正数 ⇒ paid', entry: {}, opt: { priced: 0.0001 }, expect: { billing: BILLING.PAID, source: 'pricing' } },
    { name: 'priced=false ⇒ free', entry: {}, opt: { priced: false }, expect: { billing: BILLING.FREE, source: 'pricing' } },
    { name: 'priced=0 ⇒ free', entry: {}, opt: { priced: 0 }, expect: { billing: BILLING.FREE, source: 'pricing' } },
    { name: '全都没有 ⇒ unknown', entry: {}, opt: {}, expect: { billing: BILLING.UNKNOWN, source: 'default' } },
    { name: 'entry 为 null 不炸', entry: null, opt: {}, expect: { billing: BILLING.UNKNOWN, source: 'default' } },
  ], (c) => {
    assert.deepEqual(resolveBilling(c.entry, c.opt), c.expect, c.name)
  })
})

// ── ② 准入流水线的边界表 ──────────────────────────────────────────────

test('空候选集：不抛错、kept=0、无 relaxed', () => {
  const r = admitCandidates({ candidates: [], billingTier: 'free_only' })
  assert.deepEqual(r.eligible, [])
  assert.deepEqual(r.excluded, [])
  assert.deepEqual(r.stats, {
    total: 0, kept: 0, droppedBilling: 0, droppedBlacklist: 0, droppedCooldown: 0,
    droppedConcurrency: 0, relaxed: null, billingTier: 'free_only',
  })
})

test('未传 billingTier ⇒ 默认 free_only（fail-closed）', () => {
  const r = admitCandidates({
    candidates: [{ provider: 'p', model: 'm', tier: 1, paid: true }],
  })
  assert.equal(r.stats.billingTier, 'free_only')
  assert.equal(r.eligible.length, 0)
  assert.equal(r.stats.droppedBilling, 1)
})

test('全 paid：free_only ⇒ 全剔除且原因可审计；paid_allowed ⇒ 全保留', () => {
  const candidates = [
    { provider: 'a', model: 'm1', tier: 1, billing: 'paid' },
    { provider: 'b', model: 'm2', tier: 2, billing: 'paid' },
  ]
  const denied = admitCandidates({ candidates, billingTier: 'free_only' })
  assert.equal(denied.eligible.length, 0)
  assert.equal(denied.stats.droppedBilling, 2)
  assert.deepEqual(denied.excluded.map((x) => x.reason), ['billing', 'billing'])
  assert.equal(denied.excluded[0].candidate.provider, 'a')

  const allowed = admitCandidates({ candidates, billingTier: 'paid_allowed' })
  assert.equal(allowed.eligible.length, 2)
  assert.equal(allowed.stats.droppedBilling, 0)
  assert.deepEqual(allowed.excluded, [])
})

test('未知 billing 按 free 处理（排序上等同免费，成本保守）', () => {
  const r = admitCandidates({
    candidates: [
      { provider: 'unknown-src', model: 'm', tier: 1 },
      { provider: 'paid-src', model: 'p', tier: 1, billing: 'paid' },
    ],
    billingTier: 'paid_allowed',
  })
  assert.deepEqual(r.eligible.map((e) => e.provider), ['unknown-src', 'paid-src'])
})

test('全冷却 ⇒ 兜底回退到「只做付费过滤」的集合，并标注 relaxed=cooldown', () => {
  const candidates = [
    { provider: 'a', model: 'm1', tier: 1 },
    { provider: 'b', model: 'm2', tier: 2 },
  ]
  const r = admitCandidates({
    candidates,
    billingTier: 'free_only',
    isCooling: () => true,
  })
  assert.equal(r.stats.relaxed, 'cooldown')
  assert.equal(r.eligible.length, 2, '冷却只是省往返，不该把链清空')
  assert.equal(r.stats.droppedCooldown, 0, '回退后不算「被剔除」')
  assert.equal(r.stats.kept, 2)
})

test('全并发满 ⇒ relaxed=concurrency（仍交给闸门兜底，失败语义不变）', () => {
  const r = admitCandidates({
    candidates: [{ provider: 'a', model: 'm1', tier: 1 }],
    billingTier: 'free_only',
    loadOf: () => ({ active: 3, limit: 3 }),
  })
  assert.equal(r.stats.relaxed, 'concurrency')
  assert.equal(r.eligible.length, 1)
})

test('🔴 兜底绝不回退 billing：全 paid + free_only ⇒ 即使并发/冷却也不放行', () => {
  const r = admitCandidates({
    candidates: [{ provider: 'a', model: 'm1', tier: 1, billing: 'paid' }],
    billingTier: 'free_only',
    isCooling: () => true,
    loadOf: () => ({ active: 9, limit: 1 }),
  })
  assert.equal(r.eligible.length, 0)
  assert.equal(r.stats.relaxed, null, '授权过滤没有兜底')
  assert.equal(r.stats.droppedBilling, 1)
})

test('limit=0 / 无负载信息 ⇒ 视为「没有并发信息」，不剔除', () => {
  const zero = admitCandidates({
    candidates: [{ provider: 'a', model: 'm1', tier: 1 }],
    loadOf: () => ({ active: 0, limit: 0 }),
  })
  assert.equal(zero.eligible.length, 1)
  const none = admitCandidates({
    candidates: [{ provider: 'a', model: 'm1', tier: 1 }],
    loadOf: () => null,
  })
  assert.equal(none.eligible.length, 1)
})

test('探针抛错 ⇒ 一律安全降级（不把插件打挂）', () => {
  const r = admitCandidates({
    candidates: [{ provider: 'a', model: 'm1', tier: 1 }],
    isCooling: () => { throw new Error('boom') },
    loadOf: () => { throw new Error('boom') },
    last429At: () => { throw new Error('boom') },
  })
  assert.equal(r.eligible.length, 1)
})

test('并发满的候选先剔除（未清空 ⇒ 不回退，excluded 记录 concurrency）', () => {
  const loads = { busy: { active: 2, limit: 2 }, idle: { active: 0, limit: 2 } }
  const r = admitCandidates({
    candidates: [
      { provider: 'busy', model: 'm1', tier: 1 },
      { provider: 'idle', model: 'm2', tier: 2 },
    ],
    loadOf: (p) => loads[p],
  })
  assert.deepEqual(r.eligible.map((e) => e.provider), ['idle'])
  assert.equal(r.stats.droppedConcurrency, 1)
  assert.equal(r.stats.relaxed, null)
})

// ── ③ 排序（严格 5 级）───────────────────────────────────────────────

test('排序 1：tier 升序优先于 billing（tier1 付费 仍排在 tier2 免费 之前）', () => {
  const r = admitCandidates({
    candidates: [
      { provider: 'b', model: 'm2', tier: 2, billing: 'free' },
      { provider: 'a', model: 'm1', tier: 1, billing: 'paid' },
    ],
    billingTier: 'paid_allowed',
  })
  assert.deepEqual(r.eligible.map((e) => e.provider), ['a', 'b'])
})

test('排序 2：同 tier ⇒ free/unknown 在 paid 之前（即使 paid 更空闲）', () => {
  // 两个候选都在名额内（active < limit）；free 的负载更高，但仍必须先排（billing 优先于负载）
  const loads = { 'paid-idle': { active: 0, limit: 4 }, 'free-busy': { active: 1, limit: 2 } }
  const r = admitCandidates({
    candidates: [
      { provider: 'paid-idle', model: 'm1', tier: 1, billing: 'paid' },
      { provider: 'free-busy', model: 'm2', tier: 1, billing: 'free' },
    ],
    billingTier: 'paid_allowed',
    loadOf: (p) => loads[p] ?? null,
  })
  assert.deepEqual(r.eligible.map((e) => e.provider), ['free-busy', 'paid-idle'])
})

test('排序 3：同 tier 同 billing ⇒ loadRatio 低的先（active/max(1,limit)）', () => {
  const loads = {
    a: { active: 1, limit: 2 },   // 0.5
    b: { active: 1, limit: 4 },   // 0.25
    c: { active: 0, limit: 1 },   // 0
  }
  const r = admitCandidates({
    candidates: [
      { provider: 'a', model: 'ma', tier: 1, billing: 'free' },
      { provider: 'b', model: 'mb', tier: 1, billing: 'free' },
      { provider: 'c', model: 'mc', tier: 1, billing: 'free' },
    ],
    loadOf: (p) => loads[p],
  })
  assert.deepEqual(r.eligible.map((e) => e.provider), ['c', 'b', 'a'])
})

test('排序 4/5：同负载 ⇒ last429At 早的优先，再相同 ⇒ 原始 _i 稳定序', () => {
  const last429 = { cooled: 9_000, fresh: 0, never: 0 }
  const r = admitCandidates({
    candidates: [
      { provider: 'cooled', model: 'm1', tier: 1, _i: 0 },
      { provider: 'fresh', model: 'm2', tier: 1, _i: 1 },
      { provider: 'never', model: 'm3', tier: 1, _i: 2 },
    ],
    last429At: (p) => last429[p] ?? 0,
  })
  assert.deepEqual(r.eligible.map((e) => e.provider), ['fresh', 'never', 'cooled'])
})

test('pinned：用户显式请求的模型即使 tier 更大也固定第一', () => {
  const r = admitCandidates({
    candidates: [
      { provider: 'a', model: 'm1', tier: 1 },
      { provider: 'pinned', model: 'm9', tier: 3, pinned: true },
    ],
  })
  assert.deepEqual(r.eligible.map((e) => e.provider), ['pinned', 'a'])
})

test('🔴 pinned 被付费授权过滤时照样丢弃（用户请求不能突破授权）', () => {
  const r = admitCandidates({
    candidates: [{ provider: 'pinned', model: 'm9', tier: 1, paid: true, pinned: true }],
    billingTier: 'free_only',
  })
  assert.equal(r.eligible.length, 0)
  assert.equal(r.stats.droppedBilling, 1)
})

// ── ④ adapter 接入（行为级证据）──────────────────────────────────────

/** 假 send：记录真实被调用的 provider（这就是「尝试」证据） */
function recordingSend(attempts, { fail = new Set() } = {}) {
  return async ({ provider, model }) => {
    attempts.push({ provider, model })
    if (fail.has(provider)) throw Object.assign(new Error(`boom ${provider}`), { code: 'SERVER', status: 500 })
    return (async function* () {
      yield { type: 'text-delta', text: `${provider} ok` }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

test('🔴 free_only（默认）：paid 候选被调用 **0 次**，free 候选成功', async () => {
  const attempts = []
  const events = []
  const gate = createConcurrencyGate({ limits: { 'free-src': 2, 'paid-src': 2, default: 2 } })
  const adapter = createAdapter({
    builtin: [
      { provider: 'paid-src', model: 'paid-1', tier: 1, paid: true },
      { provider: 'free-src', model: 'free-1', tier: 2 },
    ],
    send: recordingSend(attempts),
    concurrency: gate,
    onEvent: (e) => events.push(e),
  })
  const chunks = await collect(adapter.stream({ model: 'paid-1', messages: [] }))
  assert.ok(chunks.some((c) => c.type === 'text-delta'))
  assert.deepEqual(attempts.map((a) => a.provider), ['free-src'], 'paid 候选必须 0 次尝试')
  const admission = events.find((e) => e.type === 'admission')
  assert.ok(admission, '必须发出 admission 事件')
  assert.equal(admission.billingTier, 'free_only')
  assert.equal(admission.droppedBilling, 1)
  assert.equal(admission.kept, 1)
})

test('paid_allowed（宿主 metadata）：paid 候选被尝试（证明过滤是可开可关的授权，不是硬禁）', async () => {
  const attempts = []
  const gate = createConcurrencyGate({ limits: { 'paid-src': 2, default: 2 } })
  const adapter = createAdapter({
    builtin: [{ provider: 'paid-src', model: 'paid-1', tier: 1, paid: true }],
    send: recordingSend(attempts),
    concurrency: gate,
  })
  const chunks = await collect(adapter.stream({
    model: 'paid-1', messages: [], metadata: { billing_tier: 'paid_allowed' },
  }))
  assert.ok(chunks.some((c) => c.type === 'text-delta'))
  assert.deepEqual(attempts.map((a) => a.provider), ['paid-src'])
})

test('🔴 全 paid + free_only ⇒ 走既有 PERMISSION 语义，且一次都不发请求', async () => {
  const attempts = []
  const adapter = createAdapter({
    builtin: [{ provider: 'paid-src', model: 'paid-1', tier: 1, paid: true }],
    send: recordingSend(attempts),
    concurrency: createConcurrencyGate({ limits: { 'paid-src': 2, default: 2 } }),
  })
  await assert.rejects(
    () => collect(adapter.stream({ model: 'paid-1', messages: [] })),
    (e) => e.code === 'PERMISSION' && /free_only/.test(e.message),
  )
  assert.equal(attempts.length, 0, '授权 fail-closed：一次都不能尝试')
})

test('渠道元数据参与 billing 判定：protocols 里 paid 的渠道在 free_only 下被挡', async () => {
  const attempts = []
  const gate = createConcurrencyGate({ limits: { 'free-src': 2, default: 2 } })
  // kilo-free 是免密源（pricing.FREE_PROVIDERS 去掉 -free 后缀）⇒ billing=free
  const adapter = createAdapter({
    builtin: [
      { provider: 'paid-src', model: 'paid-1', tier: 1, paid: true },
      { provider: 'kilo-free', model: 'kilo-auto/free', tier: 2 },
    ],
    send: recordingSend(attempts),
    concurrency: gate,
  })
  await collect(adapter.stream({ model: 'unknown-model', messages: [] }))
  assert.deepEqual(attempts.map((a) => a.provider), ['kilo-free'])
})

test('准入不改降级语义：付费候选在 paid_allowed 下失败仍继续降级', async () => {
  const attempts = []
  const gate = createConcurrencyGate({ limits: { 'paid-src': 2, 'free-src': 2, default: 2 } })
  const adapter = createAdapter({
    builtin: [
      { provider: 'paid-src', model: 'paid-1', tier: 1, paid: true },
      { provider: 'free-src', model: 'free-1', tier: 2 },
    ],
    send: recordingSend(attempts, { fail: new Set(['paid-src']) }),
    concurrency: gate,
  })
  const chunks = await collect(adapter.stream({
    model: 'x', messages: [], metadata: { billing_tier: 'paid_allowed' },
  }))
  assert.ok(chunks.some((c) => c.type === 'text-delta'))
  assert.deepEqual(attempts.map((a) => a.provider), ['paid-src', 'free-src'], '按 tier 升序逐层降级')
})

test('pinned 保留首位：请求的模型（链里存在）仍第一个尝试', async () => {
  const attempts = []
  const gate = createConcurrencyGate({ limits: { a: 2, b: 2, default: 2 } })
  const adapter = createAdapter({
    builtin: [
      { provider: 'a', model: 'm-tier1', tier: 1 },
      { provider: 'b', model: 'm-tier4', tier: 4 },
    ],
    send: recordingSend(attempts),
    concurrency: gate,
  })
  await collect(adapter.stream({ model: 'm-tier4', messages: [] }))
  assert.deepEqual(attempts.map((a) => a.provider), ['b'], '用户显式请求的模型必须第一个尝试')
})
