import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHANNELS, AUTH, REFRESH, LOGIN, channelById, checkinChannels, manualRefreshChannels, proxyRequiredChannels, WIRED_EXPIRY } from '../src/pools/channels/protocols.js'
import { buildAuthHeaders, joinUrl } from '../src/pools/channels/driver.js'
import { createPool, STATE } from '../src/pools/channels/pool.js'
import { isDue, toDateKey, summarize, nextRunAt } from '../src/pools/channels/checkin.js'

// ── 协议表 ──
test('18 个渠道全部注册', () => { assert.equal(Object.keys(CHANNELS).length, 18) })
test('每个渠道都有必需字段', () => {
  for (const [id, c] of Object.entries(CHANNELS)) {
    assert.ok(c.label, id); assert.ok(c.baseUrl, id); assert.ok(c.auth, id)
    assert.ok(c.login, id); assert.ok(c.refresh, id); assert.ok(c.credRef, id)
  }
})
test('Loomy 是唯一必须人工重登的', () => {
  assert.deepEqual(manualRefreshChannels(), ['loomy'])
  assert.equal(channelById('loomy').refresh, REFRESH.MANUAL)
})
test('Loomy 有 14 天 TTL', () => { assert.equal(channelById('loomy').sessionTtlSeconds, 1209600) })
test('只有 Gemini 需要代理', () => { assert.deepEqual(proxyRequiredChannels(), ['gemini']) })
test('签到渠道数为 11', () => { assert.equal(checkinChannels().length, 11) })
test('Loomy 支持签到，Gemini 不支持', () => {
  assert.equal(channelById('loomy').checkin.supported, true)
  assert.equal(channelById('gemini').checkin.supported, false)
})

// ── 鉴权头 ──
test('BEARER 正确构造', () => {
  const h = buildAuthHeaders({ auth: AUTH.BEARER }, { token: 'tk' })
  assert.equal(h.authorization, 'Bearer tk')
})
test('NONE 绝不设置 authorization（免密铁律）', () => {
  const h = buildAuthHeaders({ auth: AUTH.NONE }, { token: 'should-be-dropped' })
  assert.equal('authorization' in h, false)
})
test('CUSTOM_HEADER 支持 ak:sig 格式（Loomy）', () => {
  const ch = channelById('loomy')
  const h = buildAuthHeaders(ch, { ak: 'AK', sig: 'SIG' })
  assert.equal(h.authorization, 'account AK:SIG')
})
test('无凭据时不构造空头', () => {
  assert.equal('authorization' in buildAuthHeaders({ auth: AUTH.BEARER }, {}), false)
})
test('joinUrl 正确拼接', () => {
  assert.equal(joinUrl('https://a.com/', '/v1/x'), 'https://a.com/v1/x')
  assert.equal(joinUrl('https://a.com', 'v1/x'), 'https://a.com/v1/x')
})

// ── 号池 ──
const T0 = 1_000_000
test('upsert 与 list', () => {
  const p = createPool({ now: () => T0 })
  p.upsert({ id: 'a1', provider: 'codearts', balance: 100 })
  assert.equal(p.list('codearts').length, 1)
})
test('available 排除过期的', () => {
  const p = createPool({ now: () => T0 })
  p.upsert({ id: 'a1', provider: 'x', expiresAt: T0 - 1 })
  p.upsert({ id: 'a2', provider: 'x', expiresAt: T0 + 1000 })
  assert.equal(p.available('x', T0).length, 1)
})
test('available 排除冷却中的', () => {
  const p = createPool({ now: () => T0 })
  p.upsert({ id: 'a1', provider: 'x', cooldownUntil: T0 + 500 })
  assert.equal(p.available('x', T0).length, 0)
})
test('pick 按余额降序（先烧快过期的）', () => {
  const p = createPool({ now: () => T0 })
  p.upsert({ id: 'low', provider: 'x', balance: 10 })
  p.upsert({ id: 'high', provider: 'x', balance: 900 })
  assert.equal(p.pick('x', T0).id, 'high')
})
test('markFailure 进冷却', () => {
  const p = createPool({ now: () => T0 })
  p.upsert({ id: 'a1', provider: 'x' })
  p.markFailure('a1', { ttlMs: 60000, at: T0 })
  assert.equal(p.available('x', T0).length, 0)
  assert.equal(p.available('x', T0 + 60001).length, 1)
})
test('markSuccess 清冷却', () => {
  const p = createPool({ now: () => T0 })
  p.upsert({ id: 'a1', provider: 'x', cooldownUntil: T0 + 999 })
  p.markSuccess('a1')
  assert.equal(p.available('x', T0).length, 1)
})
test('summary 统计正确', () => {
  const p = createPool({ now: () => T0 })
  p.upsert({ id: 'a', provider: 'x', balance: 5 })
  p.upsert({ id: 'b', provider: 'x', expiresAt: T0 - 1 })
  p.upsert({ id: 'c', provider: 'x', enabled: false })
  const s = p.summary(T0).find((x) => x.provider === 'x')
  assert.equal(s.ready, 1); assert.equal(s.expired, 1); assert.equal(s.disabled, 1)
})
test('expiringWithin 找临期（Loomy）', () => {
  const p = createPool({ now: () => T0 })
  p.upsert({ id: 'a', provider: 'loomy', expiresAt: T0 + 3600_000 })
  assert.equal(p.expiringWithin(2 * 3600_000, T0).length, 1)
})

// ── 签到 ──
test('toDateKey 用本地时区', () => {
  const d = new Date(2026, 10, 2, 15, 0, 0)
  assert.equal(toDateKey(d), '2026-11-02')
})
test('今天跑过 ⇒ 不再跑', () => {
  const t = new Date(2026, 10, 2, 15, 0, 0).getTime()
  assert.equal(isDue({ lastDate: '2026-11-02' }, { now: () => t }).due, false)
})
test('未到点 ⇒ 不跑', () => {
  const t = new Date(2026, 10, 2, 8, 0, 0).getTime()
  assert.equal(isDue({}, { now: () => t }).due, false)
})
test('到点且未跑 ⇒ 跑', () => {
  const t = new Date(2026, 10, 2, 11, 0, 0).getTime()
  assert.equal(isDue({}, { now: () => t }).due, true)
})
test('记账口径：只认 coversToday（关键坑）', () => {
  const s = summarize([
    { provider: 'qoder', claimed: 5, alreadyClaimed: 3, coversToday: false },  // 上午那轮属于昨天
    { provider: 'codearts', claimed: 1, coversToday: true },
  ])
  assert.equal(s.covered, 1)
  assert.equal(s.pending, 1, 'coversToday=false 必须算待补')
  assert.equal(s.allCovered, false)
})
test('全部覆盖才算完成', () => {
  const s = summarize([{ provider: 'a', coversToday: true }, { provider: 'b', coversToday: true }])
  assert.equal(s.allCovered, true)
})
test('有欠账时 2 小时后重试', () => {
  const t = new Date(2026, 10, 2, 15, 0, 0).getTime()
  const n = nextRunAt({ pending: 1, lastDate: '2026-11-02' }, { now: () => t })
  assert.equal(n, t + 2 * 3600 * 1000)
})
