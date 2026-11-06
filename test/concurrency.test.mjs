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

test('codearts 本地上限压到 1（上游会话不随连接关闭释放）', () => {
  // 实测（2026-11-04）：上游名额约 10s 才归还，一个请求就占一个 ⇒ 本地压到 1
  assert.equal(DEFAULT_LIMITS.codearts, 1)
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


// ── 冷却期（上游会话不随连接关闭释放）──
test('🔴 报「并发已满」⇒ 进入冷却期，期间直接判忙（不浪费往返）', async () => {
  const { createConcurrencyGate } = await import('../src/adapter/concurrency.js')
  const g = createConcurrencyGate({ limits: { x: 1, default: 1 }, busyCooldownMs: 500 })
  assert.equal(g.isCooling('x'), false)
  g.markBusy('x')
  assert.equal(g.isCooling('x'), true)
  const r = await g.acquire('x')
  assert.equal(r.ok, false)
  assert.equal(r.cooling, true)
  assert.match(r.reason, /冷却中/)
  await new Promise((res) => setTimeout(res, 560))
  assert.equal(g.isCooling('x'), false, '冷却期结束应恢复')
})

test('识别上游「并发已满」错误（TM.00001041 中文/英文形态都要认）', async () => {
  const { isChannelBusyError } = await import('../src/adapter/index.js')
  assert.equal(isChannelBusyError(new Error('codearts HTTP 400: {"error_code":"TM.00001041"}')), true)
  assert.equal(isChannelBusyError(new Error('渠道 codearts 并发会话已满（上游限制 3 个）')), true)
  assert.equal(isChannelBusyError(new Error('concurrent session limit')), true)
  assert.equal(isChannelBusyError(new Error('HTTP 500 server error')), false)
})

test('adapter：上游报满 ⇒ 该渠道冷却 + 降级到备用渠道成功', async () => {
  const { createConcurrencyGate } = await import('../src/adapter/concurrency.js')
  const gate = createConcurrencyGate({ limits: { codearts: 2, backup: 2, default: 2 }, busyCooldownMs: 3000 })
  const seen = []
  const adapter = createAdapter({
    builtin: [
      { provider: 'codearts', model: 'm', tier: 1 },
      { provider: 'backup', model: 'mb', tier: 2 },
    ],
    send: async ({ provider }) => {
      seen.push(provider)
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
  const chunks = []
  for await (const c of adapter.stream({ model: 'm', messages: [] })) chunks.push(c)
  assert.ok(chunks.some((c) => c.type === 'text-delta'), '应降级成功')
  assert.ok(seen.includes('backup'))
  assert.equal(gate.isCooling('codearts'), true, '报满的渠道必须进入冷却')
})

// ── 账号级并发（用户需求 #2：「自动切换区分每个账号的并发」）──────────────────
//
// 背景：上游并发会话数是**按账号**计的（codearts 硬上限 3 / buddy 实测 2），不是按渠道。
// 旧实现只有一条 `provider#default` 槽 ⇒ 同渠道 2 个账号互相挤占，A 占满后 B 永远被拒
// ⇒ 「多账号摊薄」形同虚设。下面三条测试分别钉住：账号维度独立、单账号语义不变、
// 以及 **adapter 真的把账号传进了闸门**（否则闸门再对也没用）。

test('🟥 账号级并发：同渠道 2 个账号，A 占满名额时 B 仍能拿到名额（证伪「共享名额」）', async () => {
  const gate = createConcurrencyGate({ limits: { p: 1, default: 1 } })
  const a = await gate.acquire('p', 'accA')
  assert.equal(a.ok, true)
  // 🔴 证伪点：共享名额的实现（只按 provider 计数）在这里必然返回 {ok:false, code:'CHANNEL_BUSY'}
  const b = await gate.acquire('p', 'accB')
  assert.equal(b.ok, true, '账号 B 的名额与 A 独立（A 占满不得挡住 B）')
  // A 自己仍受上限 1 约束（不是把上限放大成 2）
  const a2 = await gate.acquire('p', 'accA')
  assert.equal(a2.ok, false, '账号 A 自己仍受上限 1 约束')
  assert.equal(a2.code, 'CHANNEL_BUSY')

  const snap = gate.snapshot()
  assert.equal(snap.p.active, 2, 'provider 级 active = 该渠道下所有账号的并发之和')
  assert.deepEqual(Object.keys(snap.p.accounts).sort(), ['p#accA', 'p#accB'])
  assert.equal(snap.p.accounts['p#accA'].active, 1)
  assert.equal(snap.p.accounts['p#accB'].active, 1)
  assert.equal(snap.p.accounts['p#accB'].limit, 1)

  a.release(); b.release()
  assert.equal(gate.snapshot().p.active, 0)
  const again = await gate.acquire('p', 'accA')
  assert.equal(again.ok, true, '释放后 A 又能拿到自己的名额')
  again.release()
})

test('单账号语义不变：不带账号 ⇒ 仍共用 provider#default 单槽（上限照旧）', async () => {
  const gate = createConcurrencyGate({ limits: { p: 1, default: 1 } })
  const a = await gate.acquire('p')            // 与改造前完全相同的调用形态
  assert.equal(a.ok, true)
  const b = await gate.acquire('p')
  assert.equal(b.ok, false, '不带账号 ⇒ 共用 provider#default 槽（上限 1）')
  assert.equal(b.code, 'CHANNEL_BUSY')
  assert.equal(b.accountId, null, '无账号时如实回报 null（不是猜一个账号）')
  const snap = gate.snapshot()
  assert.equal(snap.p.active, 1)
  assert.deepEqual(Object.keys(snap.p.accounts), ['p#default'], '不带账号 ⇒ 只有默认槽')
  a.release()
  const c = await gate.acquire('p', '')        // 空串 = 没带账号（不得偷偷开新槽）
  assert.equal(c.ok, true)
  assert.deepEqual(Object.keys(gate.snapshot().p.accounts), ['p#default'])
  c.release()
})

test('snapshot() 形状冻结：扁平 provider 关键字一个不能少，账号明细只是新增字段', async () => {
  const gate = createConcurrencyGate({ limits: { x: 1, default: 1 } })
  const slot = await gate.acquire('x')
  gate.markBusy('x')
  const snap = gate.snapshot()
  // 🔴 诊断页/测试都按扁平形状取值：这些关键字一旦丢失，页面全是 undefined（半成品事故）
  for (const k of ['active', 'limit', 'ratio', 'coolingMs', 'streak429', 'last429At', 'lastSuccessAt', 'failRate']) {
    assert.ok(k in snap.x, `snapshot()[provider] 必须保留关键字 ${k}`)
  }
  assert.equal(typeof snap.x.active, 'number')
  assert.equal(typeof snap.x.accounts, 'object', '账号明细是新增字段（对象，键 = provider#accountId）')
  assert.equal(snap.x.accounts['x#default'].active, 1)
  assert.equal(snap.x.active, snap.x.accounts['x#default'].active, '单账号时聚合值 == 该账号值')
  slot.release()
})

test('🟥 adapter 真的把账号传进闸门：账号 A 满 + 默认槽满 时，候选仍能靠账号 B 的名额发出', async () => {
  const gate = createConcurrencyGate({ limits: { p: 1, default: 1 } })
  // 账号 A：模拟另一个子智能体正占着 A 的名额
  const hogA = await gate.acquire('p', 'accA')
  // 默认槽：模拟**不带账号**的调用方（如连通性测试走 driver → gate.acquire(p)）
  const hogDefault = await gate.acquire('p')
  const calls = []
  const adapter = createAdapter({
    builtin: [
      { provider: 'p', model: 'model-a', tier: 1 },
      { provider: 'p', model: 'model-b', tier: 2 },
    ],
    // 装配层将来接线的注入点：候选 → 账号
    accountOf: (cand) => (cand.model === 'model-a' ? 'accA' : 'accB'),
    send: async ({ model }) => {
      calls.push(model)
      return (async function* () {
        yield { type: 'text-delta', text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    concurrency: gate,
  })
  const chunks = []
  for await (const c of adapter.stream({ model: 'nomatch', messages: [] })) chunks.push(c)
  assert.ok(chunks.some((c) => c.type === 'text-delta'), '必须靠账号 B 的名额成功')
  // 🔴 证伪点：若 adapter 不把账号传给闸门，两个候选都会落到 p#default（已被占满）
  //    ⇒ 一个都不会发送，两轮兜底等待后抛 CHANNEL_BUSY（本断言拿到的 calls 会是 []）。
  assert.deepEqual(calls, ['model-b'], 'model-a 的账号已满、默认槽已满 ⇒ 只有账号 B 该被发出')
  assert.equal(gate.snapshot().p.accounts['p#accB'].active, 0, '成功后名额必须归还')
  hogA.release(); hogDefault.release()
})
