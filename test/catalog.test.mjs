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

/**
 * ⚠️ 定案理由（3 个旧用例为何改）：
 *   codearts 实测**没有** `/v1/models` 端点（builtin-models.js 的 MODELS_PATH.codearts = null，
 *   5 种候选路径全 404；参考实现 dsh-codearts-auth 也是从
 *   opengw gateway/config + snap-access /v1/model/builtin 拿模型，不是 OpenAI /v1/models）。
 *   ⇒ 走内置清单是**正确设计**，旧测试却拿 codearts 断言「远程形状」，
 *     所以是**测试过时**，不是实现错。
 *   远程形状/鉴权头改用真正有 models 端点的渠道（minimax，BEARER）验证；
 *   另加一条用例把 codearts 的「内置兜底」新设计钉死。
 */
test('codearts 无 models 端点 ⇒ 用内置清单（source=builtin，可被选中）', async () => {
  let called = false
  const r = await fetchChannelModels('codearts', 'token123', {
    fetchImpl: async () => { called = true; return { ok: true, json: async () => ({ data: [] }) } },
  })
  assert.equal(called, false, '已知没有 models 端点 ⇒ 不该发无用请求')
  assert.equal(r.ok, true)
  assert.equal(r.source, 'builtin')
  assert.ok(r.models.length >= 1)
  assert.ok(r.models.some((m) => m.id === 'deepseek-v4-pro'), '内置清单必须含 deepseek-v4-pro')
})

test('fetchChannelModels 能解析 OpenAI 形状（远端渠道 minimax）', async () => {
  const r = await fetchChannelModels('minimax', 'token123', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: 'm1', name: 'M1' }, { id: 'm2' }] }) }),
  })
  assert.equal(r.ok, true)
  assert.equal(r.source, 'remote')
  assert.equal(r.models.length, 2)
  assert.deepEqual(r.models[0], { id: 'm1', name: 'M1' })
})

test('fetchChannelModels HTTP 失败时返回错误而非抛', async () => {
  const r = await fetchChannelModels('minimax', 't', {
    allowBuiltin: false,
    fetchImpl: async () => ({ ok: false, status: 404 }),
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /404/)
})

test('fetchChannelModels 远端失败会回落内置清单（不返回空列表）', async () => {
  const r = await fetchChannelModels('minimax', 't', { fetchImpl: async () => ({ ok: false, status: 500 }) })
  assert.equal(r.ok, true)
  assert.equal(r.source, 'builtin-after-http-error')
  assert.ok(r.models.length >= 1)
})

test('🔴 渠道模型请求必须带鉴权头', async () => {
  let headers = null
  await fetchChannelModels('minimax', 'MYTOKEN', {
    fetchImpl: async (u, init) => { headers = init.headers; return { ok: true, json: async () => ({ data: [] }) } },
  })
  const keys = Object.keys(headers || {}).map((k) => k.toLowerCase())
  assert.ok(keys.includes('authorization'), '必须带 authorization：' + keys.join(','))
})

test('SEP 是斜杠', () => { assert.equal(SEP, '/') })
