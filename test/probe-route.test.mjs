/**
 * cs-myfree — 探测路由（probe-route）最小护栏
 *
 * ⚠️ 本文件的目的**不是**证明探测路由可用 —— 它**没有接线**（详见 probe-route.js 文件头）。
 *    目的是防止这套已写好的纯函数在无人使用的情况下继续腐化：
 *    · 有人改动 `model-chain` / `probe` / `retry-scheduler` 时，能立刻知道有没有碰坏它；
 *    · 有人误以为它已启用时，下面第 ⑤ 组会用**代码事实**纠正这个认知。
 *
 * 覆盖：
 *   ① 构造失败 → 选路：探测失败的渠道被排除，并给出可读原因
 *   ② 付费闸门：free_only 下付费池绝不进候选（fail-closed）
 *   ③ 冷启动兜底：探测缓存为空时不至于无候选
 *   ④ 失败 → 重试计划：只有模型类失败才登记，且如实累加次数
 *   ⑤【主线事实】planRoute 未被接线、useProbeRoute 开关不改变选路
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { planRoute, buildDetailedError, handleFailure, summarizePlans } from '../src/adapter/probe-route.js'
import { mergeAvailability } from '../src/adapter/probe.js'
import { entryKey } from '../src/adapter/model-chain.js'
import { createAdapter } from '../src/adapter/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

const chain = [
  { provider: 'kilo', model: 'kilo-auto/free', tier: 1 },
  { provider: 'ovh', model: 'Qwen3.5-397B-A17B', tier: 2 },
  { provider: 'codearts', model: 'codearts/deepseek-v4-pro', tier: 1 },
]

// ══════════════════════════════════════════════════════════════════════════
// ① 构造失败 → 选路
// ══════════════════════════════════════════════════════════════════════════

test('① 探测失败的渠道被排除，可用渠道按 tier 排好序', () => {
  // codearts 探测失败（401），另外两个可用
  const available = mergeAvailability([
    { provider: 'kilo', model: 'kilo-auto/free', ok: true, ms: 100 },
    { provider: 'ovh', model: 'Qwen3.5-397B-A17B', ok: true, ms: 300 },
    { provider: 'codearts', model: 'codearts/deepseek-v4-pro', ok: false, error: '401 not_authorized' },
  ])
  assert.equal(available.has(entryKey({ provider: 'codearts', model: 'codearts/deepseek-v4-pro' })), false,
    '探测失败的条目不应进入可用集合')

  const plan = planRoute({
    chain,
    probeCache: { at: 1_000, ttlMs: 60_000, available: [...available] },
    paidAllowed: false,
    now: 2_000,
  })

  assert.deepEqual(plan.candidates.map((c) => `${c.provider}/${c.model}`),
    ['kilo/kilo-auto/free', 'ovh/Qwen3.5-397B-A17B'],
    '只从可用集合里选，且按 tier 升序（kilo tier1 在 ovh tier2 之前）')
  assert.equal(plan.excluded.length, 1, 'codearts 被排除，且要如实报出来')
  assert.equal(plan.excluded[0].provider, 'codearts')
  assert.equal(plan.excluded[0].reason, '探测不可用')
})

test('① 全部探测失败 ⇒ 候选为空（不静默挑一个没探测过的）', () => {
  const available = mergeAvailability([
    { provider: 'kilo', model: 'kilo-auto/free', ok: false },
    { provider: 'ovh', model: 'Qwen3.5-397B-A17B', ok: false },
    { provider: 'codearts', model: 'codearts/deepseek-v4-pro', ok: false },
  ])
  // ⚠️ available 为空时 planRoute 会走「冷启动兜底」（见 ③），所以这里塞一个
  //    非空的可用集合，但里面没有链上的条目 —— 模拟「探测过，但全挂了」
  const plan = planRoute({
    chain,
    probeCache: { at: 1_000, ttlMs: 60_000, available: ['someone\u0000else'] },
    paidAllowed: false,
    now: 2_000,
  })
  assert.deepEqual(plan.candidates, [], '没有任何可用候选时必须是空数组')
  assert.equal(plan.excluded.length, 3, '三个条目都要有被排除的原因')
})

// ══════════════════════════════════════════════════════════════════════════
// ② 付费闸门 fail-closed
// ══════════════════════════════════════════════════════════════════════════

test('② free_only ⇒ 付费池绝不进候选（即便探测可用）', () => {
  const paidChain = [
    { provider: 'kilo', model: 'kilo-auto/free', tier: 1 },
    { provider: 'deepseek-official', model: 'deepseek-chat', tier: 1, paid: true },
  ]
  const available = ['kilo\u0000kilo-auto/free', 'deepseek-official\u0000deepseek-chat']

  const denied = planRoute({
    chain: paidChain,
    probeCache: { at: 1_000, ttlMs: 60_000, available },
    paidAllowed: false,
    now: 2_000,
  })
  assert.deepEqual(denied.candidates.map((c) => c.provider), ['kilo'],
    'free_only 下付费候选必须被剔除')
  assert.equal(denied.paidCount, 0)
  assert.ok(denied.excluded.some((e) => e.provider === 'deepseek-official'
    && e.reason.includes('付费池未授权')), '排除原因要说清是授权问题，不是渠道坏了')

  const allowed = planRoute({
    chain: paidChain,
    probeCache: { at: 1_000, ttlMs: 60_000, available },
    paidAllowed: true,
    now: 2_000,
  })
  assert.deepEqual(allowed.candidates.map((c) => c.provider), ['kilo', 'deepseek-official'],
    '授权后付费池作为兜底排在免费之后')
  assert.equal(allowed.paidCount, 1)
})

// ══════════════════════════════════════════════════════════════════════════
// ③ 冷启动兜底
// ══════════════════════════════════════════════════════════════════════════

test('③ 探测缓存为空（冷启动）⇒ 退化为链里全部条目，并标记 stale', () => {
  // ⚠️ 这里必须用**真实量级**的 now：`isProbeStale` 判的是 `now - at > ttlMs`，
  //    空缓存的 at=0、默认 ttl 5 分钟 ⇒ 传 now=2000 会被判成「没过期」（写测试时踩过这个坑）。
  const NOW = 1_800_000_000_000
  const plan = planRoute({ chain, probeCache: {}, paidAllowed: false, now: NOW })
  // 排序口径是 **tier 升序，同 tier 按链内原始顺序**（不是链里的书写顺序）：
  //   kilo(t1,_i=0) → codearts(t1,_i=2) → ovh(t2,_i=1)
  assert.deepEqual(plan.candidates.map((c) => c.provider), ['kilo', 'codearts', 'ovh'],
    '冷启动不能因为没有探测结果就无候选可用；顺序按 tier 升序（同 tier 保持链内次序）')
  assert.equal(plan.candidates.length, 3, '链里 3 个条目都应成为候选')
  assert.equal(plan.stale, true, '没有探测时间 ⇒ 必须标记过期，提示调用方去重探')
})

// ══════════════════════════════════════════════════════════════════════════
// ④ 失败 → 重试计划
// ══════════════════════════════════════════════════════════════════════════

test('④ 模型类失败 ⇒ 登记重试计划并累加次数；非模型类失败不登记', () => {
  const first = handleFailure(null, { provider: 'a', model: 'm', kind: 'SERVER', at: 1_000 })
  assert.ok(first.plan, 'SERVER 属模型类失败 ⇒ 必须登记重试计划')
  assert.equal(first.plan.attempt, 1)
  assert.equal(first.retry, true)

  const second = handleFailure(first.plan, { provider: 'a', model: 'm', kind: 'SERVER', at: 2_000 })
  assert.equal(second.plan.attempt, 2, '再次失败必须如实累加，不能重置')

  // QUOTA 属账号级（换号即可，不需要等待重试计划）
  const quota = handleFailure(null, { provider: 'a', model: 'm', kind: 'QUOTA', at: 1_000 })
  assert.equal(quota.plan, null, '非模型类失败不应登记重试计划')

  const sum = summarizePlans([second.plan], 5_000)
  assert.equal(sum.total, 1)
  assert.equal(sum.pending, 1, '未到重试时间 ⇒ pending')
})

test('④ 详细错误：付费被拦与真的全挂，文案必须能区分', () => {
  const billing = buildDetailedError({
    code: 'PERMISSION',
    excluded: [{ provider: 'deepseek-official', model: 'deepseek-chat', reason: '付费池未授权（free_only）' }],
  })
  assert.match(billing.message, /free_only/, '付费拦截要直说授权问题')
  assert.equal(billing.code, 'PERMISSION')

  const dead = buildDetailedError({
    failures: [{ provider: 'kilo', model: 'kilo-auto/free', kind: 'SERVER' }],
    excluded: [],
  })
  assert.match(dead.message, /全部可用模型失败/)
  assert.match(dead.message, /kilo\/kilo-auto\/free：SERVER/, '必须列出哪个渠道怎么挂的')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑤【主线事实】探测路由未接线 —— 防止「文档说能用、代码没接」再次发生
// ══════════════════════════════════════════════════════════════════════════

test('⑤ 事实核对：选路主循环不调用 planRoute（探测路由没接进请求路径）', async () => {
  const files = [
    join(SRC, 'adapter', 'index.js'),      // 降级链 / stream() 主循环
    join(SRC, 'web', 'routing.js'),        // 路由快照
  ]
  for (const f of files) {
    let src = ''
    try { src = await readFile(f, 'utf8') } catch { continue }
    // 去掉 import 行与注释，剩下的才是「真的在调用」
    const body = src.split('\n')
      .filter((l) => !/^\s*import\s/.test(l))
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    assert.equal(/planRoute\s*\(/.test(body), false,
      `${f} 不应调用 planRoute —— 若已接线，请同步更新 probe-route.js 文件头与本用例`)
  }
})

test('⑤ 事实核对：HTTP 层给 planRoute 留了口子，但 src/index.js 没注入 ⇒ route 恒为 null', async () => {
  const routes = await readFile(join(SRC, 'web', 'routes.js'), 'utf8')
  // routes.js 里确实有一处「有就用、没有就 null」的软接线
  assert.match(routes, /typeof opts\.planRoute === 'function' \? opts\.planRoute\(/,
    '/model-chain 仍保留了 opts.planRoute 的软接线口子')

  const index = await readFile(join(SRC, 'index.js'), 'utf8')
  assert.equal(/\bplanRoute\b/.test(index), false,
    'src/index.js 从未注入 planRoute ⇒ /model-chain 的 route 字段恒为 null（线上实测为空）。'
    + ' 若已注入，请同步更新本用例与 README「实验特性」一节')
})

test('⑤ 事实核对：useProbeRoute 打开/关闭，选路结果完全一致', async () => {
  const run = async (useProbeRoute) => {
    const calls = []
    const adapter = createAdapter({
      builtin: [
        { provider: 'a', model: 'ma', tier: 1 },
        { provider: 'b', model: 'mb', tier: 2 },
      ],
      routingConfig: () => ({ useProbeRoute }),
      send: async ({ provider, model }) => {
        calls.push(`${provider}/${model}`)
        return (async function* () { yield { type: 'text-delta', text: 'ok' } })()
      },
    })
    for await (const _c of adapter.stream({ provider: 'cs-myfree', model: 'ma', messages: [] })) { /* drain */ }
    return calls
  }
  const off = await run(false)
  const on = await run(true)
  assert.deepEqual(on, off, 'useProbeRoute 目前不参与任何分支 ⇒ 开与关的选路必须一模一样')
})

test('⑤ 事实核对：probe-route 文件头必须保留「未接线」声明', async () => {
  const src = await readFile(join(SRC, 'adapter', 'probe-route.js'), 'utf8')
  assert.match(src, /未接线/, '文件头必须写明它没有接线（否则后人会误以为它已启用）')
  assert.match(src, /实验特性/, '必须标注为实验特性')
})