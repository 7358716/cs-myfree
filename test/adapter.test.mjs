import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAdapter, orderCandidates, providerRetryPolicy } from '../src/adapter/index.js'
import { KIND } from '../src/adapter/failure-map.js'

const chain = [
  { provider: 'a', model: 'm1', tier: 1 },
  { provider: 'b', model: 'm2', tier: 1 },
  { provider: 'c', model: 'm3', tier: 2 },
]

async function collect(iter) { const out = []; for await (const c of iter) out.push(c); return out }

test('describe 返回与选路共用的链', () => {
  const a = createAdapter({ builtin: chain, send: async () => [] })
  assert.equal(a.describe().chain.length, 3)
})

test('listModels 去重', () => {
  const a = createAdapter({ builtin: [...chain, { provider: 'x', model: 'm1', tier: 1 }], send: async () => [] })
  assert.equal(a.listModels('cs-myfree').length, 3)
})

test('🔴 listModels 每项必须含 provider 字段（宿主契约）', () => {
  const a = createAdapter({ builtin: chain, send: async () => [] })
  for (const m of a.listModels('cs-myfree')) {
    assert.equal(m.provider, 'cs-myfree')
    assert.ok(m.id && m.name)
  }
})

test('🔴 providerInfo 必须含 id 且等于 provider（宿主契约）', () => {
  const a = createAdapter({ builtin: chain, send: async () => [] })
  const pi = a.providerInfo('cs-myfree')
  assert.equal(pi.id, 'cs-myfree')
  assert.ok(pi.name)
})

test('🔴 resolveModel 的 provider 与 id 都必须对（宿主契约）', () => {
  const a = createAdapter({ builtin: chain, send: async () => [] })
  const r = a.resolveModel('cs-myfree', 'm1')
  assert.equal(r.provider, 'cs-myfree')
  assert.equal(r.id, 'm1')
})

test('selfCheck 全绿', () => {
  const a = createAdapter({ builtin: chain, send: async () => [] })
  const sc = a.selfCheck()
  assert.equal(sc.ok, true, '契约问题：' + sc.problems.join('; '))
})

test('prepareCall 返回 { model, stream }', async () => {
  const a = createAdapter({ builtin: chain, send: async () => [] })
  const pc = await a.prepareCall('cs-myfree', 'm1')
  assert.equal(pc.model.id, 'm1')
  assert.equal(typeof pc.stream, 'function')
})

test('第一个候选成功则不再尝试后面的', async () => {
  const tried = []
  const a = createAdapter({
    builtin: chain,
    send: async ({ provider }) => {
      tried.push(provider)
      return (async function* () { yield { type: 'text-delta', text: 'ok' } })()
    },
  })
  const out = await collect(a.stream({ model: 'm1', messages: [] }))
  assert.equal(out.length, 1)
  assert.equal(tried.length, 1)
})

test('首个候选抛错则切下一个（提交点未触发 ⇒ 用户零感知）', async () => {
  const tried = []
  const a = createAdapter({
    builtin: chain,
    send: async ({ provider }) => {
      tried.push(provider)
      if (provider === 'a') {
        return (async function* () {
          yield { type: 'reasoning-delta', text: '想了一下' }  // 不算提交
          throw Object.assign(new Error('quota'), { status: 429, message: 'quota exceeded' })
        })()
      }
      return (async function* () { yield { type: 'text-delta', text: '答案' } })()
    },
  })
  const out = await collect(a.stream({ model: 'm1', messages: [] }))
  assert.equal(tried.length, 2, '应切到第二个候选')
  assert.equal(out.length, 1)
  assert.equal(out[0].text, '答案')
  assert.equal(out[0].text.includes('想了一下'), false, 'reasoning 不应泄漏给用户')
})

test('已提交后的失败不切换候选（内容收不回来）', async () => {
  let calls = 0
  const a = createAdapter({
    builtin: chain,
    send: async () => {
      calls++
      return (async function* () {
        yield { type: 'text-delta', text: '已给出部分答案' }
        throw new Error('stream broken')
      })()
    },
  })
  // 已提交 ⇒ 无法安全换源，如实把错误抛给调用方（不静默拼接畸形回答）
  await assert.rejects(() => collect(a.stream({ model: 'm1', messages: [] })))
  assert.equal(calls, 1, '不得切换到其他候选')
})

test('全部失败时抛错且带最后错误码', async () => {
  const a = createAdapter({
    builtin: chain,
    send: async () => (async function* () {
      throw Object.assign(new Error('boom'), { status: 500 })
    })(),
  })
  await assert.rejects(() => collect(a.stream({ model: 'm1', messages: [] })), /全部候选失败/)
})

test('预算耗尽即停止（不无限重试）', async () => {
  let calls = 0
  const a = createAdapter({
    builtin: Array.from({ length: 50 }, (_, i) => ({ provider: `p${i}`, model: `m${i}`, tier: 1 })),
    budget: { maxAttempts: 3 },
    // 用可重试的 500（UNKNOWN 会按设计直接上报，测不到预算）
    send: async () => {
      calls++
      return (async function* () { throw Object.assign(new Error('server'), { status: 500 }) })()
    },
  })
  await assert.rejects(() => collect(a.stream({ model: 'm0', messages: [] })))
  assert.equal(calls, 3, '必须受 maxAttempts 约束')
})

test('orderCandidates 优先同 model', () => {
  const o = orderCandidates(chain, 'm3')
  assert.equal(o[0].model, 'm3')
})

test('orderCandidates 无指定时按 tier', () => {
  const o = orderCandidates([{ provider: 'x', model: 'a', tier: 3 }, { provider: 'y', model: 'b', tier: 1 }])
  assert.equal(o[0].tier, 1)
})

test('providerInfo 只认 cs-myfree', () => {
  const a = createAdapter({ send: async () => [] })
  assert.ok(a.providerInfo('cs-myfree'))
  assert.equal(a.providerInfo('other'), undefined)
})

test('providerRetryPolicy 已导出且排除 RATE_LIMIT', () => {
  assert.equal(providerRetryPolicy().retryableCodes.includes('RATE_LIMIT'), false)
})

test('createAdapter 缺 send 立即报错（不静默）', () => {
  assert.throws(() => createAdapter({}), /send/)
})
