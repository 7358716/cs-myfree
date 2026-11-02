import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_BUDGET, nextLayerFor, commitsAnswer, createHeld, createLadder,
} from '../src/adapter/ladder.js'
import { KIND } from '../src/adapter/failure-map.js'

// ── 提交点 ──
test('提交点：reasoning-delta 不算提交（最关键）', () => {
  assert.equal(commitsAnswer({ type: 'reasoning-delta', text: '想了很久' }), false)
})

test('提交点：text-delta 有内容才算提交', () => {
  assert.equal(commitsAnswer({ type: 'text-delta', text: 'Hello' }), true)
  assert.equal(commitsAnswer({ type: 'text-delta', text: '' }), false)
})

test('提交点：tool-call 算提交', () => {
  assert.equal(commitsAnswer({ type: 'tool-call' }), true)
})

test('held：reasoning 攒着不放行', () => {
  const h = createHeld()
  const r1 = h.push({ type: 'reasoning-delta', text: 'a' })
  assert.equal(r1.committed, false)
  assert.equal(h.size, 1, 'reasoning 应被缓存')
})

test('held：遇到 text-delta 时把之前的 reasoning 一起放行', () => {
  const h = createHeld()
  h.push({ type: 'reasoning-delta', text: 'a' })
  const r = h.push({ type: 'text-delta', text: 'Hi' })
  assert.equal(r.committed, true)
  assert.equal(r.released.length, 2, 'reasoning + text 一起放行')
  assert.equal(h.isCommitted, true)
})

test('held：提交后不再缓存', () => {
  const h = createHeld()
  h.push({ type: 'text-delta', text: 'A' })
  const r = h.push({ type: 'text-delta', text: 'B' })
  assert.equal(r.chunk.text, 'B', '提交后直接透传')
})

test('held：失败可整段丢弃（用户零感知）', () => {
  const h = createHeld()
  h.push({ type: 'reasoning-delta', text: 'a' })
  assert.equal(h.discard().discarded, true)
  assert.equal(h.size, 0)
})

// ── 层映射 ──
test('层映射：瞬态 ⇒ L0', () => {
  assert.equal(nextLayerFor(KIND.SERVER), 0)
  assert.equal(nextLayerFor(KIND.TRANSPORT), 0)
})

test('层映射：额度/限流/鉴权 ⇒ L1（换号）', () => {
  assert.equal(nextLayerFor(KIND.QUOTA), 1)
  assert.equal(nextLayerFor(KIND.RATE_LIMIT), 1)
  assert.equal(nextLayerFor(KIND.AUTH), 1)
})

test('层映射：区域/权限 ⇒ L2（换渠道）', () => {
  assert.equal(nextLayerFor(KIND.REGION_BLOCKED), 2)
  assert.equal(nextLayerFor(KIND.PERMISSION), 2)
})

test('层映射：模型不存在 ⇒ L3', () => {
  assert.equal(nextLayerFor(KIND.MODEL_NOT_FOUND), 3)
})

test('层映射：无法归类 ⇒ L5（上报）', () => {
  assert.equal(nextLayerFor(KIND.UNKNOWN), 5)
})

// ── 状态机 ──
test('预算：超过 maxAttempts 即耗尽', () => {
  const L = createLadder({ maxAttempts: 2 }).begin(1000)
  L.countAttempt(); L.countAttempt()
  assert.equal(L.exhausted(1000), true)
})

test('预算：超过 maxElapsed 即耗尽', () => {
  const L = createLadder({ maxElapsedMs: 1000 }).begin(0)
  assert.equal(L.exhausted(999), false)
  assert.equal(L.exhausted(1000), true)
})

test('瞬态失败先原地重试，超过上限则换渠道', () => {
  const L = createLadder({ retryPerRoute: 2 }).begin(0)
  const v = { kind: KIND.SERVER }
  assert.equal(L.onFailure(v, { provider: 'a', model: 'm' }, 1).action, 'retry')
  assert.equal(L.onFailure(v, { provider: 'a', model: 'm' }, 2).action, 'retry')
  const r = L.onFailure(v, { provider: 'a', model: 'm' }, 3)
  assert.equal(r.action, 'swap-channel', '第 3 次应升层')
})

test('额度失败直接换号（不浪费重试）', () => {
  const L = createLadder().begin(0)
  const r = L.onFailure({ kind: KIND.QUOTA }, { provider: 'a', model: 'm' }, 1)
  assert.equal(r.layer, 1)
  assert.equal(r.action, 'swap-account')
})

test('区域失败换渠道', () => {
  const L = createLadder().begin(0)
  const r = L.onFailure({ kind: KIND.REGION_BLOCKED }, { provider: 'a', model: 'm' }, 1)
  assert.equal(r.action, 'swap-channel')
})

test('换渠道达上限后升到换模型', () => {
  const L = createLadder({ swapChannelMax: 2 }).begin(0)
  L.onFailure({ kind: KIND.REGION_BLOCKED }, { provider: 'a', model: 'm' }, 1)
  L.onFailure({ kind: KIND.REGION_BLOCKED }, { provider: 'b', model: 'm' }, 2)
  const r = L.onFailure({ kind: KIND.REGION_BLOCKED }, { provider: 'c', model: 'm' }, 3)
  assert.equal(r.layer, 3)
  assert.equal(r.action, 'swap-model')
})

test('付费档不允许自动降档（v3 L4 硬约束）', () => {
  const L = createLadder()
  assert.equal(L.canDowngrade({ paid: true }), false, '付费档必须人工确认')
  assert.equal(L.canDowngrade({ paid: false }), true)
})

test('未知失败直接上报', () => {
  const L = createLadder().begin(0)
  const r = L.onFailure({ kind: KIND.UNKNOWN }, { provider: 'a', model: 'm' }, 1)
  assert.equal(r.action, 'report')
})

test('DEFAULT_BUDGET 与 v3 一致', () => {
  assert.equal(DEFAULT_BUDGET.maxAttempts, 18)
  assert.equal(DEFAULT_BUDGET.maxElapsedMs, 120000)
})
