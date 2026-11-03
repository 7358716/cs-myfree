/**
 * 运行时工具调用 —— 「模型没法用」的核心链路测试
 *
 * 宿主契约（dsh-llm/lib/types/types.d.ts 实测）：
 *   GenerateOptions.tools?: ToolSchema[]   → adapter 必须映射到 provider 的 tools
 *   assistant.content 的 'tool-call' 块    → OpenAI message.tool_calls
 *   role:'tool' + toolCallId              → OpenAI role:'tool' + tool_call_id
 *   StreamChunk 'tool-call-delta'         → 按 index 聚合（id/name 只在首帧）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertMessages, convertTools } from '../src/index.js'
import { toHostChunks } from '../src/adapter/chunks.js'
import { createAdapter } from '../src/adapter/index.js'
import * as kilo from '../src/pools/keyless/kilo.js'
import { chat as channelChat } from '../src/pools/channels/driver.js'
import { AUTH } from '../src/pools/channels/protocols.js'

async function collect(iter) { const o = []; for await (const c of iter) o.push(c); return o }

const TOOLS = [
  {
    name: 'bash',
    description: '执行 shell 命令',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  { name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
]

// ── ① 宿主 ToolSchema → OpenAI tools ──

test('🔴 convertTools 把宿主 ToolSchema 映射成 OpenAI tools 形状', () => {
  const out = convertTools(TOOLS)
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { type: 'function', function: { name: 'bash', description: '执行 shell 命令', parameters: TOOLS[0].parameters } })
  assert.equal(out[1].function.name, 'read')
})

test('convertTools：空/非法返回 undefined（不发送 tools 字段）', () => {
  assert.equal(convertTools([]), undefined)
  assert.equal(convertTools(null), undefined)
  assert.equal(convertTools([{ name: '' }]), undefined)
  // 缺 parameters 也要给出合法 JSON Schema（很多端点会 400）
  const out = convertTools([{ name: 'x', description: '' }])
  assert.deepEqual(out[0].function.parameters, { type: 'object', properties: {} })
})

// ── ② 真实 OpenAI 形状的 messages 回放 ──

test('🔴 assistant 的 tool-call 块 → tool_calls 字段', () => {
  const out = convertMessages([
    { role: 'user', content: [{ type: 'text', text: '列一下目录' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '思考（不回传）' },
        { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
      ],
    },
  ])
  assert.equal(out.length, 2)
  const a = out[1]
  assert.equal(a.role, 'assistant')
  assert.equal(a.content, null, '只有工具调用时 content 必须为 null')
  assert.equal(a.tool_calls.length, 1)
  assert.deepEqual(a.tool_calls[0], {
    id: 'call_1',
    type: 'function',
    function: { name: 'bash', arguments: '{"command":"ls"}' },
  })
  assert.equal(JSON.stringify(out).includes('思考（不回传）'), false, 'reasoning 块不得回传')
})

test('🔴 tool 结果消息 → { role:"tool", tool_call_id }', () => {
  const out = convertMessages([
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '/home/ubuntu\n' }] },
    { role: 'tool', source: { kind: 'tool', callId: 'call_2' }, content: [{ type: 'text', text: 'a.txt' }] },
  ])
  assert.deepEqual(out[0], { role: 'tool', tool_call_id: 'call_1', content: '/home/ubuntu\n' })
  // 也支持 source.callId 形态
  assert.deepEqual(out[1], { role: 'tool', tool_call_id: 'call_2', content: 'a.txt' })
})

test('带文本的 assistant 同时保留 content 与 tool_calls', () => {
  const out = convertMessages([{
    role: 'assistant',
    content: [
      { type: 'text', text: '我来执行' },
      { type: 'tool-call', id: 'c', name: 'bash', arguments: '{}' },
    ],
  }])
  assert.equal(out[0].content, '我来执行')
  assert.equal(out[0].tool_calls[0].id, 'c')
})

test('system / developer 消息只取文本；工具增删块由 tools 全量声明覆盖', () => {
  const out = convertMessages([
    { role: 'system', content: [{ type: 'text', text: '系统提示' }] },
    {
      role: 'developer',
      content: [
        { type: 'tool-addition', toolName: 'bash' },
        { type: 'text', text: '补充说明' },
      ],
    },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ])
  assert.deepEqual(out.map((m) => m.role), ['system', 'system', 'user'])
  assert.equal(out[0].content, '系统提示')
  assert.equal(out[1].content, '补充说明', 'tool-addition 不进消息正文')
})

test('options.system 前插 system 消息（一次性调用）', () => {
  const out = convertMessages([{ role: 'user', content: 'hi' }], { system: '你是助手' })
  assert.deepEqual(out[0], { role: 'system', content: '你是助手' })
})

// ── ③ 请求体真的带上 tools（免密源 + 渠道驱动）──

test('🔴 kilo 请求体携带 OpenAI tools + tool_choice（真实网络前的最后一道关）', async () => {
  let body = null
  await kilo.chat({
    model: 'kilo-auto/free',
    messages: [{ role: 'user', content: '列目录' }],
    tools: convertTools(TOOLS),
    toolChoice: 'auto',
    stream: false,
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body)
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }
    },
  })
  assert.ok(Array.isArray(body.tools), '请求体必须含 tools')
  assert.equal(body.tools[0].type, 'function')
  assert.equal(body.tools[0].function.name, 'bash')
  assert.equal(body.tool_choice, 'auto')
})

test('🔴 渠道驱动请求体携带 tools，且免密渠道仍不带 Authorization', async () => {
  let body = null
  let headers = null
  await channelChat({
    channelId: 'demo',
    ch: { baseUrl: 'https://demo.test', auth: AUTH.NONE },
    cred: {},
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: convertTools(TOOLS),
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body); headers = init.headers
      return { ok: true, body: null }
    },
  })
  assert.equal(body.tools[0].function.name, 'bash')
  assert.ok(body.tool_choice)
  assert.equal(Object.keys(headers).some((k) => /^authorization$/i.test(k)), false)
})

// ── ④ 流式 tool_calls 增量聚合 ──

test('🔴 流式 tool_calls 按 index 聚合成独立块（id/name 只在首帧）', async () => {
  async function* src() {
    // 两个调用交错：index 0 先出现 name/id，之后只有 arguments 片段
    yield { type: 'tool-call-delta', calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'bash', arguments: '' } }] }
    yield { type: 'tool-call-delta', calls: [{ index: 0, function: { arguments: '{"comm' } }] }
    yield { type: 'tool-call-delta', calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'read', arguments: '{"pa' } }] }
    yield { type: 'tool-call-delta', calls: [{ index: 0, function: { arguments: 'and":"pwd"}' } }] }
    yield { type: 'tool-call-delta', calls: [{ index: 1, function: { arguments: 'th":"a.txt"}' } }] }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const out = await collect(toHostChunks(src()))
  const starts = out.filter((c) => c.type === 'block-start' && c.blockType === 'tool-call')
  assert.equal(starts.length, 2, '两个调用 = 两个块')
  const ends = out.filter((c) => c.type === 'block-end').map((c) => c.block)
  assert.deepEqual(ends[0], { type: 'tool-call', id: 'call_a', name: 'bash', arguments: '{"command":"pwd"}' })
  assert.deepEqual(ends[1], { type: 'tool-call', id: 'call_b', name: 'read', arguments: '{"path":"a.txt"}' })
  const finish = out.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'tool-calls', '有工具调用时 finish 必须是 tool-calls（哪怕厂商报 stop）')
  // 每个 delta 的 id 都不能为空（宿主契约）
  for (const d of out.filter((c) => c.type === 'tool-call-delta')) assert.ok(d.id)
})

test('非流式 tool-call 整包也能转成宿主块', async () => {
  async function* src() {
    yield {
      type: 'tool-call',
      calls: [{ id: 'call_x', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } }],
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const out = await collect(toHostChunks(src()))
  const end = out.find((c) => c.type === 'block-end')
  assert.deepEqual(end.block, { type: 'tool-call', id: 'call_x', name: 'bash', arguments: '{"command":"pwd"}' })
  assert.equal(out.at(-1).reason.kind, 'tool-calls')
})

// ── ⑤ adapter 端到端：tools 透传 + 工具回放 ──

test('🔴 adapter.stream 把宿主 options.tools 传给 send，且工具历史进入消息', async () => {
  const seen = []
  const adapter = createAdapter({
    builtin: [{ provider: 'kilo', model: 'kilo-auto/free', tier: 1 }],
    send: async (o) => {
      seen.push(o)
      return (async function* () { yield { type: 'text-delta', text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } } })()
    },
  })

  const messages = [
    { role: 'user', content: [{ type: 'text', text: '用 bash 列目录' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }] },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt' }] },
  ]
  const out = await collect(adapter.stream({ model: 'kilo-auto/free', messages, tools: TOOLS }))

  assert.equal(seen.length, 1)
  assert.equal(seen[0].options.tools, TOOLS, 'options 必须原样传到 send（由 send 做 provider 映射）')
  // send 侧映射结果
  const converted = convertMessages(messages, seen[0].options)
  assert.equal(converted[1].tool_calls[0].id, 'c1')
  assert.deepEqual(converted[2], { role: 'tool', tool_call_id: 'c1', content: 'a.txt' })
  assert.equal(out.at(-1).type, 'finish')
})
