/**
 * cs-myfree — Pollinations（**默认禁用**）
 *
 * 🔴 2026-11-03 实测结论：**不可用于日常对话**
 *    `Free limit reached: 1 reply every 45 seconds per IP`
 *    ⇒ 每 IP 每 45 秒只能 1 次，任何连续对话都会 402。
 *
 * 仍保留代码（用户可手动启用），但**移出默认链**。
 *
 * 🔴 同时修复一个严重 bug：
 *    旧实现用 GET `text.pollinations.ai/<整段prompt>`，
 *    把 DSH 的**整段系统提示词当成用户输入**发了过去
 *    ⇒ 模型回 "Got it. I'm ready to work on the shared filesystem..."（它在回应系统提示）
 *    ⇒ 这正是主管反馈的「openai 总截断到 Got it...」的真因。
 *    现在改用 POST /openai，正确传 messages 结构。
 *
 * @module cs-myfree/pools/keyless/pollinations
 */

export const POLL_BASE = 'https://text.pollinations.ai'
export const KEYLESS = true

/** 是否建议启用（实测不建议） */
export const RECOMMENDED = false
export const DISABLED_REASON = '免费层限流：每 IP 每 45 秒仅 1 次（实测 402 FREE_LIMIT）'

/**
 * 正确用法：POST /openai（OpenAI 兼容，支持 messages 与 system 分离）。
 */
export async function* stream({ messages = [], model = 'openai', tools, toolChoice, signal, fetchImpl = globalThis.fetch, timeoutMs = 60_000 } = {}) {
  // 正确拆分 system 与 user —— 不再把系统提示当用户输入
  // ⚠️ 已知限制：该端点只吃纯文本消息 ⇒ tool_calls/tool 消息会退化成文本后发送。
  const sys = messages.filter((m) => m?.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : '')).filter(Boolean).join('\n')
  const rest = messages.filter((m) => m?.role !== 'system').map((m) => ({
    role: m?.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m?.content === 'string' ? m.content : '',
  })).filter((m) => m.content)

  const body = {
    model,
    messages: sys ? [{ role: 'system', content: sys }, ...rest] : rest,
    max_tokens: 4096,
    ...(Array.isArray(tools) && tools.length > 0 ? { tools, tool_choice: toolChoice ?? 'auto' } : {}),
  }

  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  signal?.addEventListener?.('abort', onAbort)
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const now = () => Date.now()

  try {
    const res = await fetchImpl(`${POLL_BASE}/openai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; cs-myfree)' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      const err = new Error(`Pollinations HTTP ${res.status}: ${t.slice(0, 200)}`)
      err.status = res.status
      throw err
    }
    const j = await res.json()
    const msg = j?.choices?.[0]?.message ?? {}
    if (msg.reasoning) yield { type: 'reasoning-delta', text: String(msg.reasoning), at: now() }
    if (msg.content) yield { type: 'text-delta', text: String(msg.content), at: now() }
    yield { type: 'finish', reason: { kind: 'stop' }, usage: j?.usage ?? null, at: now() }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}
