/**
 * cs-myfree — 本地网关的协议转换（OpenAI / Anthropic / Gemini 四套方言）
 *
 * 设计依据：v3 §10（ourfree 能力面）。ourfree 的实测结论：
 *  · 真原生 `/v1/messages`（不是把 OpenAI 格式硬转）
 *  · 双门拓扑：回环监听 + LAN 中继，**两把不同的 key**
 *  · 鉴权用 SHA-256 摘要 + `timingSafeEqual`（常数时间比较）
 *
 * 本模块只做**纯格式转换**，不碰网络与鉴权。
 *
 * @module cs-myfree/gateway/formats
 */

/** 内部统一消息形状 → OpenAI chat 格式 */
export function toOpenAi(messages = [], { system } = {}) {
  const out = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue }
    out.push({ role: m.role, content: (m.content ?? []).map(toOpenAiBlock).filter(Boolean) })
  }
  return out
}

function toOpenAiBlock(b) {
  if (!b || typeof b !== 'object') return null
  if (b.type === 'text') return { type: 'text', text: b.text ?? '' }
  if (b.type === 'image') {
    const url = b.url ?? (b.data ? `data:${b.mime ?? 'image/png'};base64,${b.data}` : null)
    return url ? { type: 'image_url', image_url: { url } } : null
  }
  return null
}

/** 内部 → Anthropic messages 格式（system 是顶层字段，不在 messages 里） */
export function toAnthropic(messages = [], { system, maxTokens = 8192, temperature } = {}) {
  const out = { messages: [] }
  if (system) out.system = system
  if (Number.isFinite(maxTokens)) out.max_tokens = maxTokens
  if (Number.isFinite(temperature)) out.temperature = temperature

  for (const m of messages) {
    if (m.role === 'system') continue     // Anthropic 的 system 是顶层
    if (typeof m.content === 'string') {
      out.messages.push({ role: m.role, content: [{ type: 'text', text: m.content }] })
      continue
    }
    out.messages.push({
      role: m.role,
      content: (m.content ?? []).map((b) => {
        if (b?.type === 'text') return { type: 'text', text: b.text ?? '' }
        if (b?.type === 'image') {
          return {
            type: 'image',
            source: { type: 'base64', media_type: b.mime ?? 'image/png', data: b.data ?? '' },
          }
        }
        return null
      }).filter(Boolean),
    })
  }
  return out
}

/** Anthropic 响应 → 内部 chunk 序列 */
export function* fromAnthropic(obj, now = () => Date.now()) {
  for (const block of obj?.content ?? []) {
    if (block?.type === 'text' && block.text) yield { type: 'text-delta', text: block.text, at: now() }
    if (block?.type === 'tool_use') yield { type: 'tool-call', name: block.name, input: block.input, at: now() }
  }
  yield {
    type: 'finish',
    reason: { kind: obj?.stop_reason === 'end_turn' ? 'stop' : (obj?.stop_reason ?? 'stop') },
    usage: obj?.usage ?? null,
    at: now(),
  }
}

/** Anthropic SSE 事件 → 内部 chunk */
export async function* parseAnthropicSse(body, now = () => Date.now()) {
  const decoder = new TextDecoder()
  let buf = ''
  let event = null
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line.startsWith('event:')) { event = line.slice(6).trim(); continue }
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      try {
        const obj = JSON.parse(payload)
        if (event === 'content_block_delta' && obj?.delta?.type === 'text_delta') {
          yield { type: 'text-delta', text: obj.delta.text, at: now() }
        }
        if (event === 'message_stop') return
      } catch { /* 忽略 */ }
    }
  }
}

/** 内部 → Gemini generateContent 请求 */
export function toGemini(messages = [], { system, maxTokens, temperature } = {}) {
  const contents = []
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user'
    const parts = typeof m.content === 'string'
      ? [{ text: m.content }]
      : (m.content ?? []).map((b) => {
        if (b?.type === 'text') return { text: b.text ?? '' }
        if (b?.type === 'image') return { inline_data: { mime_type: b.mime ?? 'image/png', data: b.data ?? '' } }
        return null
      }).filter(Boolean)
    contents.push({ role, parts })
  }
  const body = { contents }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  const gen = {}
  if (Number.isFinite(maxTokens)) gen.maxOutputTokens = maxTokens
  if (Number.isFinite(temperature)) gen.temperature = temperature
  if (Object.keys(gen).length) body.generationConfig = gen
  return body
}

/** Gemini 响应 → 内部 chunk */
export function* fromGemini(obj, now = () => Date.now()) {
  const parts = obj?.candidates?.[0]?.content?.parts ?? []
  for (const p of parts) {
    if (p?.text) yield { type: 'text-delta', text: p.text, at: now() }
  }
  yield {
    type: 'finish',
    reason: { kind: obj?.candidates?.[0]?.finishReason === 'STOP' ? 'stop' : 'stop' },
    usage: obj?.usageMetadata ?? null,
    at: now(),
  }
}

/** 内部 → OpenAI chat.completion 响应（网关出站用） */
export function toOpenAiResponse({ id, model, text, reasoning, usage, finish }) {
  return {
    id: id ?? `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model ?? 'cs-myfree',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text ?? '',
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      },
      finish_reason: finish ?? 'stop',
    }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

/** 内部 → Anthropic messages 响应（网关出站用） */
export function toAnthropicResponse({ id, model, text, usage, finish }) {
  return {
    id: id ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: model ?? 'cs-myfree',
    content: [{ type: 'text', text: text ?? '' }],
    stop_reason: finish === 'stop' ? 'end_turn' : (finish ?? 'end_turn'),
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
    },
  }
}
