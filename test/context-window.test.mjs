/**
 * cs-myfree — contextWindow 上报测试
 *
 * 🔴 真实缺陷（2026-11-04 用户实测「工作总是中断」的根因）：
 *    链路条目从未设置 contextWindow ⇒ makeModelInfo 拿不到 ⇒ 宿主**不知道
 *    模型容量** ⇒ **不触发自动压缩** ⇒ 会话上下文无限增长。
 *
 *    实测证据：codearts 的 input token 从 66 万持续增长到 66.7 万，
 *    240/407 次调用超过 500k，且只增不减 ⇒ 必然撞上游硬限中断。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAdapter } from '../src/adapter/index.js'

const mkAdapter = (builtin) => createAdapter({
  builtin,
  send: async () => (async function* () {
    yield { type: 'text-delta', text: 'x' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })(),
})

test('🔴 每个模型都必须上报 contextWindow（否则宿主不会压缩）', () => {
  const a = mkAdapter([
    { provider: 'codearts', model: 'codearts/deepseek-v4.1-flash', tier: 1 },
    { provider: 'kilo', model: 'kilo-auto/free', tier: 2 },
    { provider: 'ovh', model: 'Qwen3.5-397B-A17B', tier: 3 },
  ])
  for (const m of a.listModels('cs-myfree')) {
    assert.ok(m.context && Number.isInteger(m.context.contextWindow),
      `${m.id} 缺 contextWindow ⇒ 宿主不会压缩`)
    assert.ok(m.context.contextWindow > 0)
  }
})

test('codearts 报保守值（标称 1M 但实测 60 万+ 不稳 ⇒ 256k）', () => {
  const a = mkAdapter([{ provider: 'codearts', model: 'codearts/deepseek-v4.1-flash', tier: 1 }])
  const m = a.listModels('cs-myfree')[0]
  assert.equal(m.context.contextWindow, 262_144)
  assert.ok(m.context.contextWindow < 600_000, '必须小于实测出问题的 60 万')
})

test('免密源报较小值（实测上下文有限）', () => {
  const a = mkAdapter([
    { provider: 'kilo', model: 'kilo-auto/free', tier: 1 },
    { provider: 'ovh', model: 'Qwen3.5-397B-A17B', tier: 2 },
  ])
  const byId = Object.fromEntries(a.listModels('cs-myfree').map((m) => [m.id, m]))
  assert.equal(byId['kilo-auto/free'].context.contextWindow, 65_536)
  assert.equal(byId['Qwen3.5-397B-A17B'].context.contextWindow, 32_768)
})

test('条目显式 contextWindow 优先于渠道默认', () => {
  const a = mkAdapter([{ provider: 'codearts', model: 'm', tier: 1, contextWindow: 128_000 }])
  assert.equal(a.listModels('cs-myfree')[0].context.contextWindow, 128_000)
})

test('未知渠道走兜底值（不是 undefined）', () => {
  const a = mkAdapter([{ provider: 'some-new-channel', model: 'm', tier: 1 }])
  const m = a.listModels('cs-myfree')[0]
  assert.ok(m.context && m.context.contextWindow > 0, '未知渠道也要给兜底 contextWindow')
})

test('resolveModel 与 listModels 的 contextWindow 一致（否则压缩判定会漂移）', () => {
  const a = mkAdapter([{ provider: 'codearts', model: 'm', tier: 1 }])
  const listed = a.listModels('cs-myfree')[0]
  const resolved = a.resolveModel('cs-myfree', 'm')
  assert.deepEqual(resolved.context, listed.context)
})

test('别名渠道（kilo-free）也认得 contextWindow', () => {
  const a = mkAdapter([{ provider: 'kilo-free', model: 'kilo-auto/free', tier: 1 }])
  const m = a.listModels('cs-myfree')[0]
  assert.equal(m.context.contextWindow, 65_536, 'kilo-free 应映射到 kilo 的默认值')
})
