import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeModelId, parseModelId, channelModelsAsList, fetchChannelModels, SEP } from '../src/pools/channels/catalog.js'
import { CHANNELS } from '../src/pools/channels/protocols.js'

test('模型 id 编解码往返', () => {
  const id = makeModelId('codearts', 'deepseek-v4.1-flash')
  assert.equal(id, 'codearts/deepseek-v4.1-flash')
  assert.deepEqual(parseModelId(id), { channelId: 'codearts', modelId: 'deepseek-v4.1-flash' })
})

test('免密源模型不被误判为渠道模型', () => {
  assert.equal(parseModelId('kilo-auto/free'), null, 'kilo-auto 不是渠道')
  assert.equal(parseModelId('Qwen3.5-9B'), null)
  assert.equal(parseModelId(''), null)
  assert.equal(parseModelId(null), null)
})

test('渠道模型 id 带渠道前缀（防撞名）', () => {
  const id = makeModelId('buddy', 'deepseek-v4.1-flash')
  assert.ok(id.startsWith('buddy/'))
  // 同一模型名在不同渠道不冲突
  assert.notEqual(makeModelId('buddy', 'm'), makeModelId('codearts', 'm'))
})

test('channelModelsAsList 生成带渠道信息', () => {
  const cache = { codearts: { ok: true, models: [{ id: 'm1', name: 'M1' }], at: 1 } }
  const list = channelModelsAsList(cache)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'codearts/m1')
  assert.equal(list[0].channelId, 'codearts')
  assert.equal(list[0].modelId, 'm1')
  assert.match(list[0].name, /CodeArts/)
})

test('未知渠道被跳过', () => {
  const list = channelModelsAsList({ nonexistent: { models: [{ id: 'x' }] } })
  assert.equal(list.length, 0)
})

test('fetchChannelModels 未登录返回失败', async () => {
  const r = await fetchChannelModels('codearts', null)
  assert.equal(r.ok, false)
  assert.match(r.error, /未登录/)
})

test('fetchChannelModels 能解析 OpenAI 形状', async () => {
  const r = await fetchChannelModels('codearts', 'token123', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: 'm1', name: 'M1' }, { id: 'm2' }] }) }),
  })
  assert.equal(r.ok, true)
  assert.equal(r.models.length, 2)
})

test('fetchChannelModels HTTP 失败时返回错误而非抛', async () => {
  const r = await fetchChannelModels('codearts', 't', { fetchImpl: async () => ({ ok: false, status: 404 }) })
  assert.equal(r.ok, false)
  assert.match(r.error, /404/)
})

test('🔴 渠道模型请求必须带鉴权头', async () => {
  let headers = null
  await fetchChannelModels('codearts', 'MYTOKEN', {
    fetchImpl: async (u, init) => { headers = init.headers; return { ok: true, json: async () => ({ data: [] }) } },
  })
  const keys = Object.keys(headers || {}).map((k) => k.toLowerCase())
  assert.ok(keys.includes('authorization'), '必须带 authorization：' + keys.join(','))
})

test('SEP 是斜杠', () => { assert.equal(SEP, '/') })
