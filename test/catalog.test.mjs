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
 *   旧实现把 codearts 标成「无 models 端点、走内置清单」；2026-11-03 渠道调研实测：
 *   codearts **有** `GET https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin`
 *   （需 AK/SK 签名 + 头 `Agent-Type: PromptCenter`，返回 12 个模型）。
 *   旧注释「5 种路径全 404」是查错了 host（当时用的是 officeace 网关）。
 *   ⇒ 现在 codearts 走**远端拉取**，失败或缺 AK/SK 才回落内置清单。
 *   远程形状/鉴权头仍用 minimax 覆盖（无签名、标准 Bearer）。
 */
test('codearts 缺 AK/SK ⇒ 回落内置清单且不抛（source=builtin-after-auth-error）', async () => {
  const r = await fetchChannelModels('codearts', 'pk_test_token_only', {
    fetchImpl: async () => { throw new Error('不该发出未签名的请求') },
  })
  assert.equal(r.ok, true)
  assert.equal(r.source, 'builtin-after-auth-error')
  assert.ok(r.models.length >= 10, 'codearts 内置清单应为远端实测的 12 条')
  assert.ok(r.models.some((m) => m.id === 'GLM-5.2'))
})

test('🔴 codearts 模型清单：签名 GET + Agent-Type: PromptCenter（远端形状）', async () => {
  let seen = null
  const r = await fetchChannelModels('codearts', { ak: 'AKIDtest1234567890', sk: 'SKsecret1234567890123456789012345678901234' }, {
    fetchImpl: async (url, init) => {
      seen = { url, headers: init.headers, method: init.method }
      return { ok: true, json: async () => ({ count: 2, builtinModels: [{ model_id: 'GLM-5.2', model_name: 'GLM 5.2' }, { model_id: 'kimi-k3' }] }) }
    },
  })
  assert.equal(seen.method, 'GET')
  assert.equal(seen.url, 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin')
  assert.match(seen.headers.authorization, /^SDK-HMAC-SHA256 Access=AKIDtest1234567890,/)
  assert.equal(seen.headers['Agent-Type'], 'PromptCenter', '模型清单必须带 Agent-Type')
  assert.ok(seen.headers['x-sdk-date'])
  // content-type 绝不能进 SignedHeaders（本机实测 401 的坑）
  assert.equal(seen.headers.authorization.includes('content-type'), false)
  assert.equal(r.ok, true)
  assert.equal(r.source, 'remote')
  assert.deepEqual(r.models.map((m) => m.id), ['GLM-5.2', 'kimi-k3'])
})

test('codearts 远端失败 ⇒ 回落内置清单（不返回空列表）', async () => {
  const r = await fetchChannelModels('codearts', { ak: 'AKIDtest1234567890', sk: 'SKsecret1234567890123456789012345678901234' }, {
    fetchImpl: async () => ({ ok: false, status: 401 }),
  })
  assert.equal(r.ok, true)
  assert.equal(r.source, 'builtin-after-http-error')
  assert.ok(r.models.length >= 10)
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
