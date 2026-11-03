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

import { randomUUID } from 'node:crypto'
import { AUTH } from './protocols.js'
import { signHuaweiRequest } from './sign.js'
import { toUsage } from '../keyless/base.js'

/**
 * 上游「并发会话数超限」判定（codearts 实测 HTTP 400 / TM.00001041）。
 * 单独导出便于单测：这是「看起来像参数错误、实际是限流」的典型陷阱。
 */
export function isConcurrencyCapError(text) {
  const s = String(text ?? '')
  return /TM\.00001041/.test(s) || /并发会话数/.test(s) || /concurrent session/i.test(s)
}

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
    case AUTH.SIGNED_HUAWEI:
      // SDK-HMAC-SHA256 需要完整 URL + body 才能算签名 ⇒ 由 buildRequestHeaders 生成
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
 * 构造一次请求的**完整请求头**（含签名）。
 *
 * 对 SIGNED_HUAWEI（codearts）：用 AK/SK/securityToken 对 method+url+body 签名，
 * 返回签名要求随请求发送的头 + Authorization；`extraUnsignedHeaders`
 * （如模型清单的 Agent-Type / X-Language）只发送、不参与签名。
 * 其余渠道等价于 `buildAuthHeaders` + 基础头。
 *
 * @param {object} ch 渠道协议
 * @param {object} cred {token?, ak?, sk?, securityToken?, sig?}
 * @param {{method?:string, url:string, body?:string, accept?:string, extraUnsignedHeaders?:object}} o
 */
export function buildRequestHeaders(ch, cred = {}, o = {}) {
  const { method = 'POST', url, body = '', accept, extraUnsignedHeaders } = o
  const h = {
    'content-type': 'application/json',
    ...(accept ? { accept } : {}),
    'user-agent': 'Mozilla/5.0 (compatible; cs-myfree)',
    // 🔴 渠道声明式**准入头**（腾讯 CodeBuddy / WorkBuddy 必需；缺则 401 not_authorized）
    //    放在 auth 之前，允许 auth 覆盖（例如签名型渠道会自己设 authorization）
    ...(ch.staticHeaders && typeof ch.staticHeaders === 'object' ? ch.staticHeaders : {}),
    ...buildAuthHeaders(ch, cred),
  }
  // 每次请求生成三枚非空会话头（腾讯系「特定账号」要求三枚齐全，缺失会 400/11128；
  // 对多数账号无害 —— 参考包实测结论：按账号生效，故一律发送）
  if (ch.dynamicHeaders === 'conversation') {
    const conv = randomUUID().replace(/-/g, '')
    h['X-Conversation-ID'] = conv
    h['X-Conversation-Request-ID'] = conv
    h['X-Conversation-Message-ID'] = conv
  }
  if (ch.auth === AUTH.SIGNED_HUAWEI) {
    const signed = signHuaweiRequest({
      ak: cred.ak,
      sk: cred.sk,
      securityToken: cred.securityToken,
      method,
      url,
      body,
    })
    Object.assign(h, signed.headers)
    h.authorization = signed.authorization
  }
  // 不参与签名、但要随请求发的头（codearts 模型清单要求 Agent-Type 等）
  const extra = { ...(extraUnsignedHeaders ?? {}) }
  for (const [k, v] of Object.entries(extra)) h[k] = v
  return h
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

  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  signal?.addEventListener?.('abort', onAbort)
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    // 渠道声明式 body 附加字段（codearts: include/reasoning_summary/tool_stream…）
    const body = { model, messages, stream, ...(ch.bodyExtra ?? {}) }
    // 会话级缓存键（codearts 不传则 cached_tokens 恒 0）
    if (ch.auth === AUTH.SIGNED_HUAWEI && o.sessionId) body.prompt_cache_key = String(o.sessionId)
    // 宿主 tools → OpenAI tools（不传 = 模型无法调用工具）
    if (Array.isArray(tools) && tools.length > 0) { body.tools = tools; body.tool_choice = o.toolChoice ?? 'auto' }
    // 输出上限：渠道若声明 maxOutputTokens（codearts 65536）必须钳制，否则上游拒/空流
    let maxTokens = Number.isFinite(o.maxTokens) && o.maxTokens > 0 ? Math.floor(o.maxTokens) : null
    if (Number.isFinite(ch.maxOutputTokens) && ch.maxOutputTokens > 0) {
      maxTokens = Math.min(maxTokens ?? ch.maxOutputTokens, ch.maxOutputTokens)
    }
    if (maxTokens !== null) body.max_tokens = maxTokens
    if (Number.isFinite(o.temperature)) body.temperature = o.temperature
    if (Array.isArray(o.stop) && o.stop.length > 0) body.stop = o.stop

    const payload = JSON.stringify(body)
    const headers = buildRequestHeaders(ch, cred, {
      method: 'POST',
      url,
      body: payload,
      accept: stream ? 'text/event-stream' : 'application/json',
      extraUnsignedHeaders: o.extraHeaders,
    })

    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: payload,
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      // codearts 有「并发会话数」上限（实测 3 个）。超限时上游回 HTTP 400
      // TM.00001041「并发会话数已达上限」——这不是参数错误，重试一次通常就好；
      // 归类为 RATE_LIMIT（可换号/退避），绝不能让上层误判成 INVALID_REQUEST。
      if (isConcurrencyCapError(text) && !o._capRetried) {
        const wait = Math.max(0, Number(o.capRetryDelayMs ?? 2500))
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        return chat({ ...o, _capRetried: true })
      }
      const err = new Error(`${o.channelId} HTTP ${res.status}: ${text.slice(0, 300)}`)
      err.status = res.status
      err.channel = o.channelId
      if (isConcurrencyCapError(text)) {
        err.code = 'RATE_LIMIT'
        err.message = `渠道 ${o.channelId} 并发会话已满（上游限制 3 个）：请稍后重试，或关闭其它窗口/会话`
      }
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
        if (obj.usage) yield { type: 'usage', usage: toUsage(obj.usage), at: now() }
      } catch { /* 忽略 */ }
    }
  }
}

/** 完整流式对话（渠道级） */
export async function* streamChat(o) {
  const res = await chat({ ...o, stream: true })
  yield* parseSse(res)
}
