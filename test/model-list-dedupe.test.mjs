/**
 * cs-myfree — 模型选择器去重（方案①：别名只做路由，不声明模型）
 *
 * 背景（真实缺陷，2026-11-22）：
 *   为修 NO_ADAPTER，`src/index.js` 把**同一个 adapter 注册到 22 个 provider id**
 *   （`cs-myfree` + 21 个渠道别名）。宿主 `buildModelCatalog()`
 *   （dsh-api-session-controller:524-573）会**遍历 listProviders() 逐个取 listModels
 *   并各自成组**、且**不做跨组去重**：
 *       const providers = ctx.llm.listProviders();               // 22 个
 *       const models = await ctx.llm.listModels(provider.id);    // 各取一次
 *       return { kind:'group', group:{ id: provider.id, models } } // 各自成组
 *   旧实现对所有别名都返回整条链 ⇒ 3 个模型 × 22 = 66 条，用户看到「一堆重复」。
 *
 * 方案①：别名 `listModels()` 返回 []，只有主 provider 声明模型。
 *   安全性依据：宿主 `listModels` 与 `prepareCall`/路由走的是**同一个**
 *   `registration(provider).adapter` 查找（dsh-llm:2193 与 :2264），**不经过 catalog**
 *   ⇒ 收窄「声明模型」不影响「按别名选中 / 发请求 / 降级切换」。
 *
 * 本文件锁死的契约：
 *   ① 别名不产生模型组；主 provider 照常声明（选择器只剩 1 组）
 *   ② 复刻 buildModelCatalog：组数 1、条目数 = 模型数、无重复 id
 *   ③ 路由不退化：按别名仍能 resolveModel / prepareCall / 发流
 *   ④ 故障切换不退化：某渠道挂掉仍能切到下一个（含「选择器只列一个，但链里多个渠道」）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAdapter, providerAliases, PROVIDER_ID } from '../src/adapter/index.js'

async function collect(iter) { const out = []; for await (const c of iter) out.push(c); return out }
const textOf = (out) => out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')

const chain = [
  { provider: 'kilo', model: 'kilo-auto/free', tier: 1 },
  { provider: 'ovh', model: 'Qwen3.5-397B-A17B', tier: 1 },
  { provider: 'pollinations', model: 'openai', tier: 2 },
]

const mk = (opts = {}) => createAdapter({
  builtin: opts.builtin ?? chain,
  extraModels: opts.extraModels ?? (() => []),
  directModel: opts.directModel,
  send: opts.send ?? (async () => []),
  ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
})

/**
 * 复刻宿主 `buildModelCatalog()` 的取数逻辑（dsh-api-session-controller:524-573）。
 * 只搬「遍历 providers → 各自 listModels → 各自成组 → 丢掉空组」这一段，
 * 目的就是把「选择器真正会看到什么」变成可断言的东西。
 */
function buildModelCatalog(adapter) {
  const providers = [PROVIDER_ID, ...providerAliases()].map((id) => ({ id, name: id }))
  const groups = []
  for (const p of providers) {
    const models = adapter.listModels(p.id)
    if (models.length > 0) groups.push({ id: p.id, name: p.name, models })
  }
  return {
    groups,
    routableProviders: groups.map((g) => g.id),
    items: groups.flatMap((g) => g.models.map((m) => ({ ...m, group: g.id }))),
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ① 别名不产生模型组
// ══════════════════════════════════════════════════════════════════════════

test('① 别名 provider 的 listModels 一律返回 []（不产生模型组）', () => {
  const a = mk()
  for (const alias of providerAliases()) {
    assert.deepEqual(a.listModels(alias), [], `别名 ${alias} 不得对外声明模型`)
  }
})

test('① 主 provider 照常声明模型', () => {
  const a = mk()
  const models = a.listModels(PROVIDER_ID)
  assert.deepEqual(models.map((m) => m.id), chain.map((e) => e.model))
  assert.ok(models.every((m) => m.provider === PROVIDER_ID), '每项 provider 必须是主 id')
})

test('① 未知 provider 仍返回 []（与别名一致，不抛错）', () => {
  const a = mk()
  assert.deepEqual(a.listModels('完全不存在的provider'), [])
})

// ══════════════════════════════════════════════════════════════════════════
// ② 复刻宿主 buildModelCatalog —— 66 → 3、组数 22 → 1
// ══════════════════════════════════════════════════════════════════════════

test('⭐ 核心：选择器只剩 1 组、条目数 = 模型数、无重复 id（改造前是 22 组 / 66 条）', () => {
  const a = mk()
  const cat = buildModelCatalog(a)

  assert.equal(cat.groups.length, 1, '注册了 22 个 provider，但只有主 provider 成组')
  assert.deepEqual(cat.routableProviders, [PROVIDER_ID])
  assert.equal(cat.items.length, chain.length, '条目数必须等于模型数（不是 模型数 × provider 数）')

  const ids = cat.items.map((m) => m.id)
  assert.equal(new Set(ids).size, ids.length, '选择器里不得有重复的 model id')
})

test('② 每个模型只出现一次（逐个点名，防回归）', () => {
  const a = mk()
  const cat = buildModelCatalog(a)
  for (const e of chain) {
    const n = cat.items.filter((m) => m.id === e.model).length
    assert.equal(n, 1, `${e.model} 应只出现 1 次，实际 ${n} 次`)
  }
})

test('② 渠道模型（extraModels）进链时也不会被放大', () => {
  const a = createAdapter({
    builtin: [
      { provider: 'kilo', model: 'kilo-auto/free', tier: 1 },
      { provider: 'codearts', model: 'codearts/deepseek-v4-pro', tier: 1 },
    ],
    extraModels: () => [{ id: 'codearts/deepseek-v4-pro', channelId: 'codearts', name: 'DSV4' }],
    send: async () => [],
  })
  const cat = buildModelCatalog(a)
  assert.equal(cat.groups.length, 1)
  assert.equal(cat.items.length, 2, '2 个模型 ⇒ 2 条（改造前会是 2 × 22 = 44 条）')
  assert.equal(new Set(cat.items.map((m) => m.id)).size, 2)
})

// ══════════════════════════════════════════════════════════════════════════
// ③ 路由不退化：别名照样能选中/发请求
// ══════════════════════════════════════════════════════════════════════════

test('③ 别名仍能 resolveModel（不受「不声明模型」影响）', () => {
  const a = mk({ builtin: [{ provider: 'codearts', model: 'deepseek-v4.1-flash', tier: 1 }] })
  const r = a.resolveModel('codearts', 'deepseek-v4.1-flash')
  assert.ok(r, '别名必须能 resolveModel（NO_ADAPTER 的修复不能丢）')
  assert.equal(r.provider, 'codearts')
  assert.equal(r.id, 'deepseek-v4.1-flash')
  assert.deepEqual(a.listModels('codearts'), [], '同一时刻它不对外声明模型')
})

test('③ 别名仍能 prepareCall + 真正发出请求', async () => {
  const sent = []
  const a = mk({
    builtin: [{ provider: 'kilo', model: 'kilo-auto/free', tier: 1 }],
    directModel: (id) => {
      const i = String(id).indexOf('/'); if (i <= 0) return null
      return { provider: String(id).slice(0, i), model: id, name: id, channelModel: true }
    },
    send: async ({ provider, model }) => {
      sent.push(`${provider}/${model}`)
      return (async function* () { yield { type: 'text-delta', text: 'ok' } })()
    },
  })
  const pc = await a.prepareCall('codearts', 'codearts/deepseek-v4-pro')
  assert.equal(pc.model?.id, 'codearts/deepseek-v4-pro', 'prepareCall 必须如实解析用户选的模型')
  await collect(pc.stream({ provider: 'codearts', model: 'codearts/deepseek-v4-pro', messages: [] }))
  assert.deepEqual(sent, ['codearts/codearts/deepseek-v4-pro'], '按别名发请求必须照常走到渠道')
})

// ══════════════════════════════════════════════════════════════════════════
// ④ 故障切换不退化（主任要求：模拟某渠道挂掉，链路仍能切到下一个）
// ══════════════════════════════════════════════════════════════════════════

test('⭐ ④ 链首渠道挂掉 ⇒ 自动切到下一个渠道（fallback 未退化）', async () => {
  const sent = []
  const a = mk({
    send: async ({ provider, model }) => {
      sent.push(provider)
      if (provider === 'kilo') throw Object.assign(new Error('HTTP 503'), { status: 503 })
      return (async function* () { yield { type: 'text-delta', text: '来自备用渠道' } })()
    },
  })
  const out = await collect(a.stream({ provider: PROVIDER_ID, model: 'kilo-auto/free', messages: [] }))

  assert.ok(sent.includes('ovh') || sent.includes('pollinations'), '必须尝试过备用渠道')
  assert.notEqual(sent.at(-1), 'kilo', '最终不应停在挂掉的渠道上')
  assert.equal(textOf(out), '来自备用渠道')
  // 选择器只列 1 组，但路由层仍然有多渠道可切 —— 这正是方案①的关键不变式
  assert.equal(buildModelCatalog(a).groups.length, 1)
})

test('④ 用户钉选的渠道模型挂掉 ⇒ 仍能降级到链里其它渠道', async () => {
  const sent = []
  const a = mk({
    builtin: [
      { provider: 'kilo', model: 'kilo-auto/free', tier: 1 },
      { provider: 'ovh', model: 'Qwen3.5-397B-A17B', tier: 2 },
    ],
    directModel: (id) => {
      const i = String(id).indexOf('/'); if (i <= 0) return null
      return { provider: String(id).slice(0, i), model: id, name: id, channelModel: true }
    },
    send: async ({ provider }) => {
      sent.push(provider)
      if (provider === 'codearts') throw Object.assign(new Error('HTTP 503'), { status: 503 })
      return (async function* () { yield { type: 'text-delta', text: 'ok' } })()
    },
  })
  const out = await collect(a.stream({ provider: PROVIDER_ID, model: 'codearts/deepseek-v4-pro', messages: [] }))
  assert.equal(sent[0], 'codearts', '用户钉选的渠道必须第一个尝试')
  assert.ok(sent.slice(1).some((p) => p === 'kilo' || p === 'ovh'), '挂掉后必须切到链里其它渠道')
  assert.ok(out.some((c) => c.type === 'text-delta'), '最终要拿到答案')
})

test('④ 全部渠道都挂 ⇒ 如实报错（不静默成功）', async () => {
  const a = mk({ send: async () => { throw Object.assign(new Error('HTTP 503'), { status: 503 }) } })
  await assert.rejects(
    () => collect(a.stream({ provider: PROVIDER_ID, model: 'kilo-auto/free', messages: [] })),
    /全部可用模型失败/,
  )
})