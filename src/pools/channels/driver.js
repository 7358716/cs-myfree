/**
 * cs-myfree — 通用渠道驱动（按协议数据发请求，零第三方依赖）
 *
 * 设计：新增渠道只需在 protocols.js 加一条数据，**不用写新代码**。
 *
 * ⚠️ 安全纪律：凭据由调用方通过 credentials 参数注入，
 *    本模块**绝不读取/打印/落盘**任何密钥。
 *
 * @module cs-myfree/pools/channels/driver
 */

import { AUTH } from './protocols.js'

/**
 * 构造鉴权头。
 * @param {object} ch 渠道协议
 * @param {{token?:string, ak?:string, sig?:string, cookie?:string}} cred
 */
export function buildAuthHeaders(ch, cred = {}) {
  const h = {}
  switch (ch.auth) {
    case AUTH.BEARER:
      if (cred.token) h.authorization = `Bearer ${cred.token}`
      break
    case AUTH.CUSTOM_HEADER: {
      const fmt = ch.authHeaderFormat ?? 'Bearer {token}'
      if (cred.ak && cred.sig) {
        h.authorization = fmt.replace('{ak}', cred.ak).replace('{sig}', cred.sig)
      } else if (cred.token) {
        h.authorization = fmt.includes('{token}') ? fmt.replace('{token}', cred.token) : `Bearer ${cred.token}`
      }
      break
    }
    case AUTH.COOKIE:
      if (cred.cookie) h.cookie = cred.cookie
      break
    case AUTH.API_KEY:
      if (cred.token) h['x-api-key'] = cred.token
      break
    case AUTH.NONE:
    default:
      break   // 免密：**绝不设置** authorization
  }
  // 防御：免密渠道即使传了也不设
  if (ch.auth === AUTH.NONE) delete h.authorization
  return h
}

/** 拼接 URL（base + path，去重斜杠） */
export function joinUrl(base, path) {
  const b = String(base ?? '').replace(/\/+$/, '')
  const p = String(path ?? '').replace(/^\/+/, '')
  return p ? `${b}/${p}` : b
}

/**
 * 发一次 chat 请求。
 * @param {object} o
 * @param {string} o.channelId
 * @param {object} o.ch           渠道协议
 * @param {object} o.cred         凭据（仅在内存中使用）
 * @param {string} o.model
 * @param {Array}  o.messages
 * @param {boolean} o.stream
 * @param {AbortSignal} o.signal
 * @param {Function} o.fetchImpl
 * @param {number} o.timeoutMs
 */
export async function chat(o) {
  const {
    ch, cred = {}, model, messages, tools, stream = true,
    signal, fetchImpl = globalThis.fetch, timeoutMs = 90_000,
  } = o

  const url = joinUrl(ch.baseUrl, ch.chatPath ?? '/v1/chat/completions')
  const headers = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'user-agent': 'Mozilla/5.0 (compatible; cs-myfree)',
    ...buildAuthHeaders(ch, cred),
  }

  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  signal?.addEventListener?.('abort', onAbort)
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    const body = { model, messages, stream }
    // 宿主 tools → OpenAI tools（不传 = 模型无法调用工具）
    if (Array.isArray(tools) && tools.length > 0) { body.tools = tools; body.tool_choice = o.toolChoice ?? 'auto' }
    if (Number.isFinite(o.maxTokens) && o.maxTokens > 0) body.max_tokens = Math.floor(o.maxTokens)
    if (Number.isFinite(o.temperature)) body.temperature = o.temperature
    if (Array.isArray(o.stop) && o.stop.length > 0) body.stop = o.stop

    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const err = new Error(`${o.channelId} HTTP ${res.status}: ${text.slice(0, 300)}`)
      err.status = res.status
      err.channel = o.channelId
      throw err
    }
    return res
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/** 通用 OpenAI 形状 SSE 解析 */
export async function* parseSse(res, now = () => Date.now()) {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of res.body) {
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
        const d = obj?.choices?.[0]?.delta ?? {}
        const reason = d.reasoning_content ?? d.reasoning
        if (reason) yield { type: 'reasoning-delta', text: reason, at: now() }
        if (d.content) yield { type: 'text-delta', text: d.content, at: now() }
        if (d.tool_calls) yield { type: 'tool-call-delta', calls: d.tool_calls, at: now() }
      } catch { /* 忽略 */ }
    }
  }
}

/** 完整流式对话（渠道级） */
export async function* streamChat(o) {
  const res = await chat({ ...o, stream: true })
  yield* parseSse(res)
}
