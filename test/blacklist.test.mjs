/**
 * cs-myfree — 终态失败**黑名单层**（真实账本根因 1）
 *
 * 背景（ledger.jsonl 1756 条实测）：buddy 73 次调用 **73 次全败**（INVALID_REQUEST 66 / AUTH 6）、
 * qoder 73 次 **73 次全败**（INVALID_REQUEST 71），但它们一直留在生效链里 ⇒ 每次请求都还要撞一遍。
 * `failure-map.js` 的 `TERMINAL` / `TTL_MS` 早就定义了，却没有任何地方消费。
 *
 * 本层是**过滤层，不是排序**（契约 §2 的排序一行不改）；位置在 billing 之后（①.5），
 * 且**不参与空集回退**（全黑时也不回去撞死渠道）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBlacklist, getSharedBlacklist, resetSharedBlacklist } from '../src/adapter/blacklist.js'
import { TTL_MS, KIND } from '../src/adapter/failure-map.js'
import { admitCandidates } from '../src/adapter/admission.js'
import { createAdapter } from '../src/adapter/index.js'
import { createConcurrencyGate } from '../src/adapter/concurrency.js'

async function drain(iter) { for await (const _c of iter) { /* drain */ } }
const fail = (status, msg = 'boom') => Object.assign(new Error(msg), { status })

// ── 纯函数层 ──────────────────────────────────────────────────────────

test('只有 TERMINAL 失败才拉黑；TTL 取 failure-map.TTL_MS[kind]', () => {
  const bl = createBlacklist({ now: () => 1_000 })
  assert.equal(bl.record('buddy', KIND.SERVER), null, 'SERVER 可自愈 ⇒ 不拉黑')
  assert.equal(bl.record('buddy', KIND.RATE_LIMIT), null, 'RATE_LIMIT 是瞬时 ⇒ 不拉黑')
  const e = bl.record('buddy', KIND.INVALID_REQUEST)
  assert.equal(e.kind, KIND.INVALID_REQUEST)
  assert.equal(e.ttlMs, TTL_MS[KIND.INVALID_REQUEST])
  assert.equal(bl.isBlacklisted('buddy'), true)
  assert.equal(bl.isBlacklisted('qoder'), false, '只影响命中的 provider')
})

test('TTL 到期自动移除（注入时钟，不睡）', () => {
  let t = 0
  const bl = createBlacklist({ now: () => t })
  bl.record('qoder', KIND.INVALID_REQUEST)          // 6h
  t = TTL_MS[KIND.INVALID_REQUEST] - 1
  assert.equal(bl.isBlacklisted('qoder'), true)
  t = TTL_MS[KIND.INVALID_REQUEST] + 1
  assert.equal(bl.isBlacklisted('qoder'), false, '过期必须失效（否则永久误杀）')
  assert.equal(bl.size, 0)
})

test('成功/手动解除 ⇒ 立刻移出黑名单', () => {
  const bl = createBlacklist()
  bl.record('buddy', KIND.AUTH)
  assert.equal(bl.isBlacklisted('buddy'), true)
  assert.equal(bl.clear('buddy'), true)
  assert.equal(bl.isBlacklisted('buddy'), false)
  assert.equal(bl.clear('buddy'), false, '重复解除返回 false')
})

test('🔴 粒度 = provider 级：一个终态失败挡掉该渠道全部模型（不连坐半个渠道）', () => {
  const bl = createBlacklist()
  // 传 model 也只记 provider 级（旧实现记 model 级 ⇒ 同渠道可用模型被连坐）
  bl.record('codearts', KIND.INVALID_REQUEST, { model: 'codearts/flash' })
  assert.equal(bl.isBlacklisted('codearts'), true)
  assert.equal(bl.snapshot()[0].model, null, '条目必须是 provider 级（model 恒为 null）')
  // clear(provider) 必须清得掉（旧实现返回 false ⇒ 成功自动解除永远走不到）
  assert.equal(bl.clear('codearts'), true)
  assert.equal(bl.isBlacklisted('codearts'), false)
})

test('snapshot 含 provider/model/kind/remainMs，且不含凭据', () => {
  const bl = createBlacklist()
  bl.record('buddy', KIND.INVALID_REQUEST, { model: 'deepseek-v4.1-flash' })
  const snap = bl.snapshot()
  assert.equal(snap.length, 1)
  assert.deepEqual(Object.keys(snap[0]).sort(), ['hits', 'kind', 'model', 'provider', 'remainMs', 'until'])
  assert.ok(snap[0].remainMs > 0)
})

test('共享实例：getSharedBlacklist 单例 + reset', () => {
  resetSharedBlacklist()
  const a = getSharedBlacklist()
  const b = getSharedBlacklist()
  assert.equal(a, b)
  a.record('buddy', KIND.AUTH)
  assert.equal(b.isBlacklisted('buddy'), true)
  resetSharedBlacklist()
})

// ── 准入器集成（过滤层，不改排序）─────────────────────────────────────

test('准入器：黑名单候选被剔除（reason=blacklist），排序不受影响', () => {
  const r = admitCandidates({
    candidates: [
      { provider: 'buddy', model: 'm1', tier: 1 },
      { provider: 'codearts', model: 'm2', tier: 2 },
    ],
    isBlacklisted: (p) => p === 'buddy',
  })
  assert.deepEqual(r.eligible.map((e) => e.provider), ['codearts'])
  assert.deepEqual(r.excluded, [{ candidate: { provider: 'buddy', model: 'm1', tier: 1 }, reason: 'blacklist' }])
  assert.equal(r.stats.droppedBlacklist, 1)
})

test('🔴 billing 硬过滤先于黑名单：free_only 下 paid 候选记 billing（不是 blacklist）', () => {
  const r = admitCandidates({
    candidates: [
      { provider: 'paid-x', model: 'p', tier: 1, billing: 'paid' },
      { provider: 'free-y', model: 'f', tier: 2, billing: 'free' },
    ],
    billingTier: 'free_only',
    isBlacklisted: () => true,               // 两个都被拉黑
  })
  assert.equal(r.eligible.length, 0)
  const reasons = r.excluded.map((x) => x.candidate.provider + ':' + x.reason)
  assert.deepEqual(reasons, ['paid-x:billing', 'free-y:blacklist'], '付费未授权的原因必须仍是 billing')
})

test('🔴 黑名单**不参与**空集回退（全黑时不会退回去撞死渠道）', () => {
  const r = admitCandidates({
    candidates: [{ provider: 'buddy', model: 'm', tier: 1 }],
    isBlacklisted: () => true,
    isCooling: () => true,                   // 同时冷却，逼出兜底逻辑
  })
  assert.equal(r.eligible.length, 0, '黑名单候选绝不能被兜底放回')
  assert.equal(r.stats.relaxed, null)
})

// ── adapter 集成（真实路径）──────────────────────────────────────────

test('🔴 连续 INVALID_REQUEST ⇒ 该 provider 不再被尝试（buddy/qoder 场景）', async () => {
  const calls = []
  const events = []
  const adapter = createAdapter({
    builtin: [
      { provider: 'buddy', model: 'deepseek-v4.1-flash', tier: 1 },
      { provider: 'ok-src', model: 'm-ok', tier: 2 },
    ],
    send: async ({ provider }) => {
      calls.push(provider)
      if (provider === 'buddy') throw fail(400, 'HTTP 400: request illegal')
      return (async function* () { yield { type: 'text-delta', text: 'ok' } })()
    },
    concurrency: createConcurrencyGate({ limits: { buddy: 2, 'ok-src': 2, default: 2 }, busyCooldownMs: 5 }),
    onEvent: (e) => events.push(e),
  })
  // 第 1 次：撞 buddy 失败 → 拉黑 → 降级成功
  await drain(adapter.stream({ model: 'x', messages: [] }))
  assert.deepEqual(calls, ['buddy', 'ok-src'])
  const bl = events.filter((e) => e.type === 'blacklist')
  assert.equal(bl.length, 1, '必须发出 blacklist 事件（可审计）')
  assert.equal(bl[0].provider, 'buddy')
  assert.equal(bl[0].kind, 'INVALID_REQUEST')
  assert.ok(bl[0].ttlMs > 0)
  // 第 2/3 次：不再尝试 buddy
  calls.length = 0
  await drain(adapter.stream({ model: 'x', messages: [] }))
  await drain(adapter.stream({ model: 'x', messages: [] }))
  assert.deepEqual(calls, ['ok-src', 'ok-src'], '拉黑后不得再尝试该渠道')
})

test('TTL 到期后该渠道重新上链；成功一次即把条目清掉', async () => {
  let t = 0
  const bl = createBlacklist({ now: () => t })
  const calls = []
  let mode = 'fail'
  const adapter = createAdapter({
    builtin: [{ provider: 'buddy', model: 'm', tier: 1 }],
    blacklist: bl,
    send: async ({ provider }) => {
      calls.push(provider)
      if (mode === 'fail') throw fail(400, 'HTTP 400: request illegal')
      return (async function* () { yield { type: 'text-delta', text: 'ok' } })()
    },
    concurrency: createConcurrencyGate({ limits: { buddy: 2, default: 2 }, busyCooldownMs: 1 }),
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.equal(bl.isBlacklisted('buddy'), true)

  // 拉黑期间：零尝试
  calls.length = 0
  t += 1_000
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.deepEqual(calls, [], '拉黑期间不得尝试')

  // TTL 到期 + 渠道恢复 ⇒ 重新上链并成功，条目被清掉
  t += TTL_MS[KIND.INVALID_REQUEST] + 1
  mode = 'ok'
  const out = []
  for await (const c of adapter.stream({ model: 'x', messages: [] })) out.push(c)
  assert.ok(out.some((c) => c.type === 'text-delta'))
  assert.equal(bl.isBlacklisted('buddy'), false, '成功 ⇒ 解除黑名单')
})

test('🔴 黑名单命中期间的失败不会重复触发 last-resort/二次尝试空转', async () => {
  const calls = []
  const events = []
  const adapter = createAdapter({
    builtin: [{ provider: 'buddy', model: 'm', tier: 1 }],
    send: async ({ provider }) => { calls.push(provider); throw fail(400, 'HTTP 400: request illegal') },
    concurrency: createConcurrencyGate({ limits: { buddy: 2, default: 2 }, busyCooldownMs: 5 }),
    onEvent: (e) => events.push(e),
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  const firstCalls = calls.length
  calls.length = 0
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.equal(calls.length, 0, '第二次请求完全不打已拉黑渠道')
  assert.ok(firstCalls >= 1)
})

test('并发满（400 TM.00001041）**不**拉黑（瞬时，由冷却处理）', async () => {
  const events = []
  const calls = []
  const adapter = createAdapter({
    builtin: [
      { provider: 'codearts', model: 'm1', tier: 1 },
      { provider: 'ok-src', model: 'm2', tier: 2 },
    ],
    send: async ({ provider }) => {
      calls.push(provider)
      if (provider === 'codearts') throw fail(400, 'HTTP 400: {"error_code":"TM.00001041","error_msg":"并发会话数已达上限"}')
      return (async function* () { yield { type: 'text-delta', text: 'ok' } })()
    },
    concurrency: createConcurrencyGate({ limits: { codearts: 2, 'ok-src': 2, default: 2 }, busyCooldownMs: 5 }),
    onEvent: (e) => events.push(e),
  })
  await drain(adapter.stream({ model: 'x', messages: [] }))
  assert.equal(events.filter((e) => e.type === 'blacklist').length, 0, '并发满不是终态，不得拉黑')
  calls.length = 0
  await new Promise((r) => setTimeout(r, 30))     // 让 busy 冷却（1ms×退避）过期
  await drain(adapter.stream({ model: 'x', messages: [] }))
  assert.ok(calls.includes('codearts'), '并发满不拉黑 ⇒ 冷却过后仍会尝试')
})

// ── 根因 2：codearts 的 400 实为「并发会话已满」，不是参数错误 ──────────

test('🔴 上游「并发会话已满」400 ⇒ 语义归 RATE_LIMIT（账本不记 INVALID_REQUEST）、不拉黑', async () => {
  const records = []
  const events = []
  const adapter = createAdapter({
    builtin: [
      { provider: 'codearts', model: 'm1', tier: 1 },
      { provider: 'ok-src', model: 'm2', tier: 2 },
    ],
    send: async ({ provider }) => {
      if (provider === 'codearts') {
        // 真实形态：driver 把上游 TM.00001041 归一成中文文案 + code=RATE_LIMIT
        const e = Object.assign(new Error('渠道 codearts 并发会话已满（上游限制 3 个）：请稍后重试，或关闭其它窗口/会话'), { status: 400, code: 'RATE_LIMIT' })
        throw e
      }
      return (async function* () { yield { type: 'text-delta', text: 'ok' } })()
    },
    concurrency: createConcurrencyGate({ limits: { codearts: 2, 'ok-src': 2, default: 2 }, busyCooldownMs: 5 }),
    onRecord: (r) => records.push(r),
    onEvent: (e) => events.push(e),
  })
  await drain(adapter.stream({ model: 'x', messages: [] }))
  const failRec = records.find((r) => r.ok === false && r.provider === 'codearts')
  assert.ok(failRec, '应记录一条失败')
  assert.equal(failRec.code, 'RATE_LIMIT', '并发满必须记 RATE_LIMIT；记 INVALID_REQUEST 会污染账本并触发终态语义')
  assert.equal(events.filter((e) => e.type === 'blacklist').length, 0, '并发满不得拉黑')
})

test('isConcurrencyCapError 覆盖我们自己的归一化文案', async () => {
  const { isConcurrencyCapError } = await import('../src/pools/channels/driver.js')
  assert.equal(isConcurrencyCapError('渠道 codearts 并发会话已满（上游限制 3 个）：请稍后重试'), true)
  assert.equal(isConcurrencyCapError('TM.00001041'), true)
  assert.equal(isConcurrencyCapError('HTTP 400: request illegal'), false)
})

test('🔴 adapter 级：同 provider 两个 model，第 1 次 INVALID_REQUEST 后第 2 次整渠道都不再尝试', async () => {
  const calls = []
  const events = []
  const adapter = createAdapter({
    builtin: [
      { provider: 'codearts', model: 'codearts/flash', tier: 1 },
      { provider: 'codearts', model: 'codearts/v4.1', tier: 2 },
      { provider: 'ok-src', model: 'm-ok', tier: 3 },
    ],
    send: async ({ provider, model }) => {
      calls.push(`${provider}/${model}`)
      if (provider === 'codearts') throw Object.assign(new Error('HTTP 400: request illegal'), { status: 400 })
      return (async function* () { yield { type: 'text-delta', text: 'ok' } })()
    },
    concurrency: createConcurrencyGate({ limits: { codearts: 4, 'ok-src': 4, default: 2 }, busyCooldownMs: 5 }),
    onEvent: (e) => events.push(e),
  })
  // 第 1 次请求：先撞 codearts/flash（终态 ⇒ 拉黑 provider）→ 同请求里 codearts/v4.1 也不该再撞
  await drain(adapter.stream({ model: 'x', messages: [] }))
  assert.deepEqual(calls, ['codearts/codearts/flash', 'ok-src/m-ok'], '拉黑后同渠道第二个 model 也要跳过（同请求内）')
  assert.equal(events.filter((e) => e.type === 'blacklist').length, 1)

  // 第 2 次请求：整个 codearts 渠道零尝试
  calls.length = 0
  await drain(adapter.stream({ model: 'x', messages: [] }))
  assert.deepEqual(calls, ['ok-src/m-ok'], '第 2 次请求不得再尝试已拉黑渠道的任何模型')
})

test('🔴 解除后该渠道（全部 model）重新可试', async () => {
  const calls = []
  const bl = createBlacklist()
  let mode = 'fail'
  const adapter = createAdapter({
    builtin: [
      { provider: 'codearts', model: 'codearts/flash', tier: 1 },
      { provider: 'codearts', model: 'codearts/v4.1', tier: 2 },
    ],
    blacklist: bl,
    send: async ({ provider, model }) => {
      calls.push(model)
      if (mode === 'fail') throw Object.assign(new Error('HTTP 400: request illegal'), { status: 400 })
      return (async function* () { yield { type: 'text-delta', text: 'ok' } })()
    },
    concurrency: createConcurrencyGate({ limits: { codearts: 4, default: 2 }, busyCooldownMs: 1 }),
  })
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.equal(bl.isBlacklisted('codearts'), true)
  calls.length = 0
  await assert.rejects(() => drain(adapter.stream({ model: 'x', messages: [] })))
  assert.deepEqual(calls, [], '拉黑期间零尝试')
  // 手动解除（诊断页"重新启用"）⇒ 两个 model 都回到候选
  assert.equal(bl.clear('codearts'), true)
  mode = 'ok'
  const out = []
  for await (const c of adapter.stream({ model: 'x', messages: [] })) out.push(c)
  assert.ok(out.some((c) => c.type === 'text-delta'))
  assert.equal(calls.length, 1, '解除后重新尝试（首个可用即停）')
})
