/**
 * cs-myfree — 宿主 StreamChunk 生成器（**契约合规**）
 *
 * 🔴 血泪教训（v1.2.0 实测报错）：
 *    `reasoning-delta index must be a non-negative safe integer`
 *    根因：我的 chunk 完全没有 `index` 字段，且不是 **block 事件流**。
 *
 * 宿主的正确协议（`dsh-llm/lib/types/types.d.ts` 实测）：
 *   { type:'block-start',      index, blockType }
 *   { type:'text-delta',       index, text }
 *   { type:'reasoning-delta',  index, text }
 *   { type:'tool-call-delta',  index, id, name?, argumentsDelta }
 *   { type:'block-end',        index, block }
 *   { type:'usage',            usage }
 *   { type:'finish',           reason, replayState? }
 *
 * 铁律：
 *  · 每个 block 独占一个 index，从 0 递增
 *  · delta 必须在 block-start 之后、block-end 之前
 *  · block-end 携带**拼装完整的块**
 *  · usage 在 finish 之前发，之后什么都不发
 *
 * @module cs-myfree/adapter/chunks
 */

/** 块构造器：把「开源增量」翻译成宿主 block 事件流 */
export function createBlockWriter({ now = () => Date.now() } = {}) {
  let nextIndex = 0
  const open = new Map()   // index -> { kind, text, calls }
  const order = []

  return {
    /** 开始一个块 */
    start(kind) {
      const index = nextIndex++
      open.set(index, { kind, text: '', calls: [] })
      order.push(index)
      return { type: 'block-start', index, blockType: kind }
    },

    /** 文本增量 */
    text(index, text) {
      const b = open.get(index)
      if (b) b.text += text
      return { type: 'text-delta', index, text }
    },

    /** 思考增量 */
    reasoning(index, text) {
      const b = open.get(index)
      if (b) b.text += text
      return { type: 'reasoning-delta', index, text }
    },

    /** 工具调用增量 */
    toolCall(index, { id, name, argumentsDelta }) {
      const b = open.get(index)
      if (b) b.calls.push({ id, name, arguments: argumentsDelta })
      return { type: 'tool-call-delta', index, id: id || `call_${index}`, name, argumentsDelta: argumentsDelta || '' }
    },

    /** 结束一个块，返回 block-end */
    end(index) {
      const b = open.get(index)
      if (!b) return null
      open.delete(index)
      let block
      if (b.kind === 'text') block = { type: 'text', text: b.text }
      else if (b.kind === 'reasoning') block = { type: 'reasoning', text: b.text }
      else if (b.kind === 'tool-call') block = { type: 'tool-call', id: b.calls[0]?.id || 'call', name: b.calls[0]?.name || '', arguments: b.calls.map((c) => c.arguments).join('') }
      else block = { type: 'text', text: b.text }
      return { type: 'block-end', index, block }
    },

    /** 结束所有未关闭的块（异常中断时用） */
    closeAll() {
      const out = []
      for (const index of order) {
        if (open.has(index)) {
          const e = this.end(index)
          if (e) out.push(e)
        }
      }
      return out
    },

    get openIndexes() { return [...open.keys()] },
  }
}

/** usage 块（在 finish 之前发） */
export function usageChunk({ inputTokens = 0, outputTokens = 0, totalTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens } = {}) {
  const u = { inputTokens: Number(inputTokens) || 0, outputTokens: Number(outputTokens) || 0 }
  if (Number.isFinite(totalTokens)) u.totalTokens = totalTokens
  if (Number.isFinite(cacheReadTokens)) u.cacheReadTokens = cacheReadTokens
  if (Number.isFinite(cacheWriteTokens)) u.cacheWriteTokens = cacheWriteTokens
  if (Number.isFinite(reasoningTokens)) u.reasoningTokens = reasoningTokens
  return { type: 'usage', usage: u }
}

/** finish 块 */
export function finishChunk(kind = 'stop', replayState) {
  const reason = { kind }
  const c = { type: 'finish', reason }
  if (replayState) c.replayState = replayState
  return c
}

/**
 * 把「简化的 OpenAI 增量」包装成宿主 block 事件流。
 *
 * 输入（我们的免密源解析器产出）：
 *   { type:'text-delta', text }
 *   { type:'reasoning-delta', text }
 *   { type:'tool-call-delta', calls }
 *   { type:'finish', reason:{kind} }
 *
 * 输出：宿主要求的带 index 的块事件流。
 */
export async function* toHostChunks(source, { now = () => Date.now() } = {}) {
  const w = createBlockWriter({ now })
  let textIdx = null
  let reasonIdx = null
  let callIdx = null
  let finished = false
  let usage = null

  for await (const c of source) {
    if (!c || typeof c !== 'object') continue

    if (c.type === 'text-delta' && c.text) {
      // 文本开始 ⇒ 先关掉 reasoning 块
      if (reasonIdx !== null) {
        const e = w.end(reasonIdx)
        if (e) yield e
        reasonIdx = null
      }
      if (textIdx === null) {
        const s = w.start('text')
        textIdx = s.index
        yield s
      }
      yield w.text(textIdx, c.text)
      continue
    }

    if (c.type === 'reasoning-delta' && c.text) {
      if (reasonIdx === null) {
        if (textIdx !== null) {                       // 文本后再思考属异常，但仍按块切
          const e = w.end(textIdx); if (e) yield e; textIdx = null
        }
        const s = w.start('reasoning')
        reasonIdx = s.index
        yield s
      }
      yield w.reasoning(reasonIdx, c.text)
      continue
    }

    if (c.type === 'tool-call-delta' || c.type === 'tool-call') {
      if (callIdx === null) {
        const s = w.start('tool-call')
        callIdx = s.index
        yield s
      }
      const calls = c.calls || []
      for (const call of calls) {
        yield w.toolCall(callIdx, {
          id: call.id,
          name: call.function?.name || call.name,
          argumentsDelta: call.function?.arguments ?? call.arguments ?? '',
        })
      }
      continue
    }

    if (c.type === 'usage' && c.usage) { usage = c.usage; continue }

    if (c.type === 'finish') {
      finished = true
      // 关闭所有未结束的块
      for (const e of w.closeAll()) yield e
      textIdx = null; reasonIdx = null; callIdx = null
      if (usage) { yield usageChunk(usage); usage = null }
      yield finishChunk(c.reason?.kind ?? 'stop', c.replayState)
      return
    }
  }

  // 流意外结束：仍要发完整终止序列
  for (const e of w.closeAll()) yield e
  if (usage) yield usageChunk(usage)
  if (!finished) yield finishChunk('stop')
}
