/**
 * cs-myfree — 契约 A（切换成功统计，口径 A）+ 契约 B（复杂路由基本规则）测试
 *
 * 依据：`design/22-cs-myfree七项改造-接口契约-v1.md` §2 / §3。
 *
 * 要证明的事：
 *   1. 口径 A：A 失败 → B 成功 ⇒ 记 **1 次**切换成功，`last` 给出 from/to 明细
 *   2. 分母 = 每一次成功（切换机会数）；非切换的成功同样进分母
 *   3. 分母 0 ⇒ `switchSuccessRate: null`（不是 0%，更不是 100%）
 *   4. 计数器**跨请求累积**（不随单次请求重置）
 *   5. `channel-busy` 跳过**不算**尝试（否则分母虚增、成功率被拉低）
 *   6. 账本每行带 `switched` / `attempts`；`readSpend()` 聚合出 `switches` + per-model 子维度
 *   7. `rules.configurable` 每一项的 path 都存在，且**后端真的读**（改配置 ⇒ 闸门/黑名单真变，
 *      不配置 ⇒ 默认值一字不变 ⇒ 零回归）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAdapter, createSwitchMeter, ROUTING_DEFAULTS } from '../src/adapter/index.js'
import { createConcurrencyGate, COOLDOWN_BASE_MS, RATE_LIMIT_COOLDOWN_MS } from '../src/adapter/concurrency.js'
import { createRoutingSnapshot } from '../src/web/routing.js'
import { appendRecord, readSpend, ledgerFile } from '../src/audit/sources.js'

async function drain(iter) { for await (const _c of iter) { /* drain */ } }

const okSend = async () => (async function* () { yield { type: 'text-delta', text: 'ok' } })()
const serverErr = () => Object.assign(new Error('HTTP 500 boom'), { status: 500 })

/** 两候选基础链：a 先上（_i 小），b 兜底 */
const CHAIN_AB = [
  { provider: 'a', model: 'ma', tier: 1 },
  { provider: 'b', model: 'mb', tier: 2 },
]
/**
 * 同 tier 两候选：tier 是排序第一键，**只有同 tier** 时「失败率」才会把 b 提到 a 前面。
 * 测「非切换的成功」必须用它（否则 a 永远排第一，每轮都会切换）。
 */
const CHAIN_AB_SAME_TIER = [
  { provider: 'a', model: 'ma', tier: 1 },
  { provider: 'b', model: 'mb', tier: 1 },
]
// 默认冷却基值（测「默认值不变」）；需要短冷却的用例单独建闸门
const mkGate = () => createConcurrencyGate({ limits: { a: 2, b: 2, p: 2, q: 2, bad: 2, default: 2 } })

// ── 口径 A ────────────────────────────────────────────────────────────────

test('① 口径 A：A 失败 → B 成功 ⇒ 记 1 次切换成功（total/byProvider/byModel/last 全对）', async () => {
  const adapter = createAdapter({
    builtin: CHAIN_AB,
    concurrency: mkGate(),
    send: async ({ provider }) => { if (provider === 'a') throw serverErr(); return okSend() },
  })
  await drain(adapter.stream({ model: 'x', messages: [] }))

  const s = adapter.switchSnapshot()
  assert.equal(s.total, 1, '切换成功 1 次')
  assert.deepEqual(s.byProvider, { b: 1 }, '到达方 = 切换后成功的那个 provider')
  assert.deepEqual(s.byModel, { 'b/mb': 1 })
  assert.equal(s.attempts.total, 1, '分母：本轮成功了 1 次 ⇒ 1 次切换机会')
  assert.deepEqual(s.attempts.byProvider, { b: 1 })
  assert.equal(s.switchSuccessRate, 100)
  assert.ok(s.last && typeof s.last.at === 'number', 'last 必须带时间与明细')
  assert.equal(s.last.from, 'a', 'from = 本轮首个真正发出请求的 provider')
  assert.equal(s.last.to, 'b')
  assert.equal(s.last.modelFrom, 'ma', 'modelFrom 也要如实给（页面说人话用）')
  assert.equal(s.last.modelTo, 'mb')
})

test('② 分母 = 每一次成功：一次切换 + 一次非切换 ⇒ total 1 / attempts 2 / 50%', async () => {
  const adapter = createAdapter({
    builtin: CHAIN_AB_SAME_TIER,
    concurrency: mkGate(),
    // 第一轮：a 失败 → b 成功（切换）；第二轮：失败率排序让 b 先上 ⇒ 直接成功（非切换）
    send: async ({ provider }) => { if (provider === 'a') throw serverErr(); return okSend() },
  })
  await drain(adapter.stream({ model: 'x', messages: [] }))   // 切换
  await drain(adapter.stream({ model: 'x', messages: [] }))   // b 先上 ⇒ 非切换

  const s = adapter.switchSnapshot()
  assert.equal(s.total, 1, '只有第一轮是切换')
  assert.equal(s.attempts.total, 2, '两轮各成功一次 ⇒ 分母 2（非切换的成功也进分母）')
  assert.equal(s.switchSuccessRate, 50)
})

test('③ 分母 0 ⇒ switchSuccessRate 为 null（不能说成 0%，也不能是 100%）', () => {
  const adapter = createAdapter({
    builtin: CHAIN_AB,
    concurrency: mkGate(),
    send: okSend,
  })
  const s = adapter.switchSnapshot()
  assert.equal(s.total, 0)
  assert.equal(s.attempts.total, 0)
  assert.equal(s.switchSuccessRate, null, '没有分母时必须给 null，页面显示「暂无数据」')
  assert.equal(s.last, null)
  assert.ok(typeof s.at === 'number', 'at 恒为数字（最近一次统计时间）')
})

test('④ 计数器跨请求累积（不随单次请求重置）：两次切换 ⇒ total 2 / attempts 2 / 100%', async () => {
  const adapter = createAdapter({
    builtin: CHAIN_AB_SAME_TIER,
    concurrency: mkGate(),
    // 轮次 1：a 失败；轮次 2：b 先上且失败（a 兜底成功）⇒ 两次都是切换
    send: async ({ provider }) => { if (provider === failProvider) throw serverErr(); return okSend() },
  })
  let failProvider = 'a'
  await drain(adapter.stream({ model: 'x', messages: [] }))
  assert.equal(adapter.switchSnapshot().total, 1)

  failProvider = 'b'                                     // 第二轮让先上场的 b 失败
  await drain(adapter.stream({ model: 'x', messages: [] }))
  const s = adapter.switchSnapshot()
  assert.equal(s.total, 2, '跨请求累积，不重置')
  assert.equal(s.attempts.total, 2)
  assert.equal(s.switchSuccessRate, 100)
  assert.deepEqual(s.byProvider, { b: 1, a: 1 })
})

test('⑤ channel-busy 跳过**不算**尝试：首个候选本地名额满 ⇒ 分母只有真正发出的那次', async () => {
  // 自定义闸门：a 永远拿不到名额（loadOf 探针返回 null ⇒ 准入不会提前剔除它，
  // 于是真正走到 channel-busy 分支），b 正常。
  const fakeGate = {
    busyCooldownMs: COOLDOWN_BASE_MS,
    rateLimitCooldownMs: RATE_LIMIT_COOLDOWN_MS,
    maxCooldownMs: 120_000,
    limits: { a: 1, b: 2, default: 2 },
    async acquire(p) {
      if (p === 'a') return { ok: false, code: 'CHANNEL_BUSY', active: 1, limit: 1 }
      return { ok: true, release() {} }
    },
    stats() { return null },
    isCooling() { return false },
    isRateCooling() { return false },
    markSuccess() {}, markFailure() {}, markBusy() {}, markRateLimited() {},
    relaxCooldown() { return false },
  }
  const events = []
  const adapter = createAdapter({
    builtin: CHAIN_AB,
    concurrency: fakeGate,
    send: okSend,
    onEvent: (e) => events.push(e),
  })
  await drain(adapter.stream({ model: 'x', messages: [] }))

  assert.ok(events.some((e) => e.type === 'channel-busy'), '必须真的走到 channel-busy 分支')
  const s = adapter.switchSnapshot()
  assert.equal(s.total, 0, 'b 是本轮首个**真正发出请求**的候选 ⇒ 不是切换')
  assert.equal(s.attempts.total, 1, '忙跳过不占分母')
  assert.equal(s.switchSuccessRate, 0)
})

test('⑥ createSwitchMeter 是唯一口径实现：直接喂数据也能得到同一结果', () => {
  const m = createSwitchMeter({ now: () => 1_800_000_000_000 })
  const r = m.success({ provider: 'b', model: 'mb', firstProvider: 'a', firstModel: 'ma', attemptNo: 2 })
  assert.deepEqual(r, { switched: true, attempts: 2, at: 1_800_000_000_000 })
  const s = m.snapshot()
  assert.equal(s.total, 1)
  assert.equal(s.attempts.total, 1)
  m.reset()
  assert.equal(m.snapshot().total, 0)
  assert.equal(m.snapshot().switchSuccessRate, null)
})

// ── 账本（契约 A3）─────────────────────────────────────────────────────────

test('⑦ appendRecord 每行带 switched/attempts；缺省 ⇒ false/1（历史行口径透明）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cs-myfree-switch-'))
  try {
    await appendRecord({ at: 1_700_000_000_000, provider: 'b', model: 'mb', ok: true, switched: true, attempts: 2 }, { dshHome: home })
    await appendRecord({ at: 1_700_000_001_000, provider: 'b', model: 'mb', ok: true }, { dshHome: home })
    const lines = (await readFile(ledgerFile(home), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(lines[0].switched, true)
    assert.equal(lines[0].attempts, 2)
    assert.equal(lines[1].switched, false, '没写 ⇒ false')
    assert.equal(lines[1].attempts, 1, '没写 ⇒ 1')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('⑧ readSpend 聚合：switches{total,switchSuccessRate,byProvider,byModel} + provider 的 switched/models', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cs-myfree-switch-'))
  try {
    await appendRecord({ at: 1_700_000_000_000, provider: 'b', model: 'mb', ok: true, switched: true, attempts: 2, cost: 0, paid: false }, { dshHome: home })
    await appendRecord({ at: 1_700_000_001_000, provider: 'b', model: 'mb', ok: true, switched: false, attempts: 1, cost: 0, paid: false }, { dshHome: home })
    await appendRecord({ at: 1_700_000_002_000, provider: 'c', model: 'mc', ok: false, code: 'SERVER', attempts: 3 }, { dshHome: home })

    const spend = await readSpend({ dshHome: home })
    assert.equal(spend.switches.total, 1, '切换成功条数')
    // 分母 = 成功条数（2 条 ok=true）；失败条不构成"切换机会"
    assert.equal(spend.switches.switchSuccessRate, 50)
    assert.deepEqual(spend.switches.byProvider, { b: 1 })
    assert.deepEqual(spend.switches.byModel, { 'b/mb': 1 })

    const pb = spend.providers.find((p) => p.provider === 'b')
    const pc = spend.providers.find((p) => p.provider === 'c')
    assert.equal(pb.calls, 2)
    assert.equal(pb.switched, 1, 'provider 级切换计数')
    assert.equal(pb.models.mb.calls, 2, 'per-model 子维度')
    assert.equal(pb.models.mb.switched, 1)
    assert.equal(pb.models.mb.failed, 0)
    assert.equal(pc.models.mc.failed, 1)
    assert.equal(pc.switched, 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('⑨ readSpend 空账本也给得出 switches 结构（页面不用处理字段缺失）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cs-myfree-switch-'))
  try {
    const spend = await readSpend({ dshHome: home })
    assert.equal(spend.empty, true)
    assert.deepEqual(spend.switches.byProvider, {})
    assert.deepEqual(spend.switches.byModel, {})
    assert.equal(spend.switches.total, 0)
    assert.equal(spend.switches.switchSuccessRate, null)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ── /state.routing 暴露（契约 A4 + B）─────────────────────────────────────

test('⑩ routingSnapshot 暴露 switches（口径 A）与 rules（契约 B 全字段）', async () => {
  const gate = mkGate()
  const adapter = createAdapter({
    builtin: CHAIN_AB,
    concurrency: gate,
    send: async ({ provider }) => { if (provider === 'a') throw serverErr(); return okSend() },
  })
  await drain(adapter.stream({ model: 'x', messages: [] }))

  const snap = createRoutingSnapshot({ adapterOf: () => adapter, gateOf: () => gate })()

  // 契约 A4
  assert.equal(snap.switches.total, 1)
  assert.equal(snap.switches.attempts.total, 1)
  assert.equal(snap.switches.switchSuccessRate, 100)
  assert.equal(snap.switches.last.to, 'b')

  // 契约 B
  const r = snap.rules
  assert.equal(r.policy, 'blended', 'policy 读 policy-switch.PHASE4_POLICY')
  assert.equal(r.policyOptions.length, 4)
  assert.deepEqual(r.policyOptions.map((o) => o.id), ['v1.1', 'p2', 'p3', 'blended'])
  assert.equal(r.policyOptions.filter((o) => o.active).length, 1, '只有一个生效策略')
  assert.equal(r.policyOptions.find((o) => o.active).id, 'blended')
  for (const o of r.policyOptions) {
    assert.ok(o.label && o.desc && o.evidence, `${o.id} 必须带 label/desc/evidence（实测依据）`)
  }
  assert.deepEqual(r.order, ['tier', 'billing', 'score', 'last429At', '_i'])
  assert.ok(String(r.orderHuman).includes('免费/付费'), 'orderHuman 必须是"人话"')
  assert.deepEqual(r.weights, { load: 1, fail: 1 })
  assert.equal(r.filters.length, 4)
  assert.deepEqual(r.filters.map((f) => f.position), [1, 1.5, 2, 3], '过滤层顺序即 position')
  const strict = r.filters.filter((f) => f.strict).map((f) => f.id)
  assert.deepEqual(strict, ['billing', 'blacklist'], '授权与黑名单永不放宽')
  for (const f of r.filters) {
    assert.ok(f.label && f.effect && Number.isFinite(f.position), `${f.id} 必须带 label/effect/position`)
  }
  assert.deepEqual(r.emptySetFallback.appliesTo, ['cooldown', 'concurrency'])
  assert.deepEqual(r.emptySetFallback.excludes, ['billing', 'blacklist'])
  // cooldowns 必须是**实际生效值**（默认 15s / 4s）
  assert.equal(r.cooldowns.busyMs, COOLDOWN_BASE_MS)
  assert.equal(r.cooldowns.rateMs, RATE_LIMIT_COOLDOWN_MS)
  assert.ok(String(r.cooldowns.note).includes('429'))
  // gate 复用 snapshotStats 口径
  assert.ok(r.gate && typeof r.gate === 'object')
  assert.equal(r.gate.a.limit, 2)
  assert.equal(typeof r.gate.b.failRate, 'number')
})

test('⑪ rules.configurable：每一项 path 都存在，且带 value（页面能改、后端能读）', async () => {
  const gate = mkGate()
  const adapter = createAdapter({ builtin: CHAIN_AB, concurrency: gate, send: okSend })
  const snap = createRoutingSnapshot({ adapterOf: () => adapter, gateOf: () => gate })()

  const items = snap.rules.configurable
  assert.equal(items.length, 6, '契约列出 6 项')
  const expectPaths = [
    'routing.priority', 'routing.autoSwitch', 'routing.cooldownMs',
    'routing.rateCooldownMs', 'sources.limits.<id>', 'routing.blacklistTtlMs',
  ]
  assert.deepEqual(items.map((i) => i.path), expectPaths)
  for (const it of items) {
    assert.equal(typeof it.path, 'string')
    assert.ok(it.path.length > 0, 'path 不能为空（空 path 无法 patch）')
    assert.ok(it.value !== undefined && it.value !== null, `${it.path} 必须给当前生效值`)
    assert.equal(it.source, 'default', '没配置 ⇒ source=default')
  }
  const byPath = Object.fromEntries(items.map((i) => [i.path, i]))
  assert.deepEqual(byPath['routing.priority'].options, ['free-first', 'balanced', 'reliability-first'])
  assert.equal(byPath['routing.priority'].value, ROUTING_DEFAULTS.priority)
  assert.equal(byPath['routing.autoSwitch'].type, 'bool')
  assert.equal(byPath['routing.autoSwitch'].value, true)
  assert.equal(byPath['routing.cooldownMs'].unit, 'ms')
  assert.equal(byPath['routing.cooldownMs'].value, COOLDOWN_BASE_MS, '默认值不变')
  assert.equal(byPath['routing.rateCooldownMs'].value, RATE_LIMIT_COOLDOWN_MS, '默认值不变')
  assert.equal(byPath['routing.blacklistTtlMs'].value, ROUTING_DEFAULTS.blacklistTtlMs)
  // 逐家并发上限：模板 path + 具体 path 清单 + 当前值表
  assert.ok(byPath['sources.limits.<id>'].paths.includes('sources.limits.a'))
  assert.equal(byPath['sources.limits.<id>'].value.a, 2)
})

test('⑫ 配置真的生效：routing.cooldownMs/rateCooldownMs/sources.limits 写进闸门（不是假开关）', () => {
  const gate = createConcurrencyGate({ limits: { p: 2, q: 2, default: 2 } })
  assert.equal(gate.busyCooldownMs, COOLDOWN_BASE_MS, '构造默认值不变')
  assert.equal(gate.rateLimitCooldownMs, RATE_LIMIT_COOLDOWN_MS, '构造默认值不变')

  const adapter = createAdapter({
    builtin: [{ provider: 'p', model: 'mp', tier: 1 }],
    concurrency: gate,
    send: okSend,
    routingConfig: {
      routing: { cooldownMs: 1234, rateCooldownMs: 567, blacklistTtlMs: 40_000, priority: 'reliability-first', autoSwitch: false },
      sources: { limits: { p: 7 } },
    },
  })

  assert.equal(gate.busyCooldownMs, 1234, '失败冷却基值必须真的改到闸门')
  assert.equal(gate.rateLimitCooldownMs, 567, '429 冷却基值必须真的改到闸门')
  assert.equal(gate.limits.p, 7, '每家并发上限必须真的改到闸门')

  const rt = adapter.routingConfigSnapshot()
  assert.equal(rt.cooldownMs, 1234)
  assert.equal(rt.rateCooldownMs, 567)
  assert.equal(rt.blacklistTtlMs, 40_000)
  assert.equal(rt.priority, 'reliability-first')
  assert.equal(rt.autoSwitch, false)
  assert.equal(rt.source, 'config')
  assert.equal(rt.configured.cooldownMs, true)

  // 页面看到的 = 实际生效的（同一次快照）
  const snap = createRoutingSnapshot({ adapterOf: () => adapter, gateOf: () => gate })()
  const byPath = Object.fromEntries(snap.rules.configurable.map((i) => [i.path, i]))
  assert.equal(byPath['routing.cooldownMs'].value, 1234)
  assert.equal(byPath['routing.cooldownMs'].source, 'config', '必须标明这一项来自配置')
  assert.equal(snap.rules.cooldowns.busyMs, 1234, 'cooldowns 展示口径 = 实际值')
  assert.equal(byPath['sources.limits.<id>'].value.p, 7)
})

test('⑬ blacklistTtlMs 真的生效：配置 60ms ⇒ 拉黑条目按 60ms 记（默认仍是 6h）', async () => {
  const authErr = () => Object.assign(new Error('HTTP 401 unauthorized'), { status: 401 })

  // ① 配置 60ms
  const adapter = createAdapter({
    builtin: [{ provider: 'bad', model: 'mbad', tier: 1 }],
    concurrency: mkGate(),
    send: async () => { throw authErr() },
    routingConfig: { routing: { blacklistTtlMs: 60 } },
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  const snap = adapter.blacklistSnapshot()
  assert.equal(snap.length, 1, 'AUTH 属终态失败 ⇒ 必须拉黑')
  assert.equal(snap[0].provider, 'bad')
  assert.equal(snap[0].ttlMs, 60, '生效 TTL = 配置值')
  assert.ok(snap[0].remainMs <= 60, '剩余时间也按配置值算（不是 6h）')

  // ② 不配置 ⇒ 默认 6h（零回归）
  const dflt = createAdapter({
    builtin: [{ provider: 'bad', model: 'mbad', tier: 1 }],
    concurrency: mkGate(),
    send: async () => { throw authErr() },
  })
  await assert.rejects(() => drain(dflt.stream({ model: 'x', messages: [] })))
  assert.equal(dflt.blacklistSnapshot()[0].ttlMs, ROUTING_DEFAULTS.blacklistTtlMs, '默认 6h 不变')
})

test('⑭ autoSwitch=false 真的生效：关掉自动补救 ⇒ 冷却时不再兜底重试，如实失败', async () => {
  // ① 关闭自动选路：唯一候选处于 busy 冷却 ⇒ 不补救，直接如实报错
  const calls = []
  const gate = createConcurrencyGate({ limits: { p: 2, default: 2 }, busyCooldownMs: 5 })
  const adapter = createAdapter({
    builtin: [{ provider: 'p', model: 'mp', tier: 1 }],
    concurrency: gate,
    send: async ({ provider }) => { calls.push(provider); return okSend() },
    routingConfig: { routing: { autoSwitch: false } },
  })
  gate.markBusy('p', 60_000)
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })), (e) => e.code === 'CHANNEL_BUSY')
  assert.deepEqual(calls, [], 'autoSwitch=false ⇒ 不发送、也不做冷却兜底重试')

  // ② 对照：默认配置下同场景会被「有界兜底重试」救回来（证明开关有真实作用，不是摆设）
  const gate2 = createConcurrencyGate({ limits: { p: 2, default: 2 }, busyCooldownMs: 5 })
  const calls2 = []
  const adapter2 = createAdapter({
    builtin: [{ provider: 'p', model: 'mp', tier: 1 }],
    concurrency: gate2,
    send: async ({ provider }) => { calls2.push(provider); return okSend() },
  })
  gate2.markBusy('p', 60_000)
  await drain(adapter2.stream({ model: 'x', messages: [] }))
  assert.deepEqual(calls2, ['p'], '默认（autoSwitch=true）放宽 busy 冷却后救回，发送 1 次')
  assert.equal(adapter2.switchSnapshot().total, 0, '救回来也是首个候选 ⇒ 不算切换')
})

test('⑮ 配置清空（null）不改变默认值；cooldownMs=0 是合法值（真的不冷却）', () => {
  const gate = createConcurrencyGate({ limits: { p: 2, default: 2 } })
  // ⚠️ null / '' 绝不能被 `Number()` 折成 0（那会把冷却静默关掉）
  const a = createAdapter({
    builtin: [{ provider: 'p', model: 'mp', tier: 1 }],
    concurrency: gate,
    send: okSend,
    routingConfig: { routing: { cooldownMs: null, rateCooldownMs: '', blacklistTtlMs: null } },
  })
  assert.equal(gate.busyCooldownMs, COOLDOWN_BASE_MS, 'null ⇒ 保持默认（不是 0）')
  assert.equal(gate.rateLimitCooldownMs, RATE_LIMIT_COOLDOWN_MS, '空串 ⇒ 保持默认（不是 0）')
  const rt = a.routingConfigSnapshot()
  assert.equal(rt.blacklistTtlMs, ROUTING_DEFAULTS.blacklistTtlMs, 'null ⇒ 默认 6h')
  assert.equal(rt.source, 'default', '没有任何合法配置 ⇒ source=default')

  // 显式 0 = 「不冷却」，是合法的用户选择（要真的生效，不能被当成"未配置"）
  const gate2 = createConcurrencyGate({ limits: { p: 2, default: 2 } })
  const b = createAdapter({
    builtin: [{ provider: 'p', model: 'mp', tier: 1 }],
    concurrency: gate2,
    send: okSend,
    routingConfig: { routing: { cooldownMs: 0 } },
  })
  assert.equal(gate2.busyCooldownMs, 0, '0 必须真的写进闸门')
  assert.equal(b.routingConfigSnapshot().cooldownMs, 0, '展示值也不能被兜底成 15000')
  assert.equal(gate2.markBusy('p'), 0, '冷却 0 ⇒ markBusy 立刻到期')
})
