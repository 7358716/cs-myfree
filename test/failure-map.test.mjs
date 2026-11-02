import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, KIND, TERMINAL, TTL_MS } from '../src/adapter/failure-map.js'

test('文本规则优先于状态码', () => {
  // 503 但消息说 quota ⇒ 判 QUOTA 不是 SERVER
  assert.equal(classify({ status: 503, message: 'insufficient quota' }).kind, KIND.QUOTA)
})

test('5xx 的 reason phrase 不得导致误判', () => {
  // 反向代理对 503 的 reason phrase 就是 Service Unavailable
  assert.equal(classify({ status: 503, message: 'Service Unavailable' }).kind, KIND.SERVER)
})

test('429 ⇒ RATE_LIMIT 且 ttl 10 分钟', () => {
  const r = classify({ status: 429, message: 'too many requests' })
  assert.equal(r.kind, KIND.RATE_LIMIT)
  assert.equal(r.ttlMs, 10 * 60 * 1000)
})

test('QUOTA 的 ttl 是 45 分钟（不是 6 小时）', () => {
  assert.equal(classify({ message: '额度不足' }).ttlMs, 45 * 60 * 1000)
})

test('终态码 retryable=false', () => {
  for (const k of [KIND.AUTH, KIND.MODEL_NOT_FOUND, KIND.REGION_BLOCKED]) {
    assert.equal(TERMINAL.includes(k), true)
  }
  assert.equal(classify({ status: 401 }).retryable, false)
})

test('瞬态码 retryable=true', () => {
  assert.equal(classify({ status: 500 }).retryable, true)
  assert.equal(classify({ code: 'ECONNRESET' }).retryable, true)
  assert.equal(classify({ code: 'ETIMEDOUT' }).retryable, true)
})

test('未知错误归 UNKNOWN 但仍有 TTL', () => {
  const r = classify({ message: 'weird thing' })
  assert.equal(r.kind, KIND.UNKNOWN)
  assert.equal(r.ttlMs, 6 * 3600 * 1000)
})

test('cause 链里的传输码能被识别', () => {
  assert.equal(classify({ message: 'fetch failed', cause: { code: 'ENOTFOUND' } }).kind, KIND.TRANSPORT)
})

test('中文错误也能识别', () => {
  assert.equal(classify({ message: '登录已失效' }).kind, KIND.AUTH)
  assert.equal(classify({ message: '无权访问' }).kind, KIND.PERMISSION)
})
