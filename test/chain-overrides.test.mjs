/**
 * 链覆盖层测试（node --test，无需安装任何依赖）
 * 运行：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TIERS, isValidEntry, normalizeEntry, validateOverrides,
  mergeChain, groupByTier, chainSummary,
} from '../src/adapter/chain-overrides.js'

const BUILTIN = [
  { provider: 'codearts', model: 'deepseek-v4.1-flash', tier: 1 },
  { provider: 'workbuddy', model: 'deepseek-v4.1-flash', tier: 1 },
  { provider: 'buddy', model: 'deepseek-v4.1-flash', tier: 2 },
  { provider: 'kilo-free', model: 'kilo-auto/free', tier: 4 },
]

test('isValidEntry 拒绝空 provider/model', () => {
  assert.equal(isValidEntry({ provider: '', model: 'x' }), false)
  assert.equal(isValidEntry({ provider: 'a', model: '' }), false)
  assert.equal(isValidEntry(null), false)
  assert.equal(isValidEntry({ provider: 'a', model: 'm' }), true)
})

test('isValidEntry 拒绝非法 tier', () => {
  assert.equal(isValidEntry({ provider: 'a', model: 'm', tier: 9 }), false)
  assert.equal(isValidEntry({ provider: 'a', model: 'm', tier: 1 }), true)
})

test('normalizeEntry 只保留已知字段（防注入）', () => {
  const n = normalizeEntry({ provider: ' a ', model: ' m ', tier: 2, evil: 'x', paid: true })
  assert.equal(n.provider, 'a')
  assert.equal(n.model, 'm')
  assert.equal(n.tier, 2)
  assert.equal(n.paid, true)
  assert.equal('evil' in n, false, '未知字段必须被丢弃')
})

test('validateOverrides 拒绝非对象/缺 chain', () => {
  assert.equal(validateOverrides(null).ok, false)
  assert.equal(validateOverrides({}).ok, false)
  assert.equal(validateOverrides({ chain: 'x' }).ok, false)
})

test('validateOverrides 去重并报错', () => {
  const r = validateOverrides({ chain: [
    { provider: 'a', model: 'm', tier: 1 },
    { provider: 'a', model: 'm', tier: 2 },
  ]})
  assert.equal(r.ok, false)
  assert.equal(r.entries.length, 1, '重复条目只保留一条')
  assert.ok(r.errors.some((e) => e.includes('重复')))
})

test('mergeChain：同键替换 tier（保留原位置）', () => {
  const out = mergeChain(BUILTIN, [{ provider: 'buddy', model: 'deepseek-v4.1-flash', tier: 1 }])
  const buddy = out.filter((e) => e.provider === 'buddy')
  assert.equal(buddy.length, 1, '不能产生重复')
  assert.equal(buddy[0].tier, 1, 'tier 被覆盖')
})

test('mergeChain：新键追加到对应 tier', () => {
  const out = mergeChain(BUILTIN, [{ provider: 'loomy', model: 'deepseek-v4-flash-0731', tier: 1 }])
  assert.ok(out.some((e) => e.provider === 'loomy'), '新条目应在结果里')
  const t1 = out.filter((e) => e.tier === 1)
  assert.equal(t1[t1.length - 1].provider, 'loomy', '应追加到 tier1 末尾')
})

test('mergeChain：结果按 tier 升序、同 tier 稳定', () => {
  const out = mergeChain(BUILTIN, [])
  const tiers = out.map((e) => e.tier)
  assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b), '必须按 tier 升序')
  assert.equal(out[0].provider, 'codearts', '同 tier 保持原顺序')
  assert.equal(out[1].provider, 'workbuddy')
})

test('mergeChain：空 overrides 等价于 builtin', () => {
  const out = mergeChain(BUILTIN, [])
  assert.equal(out.length, BUILTIN.length)
})

test('groupByTier 与 chainSummary 一致性（铁律2：显示==实际）', () => {
  const out = mergeChain(BUILTIN, [{ provider: 'loomy', model: 'x', tier: 3 }])
  const g = groupByTier(out)
  const s = chainSummary(out)
  assert.equal(g.length, s.length)
  for (let i = 0; i < g.length; i++) {
    assert.equal(g[i][0], s[i].tier, 'tier 必须一致')
    assert.equal(g[i][1].length, s[i].count, 'count 必须一致')
  }
})

test('TIERS 是 1..5', () => {
  assert.deepEqual([...TIERS], [1, 2, 3, 4, 5])
})
