import { test } from 'node:test'
import assert from 'node:assert/strict'
import { providerRetryPolicy, assertFlatPolicy, RETRYABLE_CODES } from '../src/adapter/policy.js'

test('默认 maxRetries 是 1（不是宿主的 5）', () => {
  assert.equal(providerRetryPolicy().maxRetries, 1)
})

test('retryableCodes 刻意排除 RATE_LIMIT', () => {
  assert.equal(providerRetryPolicy().retryableCodes.includes('RATE_LIMIT'), false)
  assert.deepEqual([...RETRYABLE_CODES], ['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
})

test('策略是扁平的（无嵌套 backoff）', () => {
  const p = providerRetryPolicy()
  assert.equal('backoff' in p, false)
  assert.equal(typeof p.initialDelayMs, 'number')
  assert.equal(typeof p.maxDelayMs, 'number')
  assert.equal(typeof p.jitterRatio, 'number')
})

test('assertFlatPolicy 能抓出嵌套写法（防回归）', () => {
  const bad = { mode: 'normal', maxRetries: 1, retryableCodes: [], backoff: { initialDelayMs: 1 } }
  const r = assertFlatPolicy(bad)
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((x) => x.includes('backoff')))
})

test('assertFlatPolicy 能抓出含 RATE_LIMIT 的写法', () => {
  const bad = { maxRetries: 1, retryableCodes: ['RATE_LIMIT'], initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0.1 }
  const r = assertFlatPolicy(bad)
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((x) => x.includes('RATE_LIMIT')))
})

test('默认策略本身通过断言', () => {
  assert.equal(assertFlatPolicy(providerRetryPolicy()).ok, true)
})

test('可覆盖但不可破坏扁平性', () => {
  const p = providerRetryPolicy({ maxRetries: 0 })
  assert.equal(p.maxRetries, 0)
  assert.equal(assertFlatPolicy(p).ok, true)
})
