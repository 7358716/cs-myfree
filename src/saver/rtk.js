/**
 * cs-myfree — 省 Token（RTK 工具输出压缩）
 *
 * 设计依据：v3 §10 + ourfree 实测三条**不可触碰边界**：
 *  1. 只压**工具输出**（不压用户输入、不压模型输出）
 *  2. **错误结果永不压缩** —— 藏起来模型会重试同一调用，用户为循环付费
 *  3. 替换必须**非空且严格更小**（否则等于没压却改了内容）
 *
 * 第三级（响应侧裁剪）**有意不做**：推理通道是被计量而非被消音。
 *
 * @module cs-myfree/saver/rtk
 */

export const MIN_SIZE = 500          // 下限：太小的不折腾
export const MAX_SIZE = 10 * 1024 * 1024
export const DETECT_WINDOW = 1024    // 检测窗口（O(1) 判定）

/**
 * 路径列表判定：必须是**像路径**的多行，不能把「一坨 xxx」误判成路径。
 * 判据：行数 > 20，且至少 60% 的行含 '/' 或以常见源码扩展名结尾。
 */
function isPathList(text) {
  const lines = text.split('\n').filter(Boolean)
  if (lines.length <= 20) return false
  const pathish = lines.filter((l) => l.includes('/') || /\.[a-z0-9]{1,6}$/i.test(l)).length
  return pathish / lines.length >= 0.6
}

/** 各形状的压缩器：返回 null 表示「不适用」，返回字符串表示压缩结果 */
const COMPRESSORS = [
  { id: 'git-diff', test: (t) => /^diff --git /m.test(t), fn: compressGitDiff },
  { id: 'git-status', test: (t) => /^(On branch |HEAD detached)/m.test(t) && /^\s*(modified|untracked|deleted):/m.test(t), fn: collapseRepeats },
  { id: 'git-log', test: (t) => /^commit [0-9a-f]{7,40}/m.test(t), fn: compressGitLog },
  { id: 'grep', test: (t) => /^[^\s:]+:\d+:/m.test(t), fn: compressGrep },
  { id: 'find-ls', test: isPathList, fn: compressPathList },
  { id: 'build-log', test: (t) => /\b(error|warning|info)\b.*\b\d+\b/i.test(t), fn: collapseRepeats },
]

/**
 * 压缩工具输出。
 * @param {string} text
 * @param {{kind?:string, isError?:boolean, maxBytes?:number}} opts
 * @returns {{text:string, applied:boolean, before:number, after:number, saved:number, compressor:string|null, reason?:string}}
 */
export function compressToolOutput(text, opts = {}) {
  const src = String(text ?? '')
  const before = Buffer.byteLength(src)
  const base = { text: src, applied: false, before, after: before, saved: 0, compressor: null }

  // 边界2：错误结果永不压缩
  if (opts.isError === true) return { ...base, reason: '错误结果不压缩（否则模型会重试同一调用）' }
  // 边界：太小不值得
  if (before < (opts.maxBytes ?? MIN_SIZE)) return { ...base, reason: '小于下限' }
  if (before > MAX_SIZE) return { ...base, reason: '超过上限（防内存爆炸）' }

  const head = src.slice(0, DETECT_WINDOW)
  const c = opts.kind
    ? COMPRESSORS.find((x) => x.id === opts.kind)
    : COMPRESSORS.find((x) => x.test(head))
  if (!c) return { ...base, reason: '无可匹配的压缩形状' }

  let out
  try { out = c.fn(src) } catch { return { ...base, reason: '压缩器异常' } }
  if (out == null) return { ...base, reason: '该形状不适用' }

  const after = Buffer.byteLength(out)
  // 边界3：必须非空且严格更小
  if (after === 0 || after >= before) return { ...base, reason: '压缩无收益（不改动）' }

  return { text: out, applied: true, before, after, saved: before - after, compressor: c.id }
}

function compressGitDiff(t) {
  // 保留文件头与 hunk 头，压缩上下文行
  const lines = t.split('\n')
  const out = []
  let ctxRun = 0
  for (const l of lines) {
    if (l.startsWith('diff --git') || l.startsWith('@@') || l.startsWith('+++') || l.startsWith('---')
      || l.startsWith('+') || l.startsWith('-') || l.startsWith('index ')) {
      if (ctxRun > 1) out.push(`  …（省略 ${ctxRun} 行上下文）`)
      ctxRun = 0
      out.push(l)
    } else {
      ctxRun++
      if (ctxRun <= 1) out.push(l)     // 只保留 1 行上下文
    }
  }
  if (ctxRun > 1) out.push(`  …（省略 ${ctxRun} 行上下文）`)
  return out.join('\n')
}

function compressGitLog(t) {
  const lines = t.split('\n')
  const out = []
  for (const l of lines) {
    if (/^commit [0-9a-f]{7,40}/.test(l)) out.push(l.slice(0, 60))
    else if (/^(Author|Date):/.test(l)) continue       // 大量重复且低信息
    else if (/^\s{4}/.test(l)) out.push(l)
  }
  return out.join('\n')
}

function compressGrep(t) {
  // 同文件多行只保留前 3 行 + 计数
  const byFile = new Map()
  for (const l of t.split('\n')) {
    const m = /^([^\s:]+):(\d+):/.exec(l)
    if (!m) continue
    if (!byFile.has(m[1])) byFile.set(m[1], [])
    byFile.get(m[1]).push(l)
  }
  const out = []
  for (const [file, ls] of byFile) {
    out.push(...ls.slice(0, 3))
    if (ls.length > 3) out.push(`${file}: …（另有 ${ls.length - 3} 处匹配）`)
  }
  return out.join('\n')
}

function compressPathList(t) {
  const paths = t.split('\n').filter(Boolean)
  if (paths.length <= 20) return null
  // 按首两层目录归并
  const by = new Map()
  for (const p of paths) {
    const key = p.split('/').slice(0, 3).join('/')
    by.set(key, (by.get(key) ?? 0) + 1)
  }
  const out = [...by.entries()].map(([k, n]) => `${k}/ (${n} 项)`)
  return out.length < paths.length ? out.join('\n') : null
}

function collapseRepeats(t) {
  const lines = t.split('\n')
  const out = []
  let prev = null
  let n = 0
  for (const l of lines) {
    if (l === prev) { n++; continue }
    if (n > 0) out.push(`  …（上一行重复 ${n} 次）`)
    out.push(l)
    prev = l
    n = 0
  }
  if (n > 0) out.push(`  …（上一行重复 ${n} 次）`)
  return out.length < lines.length ? out.join('\n') : null
}

/** 节省统计（口径：calls 记**跑过管线的请求数**，不是「省了字节的请求数」） */
export function createSavingsTracker() {
  let calls = 0, savedBytes = 0, beforeBytes = 0
  return {
    record(before, after) {
      calls++
      beforeBytes += before
      savedBytes += Math.max(0, before - after)
      return this
    },
    summary() {
      return {
        calls,
        savedBytes,
        beforeBytes,
        savedPercent: beforeBytes > 0 ? Number(((savedBytes / beforeBytes) * 100).toFixed(1)) : 0,
        // 明确区分「0 次调用」与「400 次调用省 0 字节」
        text: calls === 0 ? '尚未消耗' : `${calls} 次调用，省 ${savedBytes} 字节（${beforeBytes > 0 ? ((savedBytes / beforeBytes) * 100).toFixed(1) : 0}%）`,
      }
    },
  }
}
