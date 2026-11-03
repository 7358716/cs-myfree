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

/** 把厂商 finish_reason 归一成宿主 FinishReason 词汇 */
export function normalizeFinishKind(kind, sawToolCalls = false) {
  if (!kind) return sawToolCalls ? 'tool-calls' : 'stop'
  if (kind === 'tool_calls' || kind === 'tool-calls') return 'tool-calls'
  // 有些端点即使返回了 tool_calls，finish_reason 仍是 stop ⇒ 以实际产出的块为准
  if (sawToolCalls && (kind === 'stop' || kind === 'end_turn' || kind === 'eos')) return 'tool-calls'
  if (kind === 'length' || kind === 'max_tokens') return 'max-tokens'
  return kind
}

/** 块构造器：把「开源增量」翻译成宿主 block 事件流 */
export function createBlockWriter({ now = () => Date.now() } = {}) {
  let nextIndex = 0
  const open = new Map()   // index -> { kind, text, calls, id, name }
  const order = []

  return {
    /** 开始一个块 */
    start(kind, init = {}) {
      const index = nextIndex++
      open.set(index, { kind, text: '', calls: [], id: init.id, name: init.name })
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

    /**
     * 工具调用增量。
     *
     * 🔴 OpenAI 流式协议里 id/name 只在**第一个**增量出现，后续增量只有
     *    `index` + `function.arguments` 片段 ⇒ 必须按 index 聚合到同一个块，
     *    否则宿主会看到 N 个空名/断开的 tool-call 块。
     */
    toolCall(index, { id, name, argumentsDelta }) {
      const b = open.get(index)
      if (b) {
        if (id && !b.id) b.id = id
        if (name && !b.name) b.name = name
        b.calls.push(String(argumentsDelta ?? ''))
      }
      const out = { type: 'tool-call-delta', index, id: (id || b?.id) || `call_${index}`, argumentsDelta: String(argumentsDelta ?? '') }
      // name 只在已知时带（宿主的 name 是可选的；空串会被当成合法名字 ''）
      if (name || b?.name) out.name = name || b.name
      return out
    },

    /** 结束一个块，返回 block-end */
    end(index) {
      const b = open.get(index)
      if (!b) return null
      open.delete(index)
      let block
      if (b.kind === 'text') block = { type: 'text', text: b.text }
      else if (b.kind === 'reasoning') block = { type: 'reasoning', text: b.text }
      else if (b.kind === 'tool-call') block = { type: 'tool-call', id: b.id || `call_${index}`, name: b.name || '', arguments: b.calls.join('') }
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
export function finishChunk(kind = 'stop', replayState, sawToolCalls = false) {
  const reason = { kind: normalizeFinishKind(kind, sawToolCalls) }
  const c = { type: 'finish', reason }
  if (replayState) c.replayState = replayState
  return c
}

/**
 * 把「简化的 OpenAI 增量」包装成宿主 block 事件流。
 *
 * 输入（我们的免密源/渠道解析器产出）：
 *   { type:'text-delta', text }
 *   { type:'reasoning-delta', text }
 *   { type:'tool-call-delta', calls }   ← OpenAI 流式增量（可能只有 index+arguments）
 *   { type:'tool-call', calls }         ← 非流式完整 tool_calls
 *   { type:'finish', reason:{kind}, usage? }
 *
 * 输出：宿主要求的带 index 的块事件流（每个工具调用独占一个块 index）。
 */
export async function* toHostChunks(source, { now = () => Date.now() } = {}) {
  const w = createBlockWriter({ now })
  let textIdx = null
  let reasonIdx = null
  const callBlocks = new Map()   // OpenAI tool_call.index -> 宿主块 index
  let sawToolCalls = false
  let finished = false
  let usage = null

  /** 文本/思考与工具调用不能交错在同一个块里：起新块前先关掉 */
  function* closeText() {
    if (textIdx !== null) { const e = w.end(textIdx); if (e) yield e; textIdx = null }
  }
  function* closeReasoning() {
    if (reasonIdx !== null) { const e = w.end(reasonIdx); if (e) yield e; reasonIdx = null }
  }

  for await (const c of source) {
    if (!c || typeof c !== 'object') continue

    if (c.type === 'text-delta' && c.text) {
      // 文本开始 ⇒ 先关掉 reasoning 块
      yield* closeReasoning()
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
        yield* closeText()                            // 文本后再思考属异常，但仍按块切
        const s = w.start('reasoning')
        reasonIdx = s.index
        yield s
      }
      yield w.reasoning(reasonIdx, c.text)
      continue
    }

    if (c.type === 'tool-call-delta' || c.type === 'tool-call') {
      yield* closeText()
      yield* closeReasoning()
      const calls = Array.isArray(c.calls) ? c.calls : []
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i] ?? {}
        const fn = call.function ?? {}
        // OpenAI 用 index 关联同一调用的多个增量；非流式整包里没有 index ⇒ 按数组位次
        const key = Number.isSafeInteger(call.index) ? call.index : (calls.length === 1 ? 0 : i)
        let idx = callBlocks.get(key)
        if (idx === undefined) {
          const s = w.start('tool-call', { id: call.id, name: fn.name ?? call.name })
          idx = s.index
          callBlocks.set(key, idx)
          sawToolCalls = true
          yield s
        }
        const argsDelta = c.type === 'tool-call'
          ? String(fn.arguments ?? call.arguments ?? '')
          : String(fn.arguments ?? '')
        yield w.toolCall(idx, { id: call.id, name: fn.name ?? call.name, argumentsDelta: argsDelta })
      }
      continue
    }

    if (c.type === 'usage' && c.usage) { usage = c.usage; continue }

    if (c.type === 'finish') {
      finished = true
      if (c.usage && !usage) usage = c.usage
      // 关闭所有未结束的块
      for (const e of w.closeAll()) yield e
      textIdx = null; reasonIdx = null; callBlocks.clear()
      if (usage) { yield usageChunk(usage); usage = null }
      yield finishChunk(c.reason?.kind, c.replayState, sawToolCalls)
      return
    }
  }

  // 流意外结束：仍要发完整终止序列
  for (const e of w.closeAll()) yield e
  if (usage) yield usageChunk(usage)
  if (!finished) yield finishChunk(null, undefined, sawToolCalls)
}
