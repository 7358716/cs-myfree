import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toOpenAi, toAnthropic, toGemini, toOpenAiResponse, toAnthropicResponse, fromAnthropic, fromGemini } from '../src/gateway/formats.js'
import { digest, safeEqual, generateKey, createAuthorizer, validateListenHost } from '../src/gateway/auth.js'
import { createGateway, MAX_BODY_BYTES } from '../src/gateway/server.js'

// ── 格式转换 ──
test('OpenAI 格式：system 提到最前', () => {
  const r = toOpenAi([{ role: 'user', content: 'hi' }], { system: 'you are x' })
  assert.equal(r[0].role, 'system')
  assert.equal(r[1].content, 'hi')
})
test('OpenAI 格式：图片转 image_url', () => {
  const r = toOpenAi([{ role: 'user', content: [{ type: 'image', data: 'AAA', mime: 'image/png' }] }])
  assert.match(r[0].content[0].image_url.url, /^data:image\/png;base64,AAA$/)
})
test('Anthropic：system 是顶层字段', () => {
  const r = toAnthropic([{ role: 'user', content: 'hi' }], { system: 'sys' })
  assert.equal(r.system, 'sys')
  assert.equal(r.messages.length, 1, 'system 不应进 messages')
})
test('Anthropic：图片用 base64 source', () => {
  const r = toAnthropic([{ role: 'user', content: [{ type: 'image', data: 'AAA', mime: 'image/png' }] }])
  assert.equal(r.messages[0].content[0].source.type, 'base64')
})
test('Anthropic 响应 → 内部 chunk', () => {
  const chunks = [...fromAnthropic({ content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn' })]
  assert.equal(chunks[0].type, 'text-delta')
  assert.equal(chunks.at(-1).type, 'finish')
})
test('Gemini：assistant → model', () => {
  const r = toGemini([{ role: 'assistant', content: 'x' }])
  assert.equal(r.contents[0].role, 'model')
})
test('Gemini 响应 → 内部 chunk', () => {
  const chunks = [...fromGemini({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] })]
  assert.equal(chunks[0].text, 'hi')
})
test('OpenAI 出站响应形状正确', () => {
  const r = toOpenAiResponse({ text: 'ok', model: 'm' })
  assert.equal(r.object, 'chat.completion')
  assert.equal(r.choices[0].message.content, 'ok')
})
test('Anthropic 出站响应形状正确', () => {
  const r = toAnthropicResponse({ text: 'ok' })
  assert.equal(r.type, 'message')
  assert.equal(r.content[0].text, 'ok')
})

// ── 鉴权 ──
test('safeEqual 正确比较', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'abcd'), false)
})
test('digest 稳定', () => { assert.deepEqual(digest('x'), digest('x')) })
test('generateKey 有前缀且够长', () => {
  const k = generateKey('t')
  assert.match(k, /^t_/)
  assert.ok(k.length > 20)
})
test('本地门：无 key 拒绝', () => {
  const a = createAuthorizer({ localKey: 'L' })
  assert.equal(a.checkLocal({}).ok, false)
})
test('本地门：正确 key 通过', () => {
  const a = createAuthorizer({ localKey: 'L' })
  assert.equal(a.checkLocal({ authorization: 'Bearer L' }).ok, true)
})
test('LAN 门：无 key 一律拒绝（/health 不豁免）', () => {
  const a = createAuthorizer({ localKey: 'L', lanKey: 'N' })
  assert.equal(a.checkLan({}).ok, false)
})
test('LAN 门：未配置 lanKey 则拒绝', () => {
  const a = createAuthorizer({ localKey: 'L' })
  assert.equal(a.checkLan({ authorization: 'Bearer x' }).ok, false)
})
test('LAN 门：两把 key 不通用（关键）', () => {
  const a = createAuthorizer({ localKey: 'LOCAL', lanKey: 'LAN' })
  assert.equal(a.checkLan({ authorization: 'Bearer LOCAL' }).ok, false, 'localKey 不能过 LAN 门')
  assert.equal(a.checkLan({ authorization: 'Bearer LAN' }).ok, true)
})
test('拒绝通配监听地址', () => {
  assert.equal(validateListenHost('0.0.0.0').ok, false)
  assert.equal(validateListenHost('::').ok, false)
  assert.equal(validateListenHost('127.0.0.1').ok, true)
})

// ── 网关端到端（真实 HTTP，本机回环）──
async function withGateway(fn) {
  const gw = createGateway({
    localKey: 'TESTKEY',
    complete: async function* () { yield { type: 'text-delta', text: 'pong' } },
  })
  const addr = await gw.listen({ host: '127.0.0.1', port: 0 })
  try { await fn(`http://127.0.0.1:${addr.port}`, gw) } finally { await gw.close() }
}

test('网关 /health 可达', async () => {
  await withGateway(async (base) => {
    const r = await fetch(`${base}/health`)
    assert.equal(r.status, 200)
    assert.equal((await r.json()).ok, true)
  })
})

test('网关 OpenAI 端点返回 chat.completion', async () => {
  await withGateway(async (base) => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'ping' }] }),
    })
    const j = await r.json()
    assert.equal(r.status, 200)
    assert.equal(j.choices[0].message.content, 'pong')
  })
})

test('网关 Anthropic 原生端点可用', async () => {
  await withGateway(async (base) => {
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] }),
    })
    const j = await r.json()
    assert.equal(r.status, 200)
    assert.equal(j.type, 'message')
    assert.equal(j.content[0].text, 'pong')
  })
})

test('网关 Gemini 端点可用', async () => {
  await withGateway(async (base) => {
    const r = await fetch(`${base}/v1beta/models/gemini-x:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }] }),
    })
    const j = await r.json()
    assert.equal(r.status, 200)
    assert.equal(j.candidates[0].content.parts[0].text, 'pong')
  })
})

test('网关拒绝自环（x-csmyfree-relay-hop）', async () => {
  await withGateway(async (base) => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csmyfree-relay-hop': '1' },
      body: JSON.stringify({ messages: [] }),
    })
    assert.equal(r.status, 508)
  })
})

test('网关拒绝坏 JSON', async () => {
  await withGateway(async (base) => {
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: 'not json' })
    assert.equal(r.status, 400)
  })
})

test('body 上限是 8MB（对齐宿主实测）', () => {
  assert.equal(MAX_BODY_BYTES, 8 * 1024 * 1024)
})
