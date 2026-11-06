/**
 * cs-myfree — billing_tier 授权标签 + hint 旁路注册表测试（契约 §3 / §7.5）
 *
 * 要证明的事：
 *   1. hint 形状/TTL/容量/脱敏（纯内存注册表）
 *   2. 授权链路：metadata > hint[sessionId] > free_only（fail-closed）
 *   3. **free_only 下 paid 候选零尝试；paid_allowed 下被尝试**（假 send 记录调用）
 *   4. 无 cs-myfree 服务/注册表缺失 ⇒ 静默降级为 free_only，流程照常
 *   5. 记账字段：每条 onRecord 都带 billingTier + billing
 *   6. `/state.routing` 快照（授权默认值 + 准入 stats + 闸门字段）与旧版向后兼容
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createHintRegistry, installGlobalHints, getGlobalHints, uninstallGlobalHints,
  normalizeHint, maskSessionId, HINTS_VERSION, HINTS_SYMBOL,
} from '../src/adapter/routing-hints.js'
import { createAdapter } from '../src/adapter/index.js'
import { createConcurrencyGate } from '../src/adapter/concurrency.js'
import { createRoutingSnapshot } from '../src/web/routing.js'
import { registerRoutes, PREFIX } from '../src/web/routes.js'

async function collect(iter) { const out = []; for await (const x of iter) out.push(x); return out }

const hint = (over = {}) => ({
  billing_tier: 'paid_allowed',
  complexity_tier: 'T2',
  agent_role: 'main',
  requires_paid: true,
  source: 'cs-bots/llm-stream',
  at: 1_700_000_000_000,
  ...over,
})

// ── ① 注册表（纯内存）───────────────────────────────────────────────

test('hint 契约：符号/版本/形状（跨仓冻结）', () => {
  // hint 契约 v2（`design/22` 契约 E1）：六键语义不变 + 两个可选键（此处 v1 六键输入 ⇒ null）
  assert.equal(HINTS_VERSION, 2)
  assert.equal(HINTS_SYMBOL, Symbol.for('cs-myfree.routing.hints.v1'))
  const n = normalizeHint(hint())
  assert.deepEqual(
    { ...n },
    {
      billing_tier: 'paid_allowed',
      complexity_tier: 'T2',
      agent_role: 'main',
      requires_paid: true,
      source: 'cs-bots/llm-stream',
      at: 1_700_000_000_000,
      follow_parent_routing: null,   // v2 新增：v1 六键输入 ⇒ 未声明
      pinned_model: null,            // v2 新增：v1 六键输入 ⇒ 未声明
    },
  )
})

test('hint 非法值 ⇒ 拒绝写入（billing_tier 缺失/拼错都 fail-closed）', () => {
  for (const bad of [null, undefined, {}, { billing_tier: 'yes' }, { billing_tier: '' }, { billing_tier: 1 }, 'x']) {
    assert.equal(normalizeHint(bad), null, `应拒绝 ${JSON.stringify(bad)}`)
  }
  const reg = createHintRegistry()
  assert.equal(reg.set('s1', { billing_tier: 'nope' }), null)
  assert.equal(reg.get('s1'), null)
})

test('注册表：set/get/覆盖/clear + size', () => {
  const reg = createHintRegistry()
  assert.equal(reg.size, 0)
  reg.set('s1', hint({ billing_tier: 'free_only' }))
  assert.equal(reg.get('s1').billing_tier, 'free_only')
  reg.set('s1', hint({ billing_tier: 'paid_allowed' }))     // 同 sessionId 覆盖
  assert.equal(reg.get('s1').billing_tier, 'paid_allowed')
  assert.equal(reg.size, 1)
  assert.equal(reg.clear('s1'), true)
  assert.equal(reg.get('s1'), null)
  assert.equal(reg.size, 0)
})

test('注册表 TTL：过期返回 null（注入时钟，不睡）', () => {
  let t = 1_000
  const reg = createHintRegistry({ now: () => t, ttlMs: 1_000 })
  reg.set('s1', hint())
  t = 1_500
  assert.ok(reg.get('s1'), 'TTL 内应命中')
  t = 2_100
  assert.equal(reg.get('s1'), null, 'TTL 外必须失效')
  assert.equal(reg.size, 0, '过期项应被清掉，不占容量')
})

test('注册表容量：超出 maxEntries 淘汰最旧', () => {
  let t = 0
  const reg = createHintRegistry({ now: () => (t += 10), maxEntries: 2 })
  reg.set('a', hint())
  reg.set('b', hint())
  reg.set('c', hint())
  assert.equal(reg.size, 2, '容量上限生效')
  assert.equal(reg.get('a'), null, '最旧的被淘汰')
  assert.ok(reg.get('b') && reg.get('c'))
})

test('snapshot 脱敏：sessionId 打码，且不含任何凭据字段', () => {
  const reg = createHintRegistry()
  const sid = 'session-0123456789abcdef'
  reg.set(sid, hint())
  const snap = reg.snapshot()
  const keys = Object.keys(snap)
  assert.equal(keys.length, 1)
  assert.equal(keys[0], maskSessionId(sid))
  assert.notEqual(keys[0], sid, '不得原样暴露 sessionId')
  assert.ok(!('credential' in snap[keys[0]]) && !('token' in snap[keys[0]]))
  assert.equal(snap[keys[0]].billing_tier, 'paid_allowed')
  assert.ok(snap[keys[0]].ageMs >= 0)
})

test('installGlobalHints / getGlobalHints：装/取/卸，版本不符视为未装', () => {
  try {
    uninstallGlobalHints()
    assert.equal(getGlobalHints(), null, '未安装 ⇒ null（cs-bots 必须能容忍）')
    const reg = createHintRegistry()
    assert.equal(installGlobalHints(reg), true)
    assert.equal(getGlobalHints(), reg)
    // 版本不符（老/新 cs-myfree）⇒ 视为未安装，绝不误读
    installGlobalHints(reg)
    globalThis[HINTS_SYMBOL].version = 999
    assert.equal(getGlobalHints(), null)
  } finally {
    uninstallGlobalHints()
  }
})

// ── ② adapter 授权链路（行为级）──────────────────────────────────────

function recordingSend(attempts) {
  return async ({ provider, model }) => {
    attempts.push({ provider, model })
    return (async function* () {
      yield { type: 'text-delta', text: `${provider} ok` }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

function makeAdapter({ attempts, records = [], hints = null, gateLimits = null }) {
  return createAdapter({
    builtin: [
      { provider: 'paid-src', model: 'paid-1', tier: 1, paid: true },
      { provider: 'free-src', model: 'free-1', tier: 2 },
    ],
    send: recordingSend(attempts),
    concurrency: createConcurrencyGate({ limits: gateLimits ?? { 'paid-src': 2, 'free-src': 2, default: 2 } }),
    routingHints: hints,
    onRecord: (r) => records.push(r),
  })
}

test('🔴 无 hint（默认）⇒ free_only：paid 候选被调用 **0 次**', async () => {
  const attempts = []
  const reg = createHintRegistry()
  const adapter = makeAdapter({ attempts, hints: reg })
  await collect(adapter.stream({ model: 'paid-1', messages: [], sessionId: 'sess-none' }))
  assert.deepEqual(attempts.map((a) => a.provider), ['free-src'], 'paid 候选必须 0 次尝试')
  const adm = adapter.admissionSnapshot()
  assert.equal(adm.stats.billingTier, 'free_only')
  assert.equal(adm.stats.droppedBilling, 1)
  assert.deepEqual(adm.excluded, [{ provider: 'paid-src', model: 'paid-1', reason: 'billing' }])
})

test('🔴 hint[paid_allowed] ⇒ paid 候选被尝试（hint 是唯一实际生效通道）', async () => {
  const attempts = []
  const reg = createHintRegistry()
  reg.set('sess-paid', hint({ billing_tier: 'paid_allowed' }))
  const adapter = makeAdapter({ attempts, hints: reg })
  await collect(adapter.stream({ model: 'x', messages: [], sessionId: 'sess-paid' }))
  assert.deepEqual(attempts.map((a) => a.provider), ['paid-src'], 'paid 授权生效 ⇒ 先试 tier1 的付费候选')
  assert.equal(adapter.admissionSnapshot().stats.billingTier, 'paid_allowed')
})

test('hint 只对**自己的 sessionId** 生效（别的会话仍是 free_only）', async () => {
  const reg = createHintRegistry()
  reg.set('sess-A', hint({ billing_tier: 'paid_allowed' }))
  const aAttempts = []
  await collect(makeAdapter({ attempts: aAttempts, hints: reg }).stream({ model: 'x', messages: [], sessionId: 'sess-B' }))
  assert.deepEqual(aAttempts.map((a) => a.provider), ['free-src'])
})

test('hint 过期 ⇒ 自动回落到 free_only（TTL 注入时钟）', async () => {
  let t = 1_000
  const reg = createHintRegistry({ now: () => t, ttlMs: 500 })
  reg.set('sess-T', hint({ billing_tier: 'paid_allowed' }))
  const attempts = []
  const adapter = makeAdapter({ attempts, hints: reg })
  t = 2_000              // 过期
  await collect(adapter.stream({ model: 'x', messages: [], sessionId: 'sess-T' }))
  assert.deepEqual(attempts.map((a) => a.provider), ['free-src'], '过期 hint 不得继续放行付费')
})

test('metadata.billing_tier 优先级高于 hint（宿主显式值赢）', async () => {
  const reg = createHintRegistry()
  reg.set('sess-M', hint({ billing_tier: 'paid_allowed' }))
  const attempts = []
  const adapter = makeAdapter({ attempts, hints: reg })
  await collect(adapter.stream({
    model: 'x', messages: [], sessionId: 'sess-M',
    metadata: { billing_tier: 'free_only' },
  }))
  assert.deepEqual(attempts.map((a) => a.provider), ['free-src'], 'metadata 显式 free_only 必须压过 hint')
})

test('🔴 无 cs-myfree 服务（注册表缺失、globalThis 也没有）⇒ 静默降级 free_only，请求照常成功', async () => {
  uninstallGlobalHints()
  assert.equal(getGlobalHints(), null)
  const attempts = []
  const adapter = makeAdapter({ attempts, hints: null })     // 不注入注册表
  const chunks = await collect(adapter.stream({ model: 'x', messages: [], sessionId: 'sess-Z' }))
  assert.ok(chunks.some((c) => c.type === 'text-delta'), '缺服务时对话必须照常')
  assert.deepEqual(attempts.map((a) => a.provider), ['free-src'])
  assert.equal(adapter.admissionSnapshot().stats.billingTier, 'free_only')
})

test('globalThis 符号安装后，未注入注册表的 adapter 也能读到 hint（跨插件通道）', async () => {
  const reg = createHintRegistry()
  reg.set('sess-G', hint({ billing_tier: 'paid_allowed' }))
  try {
    installGlobalHints(reg)
    const attempts = []
    const adapter = makeAdapter({ attempts, hints: null })
    await collect(adapter.stream({ model: 'x', messages: [], sessionId: 'sess-G' }))
    assert.deepEqual(attempts.map((a) => a.provider), ['paid-src'])
  } finally {
    uninstallGlobalHints()
  }
})

test('记账分账：onRecord 每条都带 billingTier + billing', async () => {
  const reg = createHintRegistry()
  reg.set('sess-R', hint({ billing_tier: 'paid_allowed' }))
  const records = []
  const adapter = makeAdapter({ attempts: [], records, hints: reg })
  await collect(adapter.stream({ model: 'x', messages: [], sessionId: 'sess-R' }))
  assert.equal(records.length, 1)
  assert.equal(records[0].provider, 'paid-src')
  assert.equal(records[0].billingTier, 'paid_allowed')
  assert.equal(records[0].billing, 'paid', '付费候选必须如实记 paid')

  const records2 = []
  const adapter2 = makeAdapter({ attempts: [], records: records2, hints: reg })
  await collect(adapter2.stream({ model: 'x', messages: [], sessionId: 'sess-none' }))
  assert.equal(records2[0].billingTier, 'free_only')
  // 'free-src' 既不在 CHANNELS 也没有 -free 后缀 ⇒ 成本属性推不出 ⇒ unknown（绝不猜成 free）
  assert.equal(records2[0].billing, 'unknown')
})

// ── ③ /state.routing 快照（验证指标口径 + 向后兼容）────────────────

test('routing 快照：defaultBillingTier / lastAdmission.stats / gate 每家指标齐全', async () => {
  const reg = createHintRegistry()
  reg.set('sess-S', hint({ billing_tier: 'paid_allowed' }))
  const gate = createConcurrencyGate({ limits: { 'paid-src': 2, 'free-src': 2, default: 2 } })
  const adapter = createAdapter({
    builtin: [
      { provider: 'paid-src', model: 'paid-1', tier: 1, paid: true },
      { provider: 'free-src', model: 'free-1', tier: 2 },
    ],
    send: recordingSend([]),
    concurrency: gate,
    routingHints: reg,
  })
  await collect(adapter.stream({ model: 'x', messages: [], sessionId: 'sess-S' }))

  const snap = createRoutingSnapshot({
    adapterOf: () => adapter,
    hintRegistry: reg,
    gateOf: () => gate,
    now: () => 1_800_000_000_000,
  })()
  assert.equal(snap.ok, true)
  assert.equal(snap.at, 1_800_000_000_000)
  assert.equal(snap.defaultBillingTier, 'free_only')
  assert.deepEqual(
    Object.keys(snap.lastAdmission.stats).sort(),
    ['billingTier', 'droppedBilling', 'droppedBlacklist', 'droppedConcurrency', 'droppedCooldown', 'kept', 'relaxed', 'total'],
  )
  assert.equal(snap.lastAdmission.stats.billingTier, 'paid_allowed')
  assert.equal(snap.chain.length, 2)
  assert.equal(snap.chain[0].billing, 'paid')
  assert.equal(snap.chain[0].billingSource, 'entry-paid')
  const g = snap.gate['paid-src']
  for (const k of ['active', 'limit', 'ratio', 'coolingMs', 'streak429', 'last429At']) {
    assert.equal(typeof g[k], 'number', `gate.${k} 必须是数字`)
  }
  assert.equal(g.limit, 2)
  assert.equal(snap.hintCount, 1)
})

test('/state 暴露 routing；未装配 routingSnapshot 时字段为 null（向后兼容）', async () => {
  const mkServer = () => {
    const routes = new Map()
    return { register: (r) => routes.set(r.path.replace(PREFIX, ''), r), get: (p) => routes.get(p) }
  }
  const call = async (srv, path) => {
    const r = srv.get(path)
    const res = { writeHead: () => {}, end: (b) => { try { res._body = JSON.parse(b) } catch { res._body = b } } }
    const req = { method: 'GET', url: PREFIX + path, headers: { host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' }, on: () => {} }
    await r.handler(req, res)
    return res._body
  }
  const state = {
    readProbe: async (d) => d ?? null, readConfig: async (d) => d ?? {}, readChain: async (d) => d ?? { chain: [] },
    writeChain: async () => true, writeConfig: async () => true, writeProbe: async () => true, overview: async () => ({ exists: false }),
  }
  const common = { state, version: 'test', trustedHosts: [], getChain: () => [], getConfig: () => ({}), fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }

  const withRouting = mkServer()
  registerRoutes(withRouting, { ...common, routingSnapshot: () => ({ ok: true, defaultBillingTier: 'free_only', gate: { p: { active: 0, limit: 1, ratio: 0, coolingMs: 0, streak429: 0, last429At: 0 } }, lastAdmission: { stats: { kept: 1 } } }) })
  const body = await call(withRouting, '/state')
  assert.equal(body.ok, true)
  assert.equal(body.routing.defaultBillingTier, 'free_only')
  assert.equal(body.routing.gate.p.limit, 1)

  const without = mkServer()
  registerRoutes(without, common)
  const body2 = await call(without, '/state')
  assert.equal(body2.ok, true, '老版本没有 routingSnapshot 也必须正常返回')
  assert.equal(body2.routing, null, '字段缺失要向后兼容（null，而不是报错/undefined）')
})

// ── ④ 插件装配：cordis 服务 + globalThis 符号 + /state.routing ──────────

test('装配级：apply() 提供 csMyfreeRouting 服务并安装 globalThis 符号；/state.routing 可读', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { apply } = await import('../src/index.js')

  const home = await mkdtemp(join(tmpdir(), 'cs-myfree-wiring-'))
  const routes = new Map()
  const provided = new Map()
  const ws = { register: (r) => routes.set(String(r.path).replace(PREFIX, ''), r) }
  const llm = { registerAdapter() {} }
  const ctx = {
    app: { version: '0.2.1-rc.2' },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    provide(key, value) { provided.set(key, value) },
    inject(services, cb) {
      const scoped = {}
      if (services.includes('llm')) scoped.llm = llm
      if (services.includes('webServer')) scoped.webServer = ws
      if (services.includes('web')) scoped.web = { registerSearchProvider() {} }
      try { cb(scoped) } catch { /* 与宿主一致：失败不影响其它 inject */ }
    },
  }
  try {
    uninstallGlobalHints()
    apply(ctx, { dshHome: home })

    // ① cordis 服务（可发现面）
    const api = provided.get('csMyfreeRouting')
    assert.ok(api, '必须 provide csMyfreeRouting')
    assert.equal(api.version, 2)
    for (const fn of ['setRequestHint', 'getRequestHint', 'clearRequestHint', 'chainSnapshot', 'admissionSnapshot', 'gateSnapshot']) {
      assert.equal(typeof api[fn], 'function', `api.${fn} 必须是函数`)
    }

    // ② globalThis 符号（cs-bots 的唯一入口）
    const globalReg = getGlobalHints()
    assert.ok(globalReg, 'apply 必须安装 globalThis 符号')
    api.setRequestHint('sess-w', { billing_tier: 'paid_allowed', source: 'test', at: Date.now() })
    assert.equal(globalReg.get('sess-w').billing_tier, 'paid_allowed')
    assert.equal(api.getRequestHint('sess-w').billing_tier, 'paid_allowed', '两条通道必须指向同一注册表')

    // ③ /state.routing（验证指标口径）
    const r = routes.get('/state')
    assert.ok(r, '必须注册 /state')
    const res = { writeHead() {}, end(b) { try { res._body = JSON.parse(b) } catch { res._body = b } } }
    await r.handler({ method: 'GET', url: PREFIX + '/state', headers: { host: 'localhost:3080' }, socket: { remoteAddress: '127.0.0.1' }, on: () => {} }, res)
    const body = res._body
    assert.equal(body.ok, true)
    assert.equal(body.routing.defaultBillingTier, 'free_only')
    assert.equal(typeof body.routing.gate, 'object')
    assert.ok(body.routing.hintCount >= 1)
    // 脱敏：快照里不出现原始 sessionId
    assert.equal(Boolean(body.routing.hints['sess-w']), false, 'hint 快照不得暴露原始 sessionId')
    assert.ok(Object.keys(body.routing.hints).some((k) => k.includes('***')))
    // 未跑请求前 lastAdmission 必须是 null（不假装有数据）
    assert.equal(body.routing.lastAdmission, null)
  } finally {
    uninstallGlobalHints()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

// ── ⑤ 跨仓契约方法名（防命名漂移；task-7）──────────────────────────────

test('globalThis 注册表暴露契约方法名 setRequestHint/getRequestHint/clearRequestHint', () => {
  const reg = createHintRegistry()
  try {
    assert.equal(installGlobalHints(reg), true)
    const api = globalThis[HINTS_SYMBOL].api
    assert.equal(typeof api.setRequestHint, 'function', 'cs-bots 的发现条件依赖这个方法')
    assert.equal(typeof api.getRequestHint, 'function')
    assert.equal(typeof api.clearRequestHint, 'function')
  } finally {
    uninstallGlobalHints()
  }
})

test('契约名往返：setRequestHint → getRequestHint（深比较）→ clearRequestHint → null', () => {
  const reg = createHintRegistry()
  try {
    installGlobalHints(reg)
    const api = globalThis[HINTS_SYMBOL].api
    const sid = 'sess-contract'
    const h = hint({ billing_tier: 'paid_allowed', complexity_tier: 'T1', agent_role: 'subagent', requires_paid: true, source: 'cs-bots/llm-stream', at: 1_700_000_000_000 })
    api.setRequestHint(sid, h)
    assert.deepEqual({ ...api.getRequestHint(sid) }, normalizeHint(h))
    assert.equal(api.clearRequestHint(sid), true)
    assert.equal(api.getRequestHint(sid), null)
  } finally {
    uninstallGlobalHints()
  }
})

test('别名与旧名指向同一实现（名字集合 ⊇ {set,get,setRequestHint,getRequestHint}）', () => {
  const reg = createHintRegistry()
  const names = new Set(Object.keys(reg))
  for (const n of ['set', 'get', 'setRequestHint', 'getRequestHint']) {
    assert.equal(names.has(n), true, `注册表缺少方法名 ${n}`)
  }
  assert.equal(reg.setRequestHint, reg.set, '别名必须是同一实现（不是复制逻辑）')
  assert.equal(reg.getRequestHint, reg.get)
  assert.equal(reg.clearRequestHint, reg.clear)
  // 两条通道行为一致
  reg.setRequestHint('s-x', hint({ billing_tier: 'free_only' }))
  assert.equal(reg.get('s-x').billing_tier, 'free_only')
  // 方法名不齐 ⇒ 拒绝安装（不装一个对方读不到的表）
  assert.equal(installGlobalHints({ set() {}, get() {} }), false)
  assert.equal(getGlobalHints(), null)
})
