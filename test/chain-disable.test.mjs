/**
 * cs-myfree — 降级链「禁用/删除」语义 + 失败统计 + 中断提示测试
 *
 * 🐛 用户实测反馈（2026-11-03）：
 *   「kilo / ovh 在降级链中无法删除」—— 根因：mergeChain 的注释写了
 *   「overrides 显式 disabled:true 的 → 从 builtin 中剔除」，但**实现里没有**。
 *   用户只从覆盖层删掉条目，内置链里的同一条又原样回来，看起来「删不掉」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeChain, validateOverrides, chainSummary, normalizeEntry,
} from '../src/adapter/chain-overrides.js'
import { explainKind, KIND_HINTS, classify } from '../src/adapter/failure-map.js'

const BUILTIN = [
  { provider: 'kilo', model: 'kilo-auto/free', tier: 1 },
  { provider: 'ovh', model: 'Qwen3.5-397B-A17B', tier: 1 },
]

// ── disabled 语义 ──
test('🔴 disabled:true ⇒ 从生效链剔除（此前注释有、实现没有）', () => {
  const eff = mergeChain(BUILTIN, [{ provider: 'kilo', model: 'kilo-auto/free', disabled: true }])
  const keys = eff.map((e) => `${e.provider}/${e.model}`)
  assert.equal(keys.includes('kilo/kilo-auto/free'), false, '禁用后不得出现在生效链')
  assert.deepEqual(keys, ['ovh/Qwen3.5-397B-A17B'])
})

test('两条都禁用 ⇒ 生效链为空（页面应提示「空 ⇒ 必失败」）', () => {
  const eff = mergeChain(BUILTIN, [
    { provider: 'kilo', model: 'kilo-auto/free', disabled: true },
    { provider: 'ovh', model: 'Qwen3.5-397B-A17B', disabled: true },
  ])
  assert.equal(eff.length, 0)
})

test('禁用一条后，同 key 的普通覆盖也应被禁用覆盖（禁用优先）', () => {
  const eff = mergeChain(BUILTIN, [
    { provider: 'kilo', model: 'kilo-auto/free', disabled: true },
    { provider: 'kilo', model: 'kilo-auto/free', tier: 2 },
  ])
  // validateOverrides 会去重（同 key 只留第一条）；这里直接测 merge 的语义
  assert.equal(eff.some((e) => e.provider === 'kilo'), false)
})

test('禁用的条目不会作为「新条目」被追加', () => {
  const eff = mergeChain(BUILTIN, [{ provider: 'newprov', model: 'm', disabled: true }])
  assert.equal(eff.some((e) => e.provider === 'newprov'), false)
})

test('normalizeEntry 保留 disabled 标记', () => {
  const n = normalizeEntry({ provider: 'a', model: 'b', disabled: true })
  assert.equal(n.disabled, true)
  assert.equal(normalizeEntry({ provider: 'a', model: 'b' }).disabled, undefined)
})

test('validateOverrides 接受 disabled 条目（provider/model 必填即可）', () => {
  const v = validateOverrides({ chain: [{ provider: 'kilo', model: 'kilo-auto/free', disabled: true }] })
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  assert.equal(v.entries[0].disabled, true)
})

test('禁用 + 新增 混用：禁用的剔掉，新增的加上', () => {
  const eff = mergeChain(BUILTIN, [
    { provider: 'kilo', model: 'kilo-auto/free', disabled: true },
    { provider: 'codearts', model: 'deepseek-v4.1-flash', tier: 1 },
  ])
  const keys = eff.map((e) => `${e.provider}/${e.model}`)
  assert.deepEqual(keys.sort(), ['codearts/deepseek-v4.1-flash', 'ovh/Qwen3.5-397B-A17B'])
})

// ── 失败提示明确性 ──
test('每种失败类型都有中文人话说明与建议', () => {
  for (const kind of Object.keys(KIND_HINTS)) {
    const s = explainKind(kind)
    assert.ok(s.includes('—'), `${kind} 缺人话说明`)
    assert.ok(s.includes('建议'), `${kind} 缺可操作建议`)
    assert.ok(/[\u4e00-\u9fa5]/.test(s), `${kind} 说明必须是中文`)
  }
})

test('explainKind 对未知类型不炸（回退机器码）', () => {
  assert.equal(explainKind('SOMETHING_NEW'), 'SOMETHING_NEW')
  assert.equal(explainKind(undefined), 'UNKNOWN')
})

test('腾讯 11140 风控归到 PERMISSION（提示应说「被风控」）', () => {
  const v = classify({ message: 'buddy HTTP 403: {"code":11140,"msg":"request illegal"}', status: 403 })
  assert.equal(v.kind, 'PERMISSION')
  assert.match(explainKind(v.kind), /风控/)
})

test('腾讯 11101 非流式不支持归到 INVALID_REQUEST（提示应说「请求参数被拒绝」）', () => {
  const v = classify({ message: 'HTTP 400: Non-stream chat request is currently not supported', status: 400 })
  assert.equal(v.kind, 'INVALID_REQUEST')
  assert.match(explainKind(v.kind), /请求参数/)
})

test('未登录 AUTH 的提示要直接指向「重新登录」', () => {
  const v = classify({ message: '该渠道未登录（无可用凭据）', status: 401 })
  assert.equal(v.kind, 'AUTH')
  assert.match(explainKind(v.kind), /重新登录/)
})

// ── chainSummary 与生效链同源 ──
test('chainSummary 反映禁用后的真实生效链（页面显示 == 实际选路）', () => {
  const eff = mergeChain(BUILTIN, [{ provider: 'kilo', model: 'kilo-auto/free', disabled: true }])
  const sum = chainSummary(eff)
  const providers = sum.flatMap((t) => t.providers)
  assert.equal(providers.includes('kilo'), false)
  assert.ok(providers.includes('ovh'))
})
