/**
 * P1 + P2 修复回归测试
 *
 * P1: 渠道名别名注册（NO_ADAPTER 根因）
 * P2: agent/request-error 瀑布处理器
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAdapter, providerAliases, PROVIDER_ID } from '../src/adapter/index.js'
import { handleRequestError, installRequestErrorHandler, RETRYABLE_KINDS } from '../src/adapter/request-error.js'
import { classify, KIND } from '../src/adapter/failure-map.js'
import { safeRegisterAdapter } from '../src/compat.js'

// ───────────────────────────── P1: 渠道名别名 ─────────────────────────────

test('P1: providerAliases() 返回渠道名数组', () => {
  const aliases = providerAliases()
  assert.ok(Array.isArray(aliases))
  assert.ok(aliases.length >= 5, '至少有 5 个渠道名')
  assert.ok(aliases.includes('codearts'))
  assert.ok(aliases.includes('loomy'))
  assert.ok(!aliases.includes(PROVIDER_ID), '不包含 cs-myfree 自身')
})

test('P1: providerInfo 接受渠道名别名', () => {
  const a = createAdapter({ builtin: [{ provider: 'codearts', model: 'm', tier: 1 }], send: async () => [] })
  const info = a.providerInfo('codearts')
  assert.ok(info, '渠道名别名必须返回 providerInfo')
  assert.equal(info.id, 'codearts')
})

test('P1: providerRetryPolicy 接受渠道名别名', () => {
  const a = createAdapter({ builtin: [{ provider: 'codearts', model: 'm', tier: 1 }], send: async () => [] })
  const p = a.providerRetryPolicy('codearts')
  assert.ok(p, '渠道名别名必须返回 retryPolicy')
  assert.equal(p.maxRetries, 1)
})

test('P1: listModels 接受渠道名别名', () => {
  const a = createAdapter({ builtin: [{ provider: 'codearts', model: 'deepseek-v4.1-flash', tier: 1 }], send: async () => [] })
  const models = a.listModels('codearts')
  assert.ok(models.length > 0, '渠道名别名必须返回模型列表')
  assert.equal(models[0].provider, 'codearts')
})

test('P1: resolveModel 接受渠道名别名', () => {
  const a = createAdapter({ builtin: [{ provider: 'codearts', model: 'deepseek-v4.1-flash', tier: 1 }], send: async () => [] })
  const r = a.resolveModel('codearts', 'deepseek-v4.1-flash')
  assert.ok(r, '渠道名别名必须能 resolveModel')
  assert.equal(r.provider, 'codearts')
  assert.equal(r.id, 'deepseek-v4.1-flash')
})

test('P1: 非别名 provider 仍返回 undefined', () => {
  const a = createAdapter({ builtin: [{ provider: 'x', model: 'm', tier: 1 }], send: async () => [] })
  assert.equal(a.providerInfo('nonexistent'), undefined)
  assert.equal(a.providerRetryPolicy('nonexistent'), undefined)
  assert.deepEqual(a.listModels('nonexistent'), [])
  assert.equal(a.resolveModel('nonexistent', 'm'), undefined)
})

test('P1: 渠道名注册后自检通过', () => {
  const aliases = providerAliases()
  const a = createAdapter({ builtin: [{ provider: 'codearts', model: 'm', tier: 1 }], send: async () => [] })
  // 自检使用 PROVIDER_ID，但渠道名别名也应该通过
  for (const alias of aliases) {
    const pi = a.providerInfo(alias)
    assert.ok(pi, `渠道名 ${alias} 的 providerInfo 不能是 undefined`)
    assert.equal(pi.id, alias)
  }
})

// ───────────────────────────── P2: request-error 瀑布 ─────────────────────────────

test('P2: TRANSPORT 错误返回 retry', async () => {
  const onEvent = () => {}
  const result = await handleRequestError(
    { failure: { code: 'ENOTFOUND', message: 'DNS 解析失败' }, provider: 'codearts' },
    () => 'next',
    { onEvent }
  )
  assert.deepEqual(result, { kind: 'retry' })
})

test('P2: TIMEOUT 错误返回 retry', async () => {
  const result = await handleRequestError(
    { failure: { code: 'ETIMEDOUT', message: '请求超时' }, provider: 'loomy' },
    () => 'next'
  )
  assert.deepEqual(result, { kind: 'retry' })
})

test('P2: SERVER (5xx) 错误返回 retry', async () => {
  const result = await handleRequestError(
    { failure: { code: 'INTERNAL', message: '上游 500', status: 500 }, provider: 'kilo' },
    () => 'next'
  )
  assert.deepEqual(result, { kind: 'retry' })
})

test('P2: EMPTY_RESPONSE 错误返回 retry', async () => {
  const result = await handleRequestError(
    { failure: { code: 'EMPTY_RESPONSE', message: '空响应' }, provider: 'ovh' },
    () => 'next'
  )
  assert.deepEqual(result, { kind: 'retry' })
})

test('P2: AUTH 错误不重试（交回宿主）', async () => {
  const result = await handleRequestError(
    { failure: { code: 'AUTH', message: '401 invalid token', status: 401 }, provider: 'codearts' },
    () => 'next'
  )
  assert.equal(result, 'next')
})

test('P2: QUOTA 错误不重试（交回宿主）', async () => {
  const result = await handleRequestError(
    { failure: { code: 'QUOTA', message: '额度用尽' }, provider: 'workbuddy' },
    () => 'next'
  )
  assert.equal(result, 'next')
})

test('P2: INVALID_REQUEST 错误不重试（交回宿主）', async () => {
  const result = await handleRequestError(
    { failure: { code: 'INVALID_REQUEST', message: 'HTTP 400', status: 400 }, provider: 'buddy' },
    () => 'next'
  )
  assert.equal(result, 'next')
})

test('P2: UNKNOWN 码走文本兜底（fetch failed → TRANSPORT）', async () => {
  const events = []
  const result = await handleRequestError(
    { failure: { code: 'UNKNOWN', message: 'fetch failed' }, provider: 'kilo' },
    () => 'next',
    { onEvent: (e) => events.push(e) }
  )
  assert.deepEqual(result, { kind: 'retry' }, 'fetch failed 应被分类为 TRANSPORT')
  assert.ok(events[0].kind === KIND.TRANSPORT)
  assert.ok(events[0].retryable === true)
})

test('P2: 分类事件可见性（onEvent 被调用）', async () => {
  const events = []
  await handleRequestError(
    { failure: { code: 'QUOTA', message: '额度用尽' }, provider: 'codearts' },
    () => 'next',
    { onEvent: (e) => events.push(e) }
  )
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'request-error-classified')
  assert.equal(events[0].provider, 'codearts')
  assert.equal(events[0].failureCode, 'QUOTA')
  assert.equal(events[0].kind, KIND.QUOTA)
  assert.equal(events[0].retryable, false)
})

test('P2: installRequestErrorHandler 幂等注册', () => {
  let registered = 0
  const ctx = {
    on: (name, fn) => {
      if (name === 'agent/request-error') { registered++; return () => {} }
      return () => {}
    },
  }
  const dispose = installRequestErrorHandler(ctx)
  assert.equal(registered, 1)
  // 再次调用不重复注册
  const dispose2 = installRequestErrorHandler(ctx)
  assert.equal(registered, 2, '两次调用各自注册（幂等由宿主 disposer 保证）')
  dispose?.()
  dispose2?.()
})

test('P2: installRequestErrorHandler 对无 on 方法安全跳过', () => {
  const dispose = installRequestErrorHandler({})
  assert.ok(dispose, '返回空函数')
  // 调用不抛错
  assert.doesNotThrow(() => dispose())
})

test('P2: RETRYABLE_KINDS 与 policy.js 一致', async () => {
  const { RETRYABLE_CODES } = await import('../src/adapter/policy.js')
  // policy 的可重试码对应的 failure-map kind 必须在 RETRYABLE_KINDS 里
  const codeToKind = {
    EMPTY_RESPONSE: KIND.EMPTY_RESPONSE,
    SERVER: KIND.SERVER,
    TIMEOUT: KIND.TIMEOUT,
    TRANSPORT: KIND.TRANSPORT,
  }
  for (const code of RETRYABLE_CODES) {
    const kind = codeToKind[code]
    assert.ok(kind, `code ${code} 必须有对应 kind`)
    assert.ok(RETRYABLE_KINDS.includes(kind), `${code} → ${kind} 必须在 RETRYABLE_KINDS 里`)
  }
})
