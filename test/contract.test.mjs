/**
 * 宿主契约测试 —— v1.1.1「myfree 完全不可用」的根因防回归
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeProviderInfo, makeModelInfo, checkProviderInfo, checkModelInfo } from '../src/adapter/contract.js'
import { createAdapter, PROVIDER_ID } from '../src/adapter/index.js'

test('makeProviderInfo 含 id 且等于 provider', () => {
  const p = makeProviderInfo('cs-myfree', { name: 'Myfree' })
  assert.equal(p.id, 'cs-myfree')
  assert.equal(checkProviderInfo(p, 'cs-myfree').ok, true)
})

test('makeModelInfo 含 provider / id / name', () => {
  const m = makeModelInfo('cs-myfree', { id: 'x', name: 'X' })
  assert.equal(m.provider, 'cs-myfree')
  assert.equal(m.id, 'x')
  assert.equal(checkModelInfo(m, 'cs-myfree', 'x').ok, true)
})

test('context 必须是嵌套对象', () => {
  const m = makeModelInfo('p', { id: 'x', contextWindow: 8000 })
  assert.equal(m.context.contextWindow, 8000)
  assert.equal(checkModelInfo(m, 'p', 'x').ok, true)
})

test('非法 contextWindow 被丢弃（不塞进契约）', () => {
  const m = makeModelInfo('p', { id: 'x', contextWindow: -1 })
  assert.equal(m.context, undefined)
})

test('checkModelInfo 能抓出 provider 不符', () => {
  const m = makeModelInfo('a', { id: 'x' })
  assert.equal(checkModelInfo(m, 'b', 'x').ok, false)
})

test('checkModelInfo 能抓出 id 不符', () => {
  const m = makeModelInfo('a', { id: 'x' })
  assert.equal(checkModelInfo(m, 'a', 'y').ok, false)
})

test('🔴 adapter.selfCheck 必须全绿（防 myfree 再次不可用）', () => {
  const a = createAdapter({
    builtin: [
      { provider: 'kilo-free', model: 'kilo-auto/free', tier: 1 },
      { provider: 'ovh', model: 'Qwen3.5-9B', tier: 2 },
    ],
    send: async () => [],
  })
  const sc = a.selfCheck()
  assert.equal(sc.ok, true, '契约问题：' + sc.problems.join('; '))
  assert.equal(sc.modelCount, 2)
})

test('🔴 registerAdapter 必须收到数组（字符串会被逐字符遍历）', async () => {
  const { safeRegisterAdapter } = await import('../src/compat.js')
  let received = null
  safeRegisterAdapter({ registerAdapter: (p) => { received = p } }, 'cs-myfree', {})
  assert.ok(Array.isArray(received), '必须转成数组')
  assert.deepEqual(received, ['cs-myfree'])
})

test('providerRetryPolicy 合规（扁平 + 排除 RATE_LIMIT）', () => {
  const a = createAdapter({ builtin: [{ provider: 'x', model: 'm', tier: 1 }], send: async () => [] })
  const p = a.providerRetryPolicy(PROVIDER_ID)
  assert.equal('backoff' in p, false)
  assert.equal(p.retryableCodes.includes('RATE_LIMIT'), false)
  assert.equal(p.maxRetries, 1)
})

test('prepareCall 的 model 合规', async () => {
  const a = createAdapter({ builtin: [{ provider: 'x', model: 'm', tier: 1 }], send: async () => [] })
  const pc = await a.prepareCall(PROVIDER_ID, 'm')
  assert.equal(checkModelInfo(pc.model, PROVIDER_ID, 'm').ok, true)
})
