/**
 * cs-myfree — P0-④ 选定模型透传（directModel 装配）
 *
 * ⚠️ 本文件的存在理由需要说清楚（排查结论，2026-11-22）：
 *   任务描述说「用户选了渠道模型，实际发的是默认链」。**实测并非如此**：
 *   `src/index.js:644` 的 `directModel` 装配一直在，且 `resolveRequested()` 会把它
 *   接进 `candidatesFor()`（pinned 排第一），实测「选 codearts/deepseek-v4-pro ⇒
 *   上游收到 channel:codearts:deepseek-v4-pro」。`test/runtime-chain.test.mjs`
 *   也已经有一条覆盖同样语义的用例。
 *
 *   所以本文件**不是**为了修一个不存在的 bug，而是补上真正缺的那一块：
 *   现有测试里的 `directModel` 都是**各写一份 stub**（`(id) => id.startsWith(...) ? ... : null`），
 *   **没有一条测过 `src/index.js` 里那个真实的装配函数**。也就是说装配函数本身
 *   若被人改坏（返回形状、前缀解析、渠道名校验），全量测试仍然是绿的。
 *
 * 本文件锁死的契约：
 *   ① 真实装配函数：`<渠道>/<模型>` ⇒ `{ provider: 渠道, model: 原 id, channelModel: true }`；
 *   ② 非渠道前缀 ⇒ null（不可直连，回落到链）；
 *   ③ 选 X 模型 ⇒ 上游请求里的 model 就是 X（pinned 优先，不受 tier 影响）；
 *   ④ 选链内第 N 项 ⇒ 就发第 N 项（不是永远发链首）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAdapter } from '../src/adapter/index.js'
// 🔴 直接 import **生产实现** —— 这是本文件最重要的一点：
//    之前测试各自重写 stub，装配函数被改坏时全量测试仍然绿（已实测）。
import { directModelOf } from '../src/index.js'

async function collect(iter) { const out = []; for await (const c of iter) out.push(c); return out }
const textOf = (out) => out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')

function okSend(calls) {
  return async ({ provider, model }) => {
    calls.push({ provider, model })
    return (async function* () { yield { type: 'text-delta', text: 'ok' } })()
  }
}

/**
 * 生产实现本体：`src/index.js` 导出的 `directModelOf`。
 *
 * ⚠️ **绝不能在这里复制一份 stub**：复制出来的副本测的是副本自己，
 *    生产实现被改坏时测试照样全绿（本文件第一版就是这么写的，注入变异后
 *    只有防漂移那条红了 7 条绿 —— 说明前 6 条根本没测到生产代码）。
 */
const realDirectModel = directModelOf

// ══════════════════════════════════════════════════════════════════════════
// ① / ② 装配函数本身的形状
// ══════════════════════════════════════════════════════════════════════════

test('① 真实装配：<渠道>/<模型> 解析成直连候选', () => {
  const d = realDirectModel('codearts/deepseek-v4-pro')
  assert.deepEqual(d, {
    provider: 'codearts',
    model: 'codearts/deepseek-v4-pro',   // 原样保留带前缀的 id（send 负责再解析）
    name: 'codearts/deepseek-v4-pro',
    channelModel: true,
  }, '必须带 channelModel:true，否则 send 不会按渠道分发')
})

test('② 非渠道前缀 / 裸模型名 ⇒ null（不可直连，回落链）', () => {
  for (const bad of ['kilo-auto/free', 'Qwen3.5-397B-A17B', '', null, undefined, 'unknownchannel/x']) {
    // ⚠️ 'kilo-auto/free' 的 prefix 不是注册渠道 ⇒ parseModelId 返回 null ⇒ 不可直连（它在链里）
    assert.equal(realDirectModel(bad), null, `${JSON.stringify(bad)} 不应被当成直连目标`)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// ③ 核心：选 X ⇒ 请求里的 model 就是 X
// ══════════════════════════════════════════════════════════════════════════

test('⭐ 核心：选 codearts/deepseek-v4-pro ⇒ 请求里的 model 就是 codearts/deepseek-v4-pro', async () => {
  const calls = []
  const adapter = createAdapter({
    // 注意：链里**没有**这个渠道模型 —— 完全靠 directModel 直连
    builtin: [
      { provider: 'kilo', model: 'kilo-auto/free', tier: 1 },
      { provider: 'ovh', model: 'Qwen3.5-397B-A17B', tier: 1 },
    ],
    directModel: realDirectModel,
    send: okSend(calls),
  })
  const out = await collect(adapter.stream({
    provider: 'cs-myfree', model: 'codearts/deepseek-v4-pro', messages: [],
  }))

  assert.equal(calls.length, 1, '直连命中就不该再去试链里的默认候选')
  assert.equal(calls[0].provider, 'codearts', '必须发到用户选的渠道')
  assert.equal(calls[0].model, 'codearts/deepseek-v4-pro', '🔴 请求里的 model 必须就是用户选的那个')
  assert.equal(textOf(out), 'ok')
})

test('③ 选 X 时**不会**发成默认链首项（回归本体）', async () => {
  const calls = []
  const adapter = createAdapter({
    builtin: [{ provider: 'kilo', model: 'kilo-auto/free', tier: 1 }],
    directModel: realDirectModel,
    send: okSend(calls),
  })
  await collect(adapter.stream({ provider: 'cs-myfree', model: 'codearts/deepseek-v4-pro', messages: [] }))
  assert.notEqual(calls[0].model, 'kilo-auto/free', '绝不能退回默认链首项')
  assert.equal(calls[0].provider, 'codearts')
})

test('④ 选链内第 N 项 ⇒ 就发第 N 项（不是永远发链首）', async () => {
  const calls = []
  const adapter = createAdapter({
    builtin: [
      { provider: 'kilo', model: 'kilo-auto/free', tier: 1 },
      { provider: 'ovh', model: 'Qwen3.5-397B-A17B', tier: 2 },
    ],
    directModel: realDirectModel,
    send: okSend(calls),
  })
  await collect(adapter.stream({ provider: 'cs-myfree', model: 'Qwen3.5-397B-A17B', messages: [] }))
  assert.equal(calls[0].provider, 'ovh', '按 model 精确命中，而不是按 tier 取第一项')
  assert.equal(calls[0].model, 'Qwen3.5-397B-A17B')
})

test('⑤ 选了一个真不存在的模型 ⇒ 回落到链（如实降级，不是静默成功）', async () => {
  const calls = []
  const adapter = createAdapter({
    builtin: [{ provider: 'kilo', model: 'kilo-auto/free', tier: 1 }],
    directModel: realDirectModel,
    send: okSend(calls),
  })
  await collect(adapter.stream({ provider: 'cs-myfree', model: 'nonexistent-model', messages: [] }))
  assert.equal(calls[0].provider, 'kilo', '不在链里也解析不了 ⇒ 用链里可用的候选')
})

test('⑥ 走 prepared call（宿主的真实调用形态）也照样透传', async () => {
  const calls = []
  const adapter = createAdapter({
    builtin: [{ provider: 'kilo', model: 'kilo-auto/free', tier: 1 }],
    directModel: realDirectModel,
    send: okSend(calls),
  })
  const pc = await adapter.prepareCall('cs-myfree', 'codearts/deepseek-v4-pro')
  assert.equal(pc.model.id, 'codearts/deepseek-v4-pro', 'prepareCall 就要如实解析出用户选的模型')
  // 宿主 dispatch 时把 resolvedConfig（含 provider/model）原样传给 stream
  await collect(pc.stream({ provider: 'cs-myfree', model: 'codearts/deepseek-v4-pro', messages: [] }))
  assert.equal(calls[0].model, 'codearts/deepseek-v4-pro')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑦ 防漂移：生产代码里的装配函数必须仍是这个样子
// ══════════════════════════════════════════════════════════════════════════

test('⑦ 生产装配点必须引用导出的 directModelOf（防止有人改回内联闭包 / 掏空实现）', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const here = dirname(fileURLToPath(import.meta.url))
  const src = await readFile(join(here, '..', 'src', 'index.js'), 'utf8')

  // ① 装配点：createAdapter({ ... directModel: directModelOf ... })
  const at = src.indexOf('directModel:')
  assert.ok(at > 0, 'src/index.js 必须仍然装配 directModel（这是本插件的直连能力来源）')
  assert.match(src.slice(at, at + 200), /directModel:\s*directModelOf/,
    '装配点必须引用导出的 directModelOf（内联闭包会导致测试测不到生产实现）')

  // ② 函数本体：解析 + channelModel:true + 失败返回 null
  const fAt = src.indexOf('export function directModelOf')
  assert.ok(fAt > 0, 'directModelOf 必须保持导出（否则测试只能退回测 stub）')
  const body = src.slice(fAt, fAt + 400)
  assert.match(body, /parseModelId\(id\)/, '必须用 parseModelId 做渠道前缀解析')
  assert.match(body, /channelModel:\s*true/, '返回形状必须带 channelModel:true')
  assert.match(body, /provider:\s*p\.channelId/, 'provider 必须是解析出来的渠道 id')
  assert.match(body, /:\s*null/, '解析失败必须返回 null（回落链）')
})
