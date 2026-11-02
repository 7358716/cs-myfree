/**
 * cs-myfree — 免密池公共基座
 *
 * 🔴 铁律（本机实测，Kilo 与 OVH 同一行为）：
 *    **不发 Authorization → 200；带任何 key（含假的）→ 403**
 *    ⇒ 必须「完全不设置该头」，不是「传占位值」。
 *    旧插件正是栽在这（`kilo.js:59` 塞了占位凭据 → Bearer public → 401）。
 *
 * ⚠️ 另一条：pi-ai 在 `apiKey !== undefined` 时会**强制塞 Bearer**
 *    （`dsh-llm-pi-ai/lib/index.js:2410`）⇒ 免密链必须**自持 HTTP 客户端**，
 *    不能走 pi-ai 的通用路径。
 *
 * @module cs-myfree/pools/keyless/base
 */

export const KEYLESS_RULE = Object.freeze({
  mustOmitAuthorization: true,
  note: '免密端点带任何 key 都会 403，必须完全省略 Authorization 头',
})

/** 构造免密请求头 —— 绝不包含 Authorization */
export function keylessHeaders(extra = {}) {
  const h = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'Mozilla/5.0 (compatible; cs-myfree)',
    ...extra,
  }
  // 防御：即使调用方传了也删掉
  for (const k of Object.keys(h)) {
    if (/^authorization$/i.test(k)) delete h[k]
  }
  return h
}

/** 统一的 SSE→chunk 解析（OpenAI 兼容格式，含 reasoning 字段） */
export async function* parseOpenAiSse(body, now = () => Date.now()) {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const obj = JSON.parse(payload)
        const delta = obj?.choices?.[0]?.delta ?? {}
        const reason = delta.reasoning_content ?? delta.reasoning
        if (reason) yield { type: 'reasoning-delta', text: reason, at: now() }
        if (delta.content) yield { type: 'text-delta', text: delta.content, at: now() }
        if (delta.tool_calls) yield { type: 'tool-call-delta', calls: delta.tool_calls, at: now() }
        const fin = obj?.choices?.[0]?.finish_reason
        if (fin) yield { type: 'finish', reason: { kind: fin === 'stop' ? 'stop' : fin }, at: now() }
      } catch { /* 忽略心跳 */ }
    }
  }
}

/** 非流式响应 → chunk 序列（很多免费端点不支持 stream） */
export function* fromCompletionJson(obj, now = () => Date.now()) {
  const msg = obj?.choices?.[0]?.message ?? {}
  const reason = msg.reasoning_content ?? msg.reasoning
  if (reason) yield { type: 'reasoning-delta', text: reason, at: now() }
  if (msg.content) yield { type: 'text-delta', text: msg.content, at: now() }
  if (msg.tool_calls) yield { type: 'tool-call', calls: msg.tool_calls, at: now() }
  yield { type: 'finish', reason: { kind: 'stop' }, usage: obj?.usage ?? null, at: now() }
}

/**
 * 通用 chat 请求。
 * @param {object} o
 * @param {string} o.baseUrl
 * @param {string} o.model
 * @param {Array}  o.messages
 * @param {object} o.headers
 * @param {boolean} o.stream
 * @param {AbortSignal} o.signal
 * @param {Function} o.fetchImpl
 * @param {number} o.timeoutMs
 */
export async function chatRequest(o) {
  const {
    baseUrl, model, messages, headers = {}, stream = false,
    signal, fetchImpl = globalThis.fetch, timeoutMs = 60_000,
  } = o

  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  signal?.addEventListener?.('abort', onAbort)
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    const res = await fetchImpl(baseUrl, {
      method: 'POST',
      headers: keylessHeaders(headers),
      body: JSON.stringify({ model, messages, stream }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
      err.status = res.status
      throw err
    }
    if (stream && res.body) return { stream: true, body: res.body }
    return { stream: false, json: await res.json() }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}
