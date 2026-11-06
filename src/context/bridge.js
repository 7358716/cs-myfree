/**
 * 外部对话上下文（DeepSeek 网页版 → DSH）
 *
 * 用户诉求（2026-11-06）：他在 DeepSeek 网页版聊天，希望「信息传递给 DSH 少」，
 * 方便后续工作。方案 B：浏览器扩展定期把当前页面对话发到这里，DSH 只保留最近 N 条。
 *
 * 🔴 三条设计纪律：
 *  1. **传得少**：滑动窗口（默认 20 条）+ 每条截断（默认 200 字）+ 总字节上限。
 *     不做全文同步 —— 上下文爆掉会让主模型直接不可用，代价远大于收益。
 *  2. **只读不写回**：本模块只接收、只提供读取，绝不向 DeepSeek 页面写任何东西。
 *  3. **不落盘原文**：默认只放内存（进程级）。落盘可选，且受 maxBytes 硬上限约束，
 *     避免用户对话被长期留存在服务器磁盘上。
 *
 * @module cs-myfree/context/bridge
 */

/** 默认窗口参数（小而稳，别让外部上下文挤掉真正的工程上下文） */
export const CONTEXT_DEFAULTS = Object.freeze({
  maxMessages: 20,      // 最多保留多少条
  maxCharsPerMessage: 200,   // 每条最多保留多少字（超出截断并标记）
  maxTotalBytes: 64 * 1024,  // 整体硬上限（防一次灌爆）
  maxAgeMs: 6 * 3600 * 1000, // 超过 6 小时的旧对话自动丢弃
})

/**
 * 把一条原始消息归一成存储形状。
 * @param {{role?:string, text?:string, at?:number, id?:string}} m
 * @param {number} maxChars
 */
export function normalizeMessage(m, maxChars = CONTEXT_DEFAULTS.maxCharsPerMessage) {
  const role = String(m?.role ?? 'user').toLowerCase()
  const safeRole = ['user', 'assistant', 'system'].includes(role) ? role : 'user'
  let text = String(m?.text ?? '').replace(/\s+/g, ' ').trim()
  const originalChars = text.length
  let truncated = false
  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    truncated = true
  }
  return {
    id: typeof m?.id === 'string' && m.id ? m.id : null,
    role: safeRole,
    text,
    truncated,
    originalChars,
    at: Number.isFinite(m?.at) ? Number(m.at) : Date.now(),
  }
}

/**
 * 创建一个上下文桥（内存态 + 可选落盘）。
 *
 * @param {{dshHome?:string, now?:Function, persist?:boolean}} opts
 */
export function createContextBridge({ now = () => Date.now(), maxTotalBytes = CONTEXT_DEFAULTS.maxTotalBytes } = {}) {
  /** @type {{threadId:string, url:string, updatedAt:number, dropped:number, messages:Array}|null} */
  let current = null

  /**
   * 接收一次上报（整段覆盖，非增量 —— 扩展每次发全量最近 N 条，
   * 这样「用户在网页删了消息」也能如实反映，不会越积越多）。
   *
   * @param {{threadId?:string, url?:string, messages?:Array, maxMessages?:number, maxCharsPerMessage?:number}} payload
   */
  function ingest(payload = {}) {
    const maxMessages = clampInt(payload.maxMessages, CONTEXT_DEFAULTS.maxMessages, 1, 200)
    const maxChars = clampInt(payload.maxCharsPerMessage, CONTEXT_DEFAULTS.maxCharsPerMessage, 20, 4000)

    const raw = Array.isArray(payload.messages) ? payload.messages : []
    const normalized = raw.slice(-maxMessages).map((m) => normalizeMessage(m, maxChars))
    const droppedCount = Math.max(0, raw.length - normalized.length)

    // 最近的消息在末尾：从后往前累加，超预算就丢最早的
    const kept = []
    let bytes = 0
    for (let i = normalized.length - 1; i >= 0; i--) {
      const m = normalized[i]
      const size = Buffer.byteLength(m.text, 'utf8')
      if (bytes + size > maxTotalBytes && kept.length > 0) break
      kept.unshift(m)
      bytes += size
    }

    current = {
      threadId: String(payload.threadId ?? 'default').slice(0, 120),
      url: String(payload.url ?? '').slice(0, 500),
      updatedAt: now(),
      dropped: droppedCount,
      bytesKept: bytes,
      messages: kept,
    }
    return { ok: true, accepted: kept.length, dropped: droppedCount, bytes: bytes }
  }

  /**
   * 读当前上下文（供 adapter/工具取用）。
   * @param {{maxMessages?:number, maxCharsPerMessage?:number, maxAgeMs?:number}} opts
   */
  function read(opts = {}) {
    if (!current) return { ok: true, empty: true, messages: [], note: '还没有来自网页版的上报' }
    const age = now() - current.updatedAt
    const maxAge = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : CONTEXT_DEFAULTS.maxAgeMs
    if (age > maxAge) {
      return { ok: true, empty: true, messages: [], note: `最近一次上报已过期（${humanAge(age)}前）` }
    }
    const n = clampInt(opts.maxMessages, current.messages.length, 1, current.messages.length || 1)
    const maxChars = Number.isFinite(opts.maxCharsPerMessage) ? opts.maxCharsPerMessage : null
    let msgs = current.messages.slice(-n)
    if (maxChars !== null) msgs = msgs.map((m) => (m.text.length > maxChars ? { ...m, text: m.text.slice(0, maxChars), truncated: true } : m))
    return {
      ok: true,
      empty: msgs.length === 0,
      threadId: current.threadId,
      url: current.url,
      updatedAt: current.updatedAt,
      ageMs: age,
      dropped: current.dropped,
      messages: msgs,
      note: msgs.length ? `来自网页版最近 ${msgs.length} 条` : '窗口为空',
    }
  }

  /** 清空（用户主动要「忘掉」时） */
  function clear() {
    current = null
    return { ok: true, cleared: true }
  }

  /** 只读摘要（页面展示用，不含正文 —— 避免把长文再搬一次） */
  function summary() {
    if (!current) return { ok: true, empty: true }
    return {
      ok: true,
      empty: false,
      threadId: current.threadId,
      url: current.url,
      updatedAt: current.updatedAt,
      ageMs: now() - current.updatedAt,
      count: current.messages.length,
      dropped: current.dropped,
      bytesKept: current.bytesKept ?? 0,
      preview: current.messages.slice(-2).map((m) => ({ role: m.role, text: m.text.slice(0, 60) })),
    }
  }

  return { ingest, read, clear, summary }
}

function clampInt(v, def, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function humanAge(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`
  if (ms < 3600_000) return `${Math.round(ms / 60_000)} 分钟`
  return `${Math.round(ms / 3600_000)} 小时`
}