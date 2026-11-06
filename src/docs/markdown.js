/**
 * 极简 Markdown → HTML 渲染器（零依赖）
 *
 * 为什么自己写：宿主环境没有 pandoc / markdown 包，且插件纪律禁止第三方依赖
 * （`test/ci-static.sh` 会拦）。需要的子集很小：标题 / 段落 / 列表 / 表格 /
 * 代码块 / 行内码 / 粗体 / 链接 / 引用 / 分隔线。
 *
 * 🔴 安全：**所有**文本都先过 escapeHtml，再放行白名单内的结构标签；
 *    绝不用 `innerHTML` 式"信任原文"。文档里出现 `<script>` 只会被显示成文字。
 *
 * @module cs-myfree/docs/markdown
 */

/** HTML 转义（先做这一步，再加结构标签） */
export function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * 行内语法：行内码 → 粗体 → 斜体 → 链接。
 * 顺序有讲究：先处理行内码（里面不该再被解析），且用占位符保护，
 * 否则 `` `a*b` `` 会被当成斜体。
 */
function inline(text) {
  const codes = []
  // ① 行内码先抽出来占位（含内容原样保留，只做转义）
  let s = String(text ?? '').replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`)
    return `\u0000CODE${codes.length - 1}\u0000`
  })
  s = escapeHtml(s)
  // ② 粗体 / 斜体
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  // ③ 链接 [文字](url)——只放行 http(s)，其它协议一律不生成 <a>
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const safe = /^https?:\/\//i.test(url) ? url : null
    if (!safe) return m
    return `<a href="${escapeHtml(safe)}" rel="noreferrer noopener" target="_blank">${label}</a>`
  })
  // ④ 还原行内码
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codes[Number(i)] ?? '')
  return s
}

/** 表格行判断：`| a | b |` */
function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line)
}
/** 表格分隔行：`|---|:--:|` */
function isTableSep(line) {
  return /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes('-')
}
function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}

/**
 * 渲染 Markdown 为 HTML 片段。
 * @param {string} md
 * @returns {string}
 */
export function renderMarkdown(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // ── 代码块 ──
    if (/^\s*```/.test(line)) {
      const lang = line.trim().slice(3).trim()
      const buf = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++ }
      i++ // 跳过结束围栏
      out.push(`<pre><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>`)
      continue
    }

    // ── 表格 ──
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line)
      i += 2
      const rows = []
      while (i < lines.length && isTableRow(lines[i])) { rows.push(splitRow(lines[i])); i++ }
      const th = head.map((h) => `<th>${inline(h)}</th>`).join('')
      const tb = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')
      out.push(`<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`)
      continue
    }

    // ── 标题 ──
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const lv = h[1].length
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`)
      i++
      continue
    }

    // ── 分隔线 ──
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { out.push('<hr>'); i++; continue }

    // ── 引用 ──
    if (/^\s*>\s?/.test(line)) {
      const buf = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`)
      continue
    }

    // ── 列表（有序 / 无序，支持一层缩进嵌套）──
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      out.push(renderList(lines, () => i, (v) => { i = v }))
      continue
    }

    // ── 空行 ──
    if (!line.trim()) { i++; continue }

    // ── 段落（连续非空行合并；表格/标题等会打断）──
    const buf = []
    while (
      i < lines.length && lines[i].trim() &&
      !/^\s*(```|#{1,6}\s|>|[-*+]\s|\d+\.\s|---|\*\*\*)/.test(lines[i]) &&
      !isTableRow(lines[i])
    ) { buf.push(lines[i]); i++ }
    if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`)
    else { out.push(`<p>${inline(line)}</p>`); i++ }
  }

  return out.join('\n')
}

/** 列表渲染：返回 HTML，并把游标推过整个列表 */
function renderList(lines, getI, setI) {
  let i = getI()
  const startLine = lines[i]
  const ordered = /^\s*\d+\.\s+/.test(startLine)
  const items = []

  while (i < lines.length) {
    const line = lines[i]
    const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line)
    if (!m) break
    const indent = m[1].length
    if (indent >= 2 && items.length > 0) {
      // 嵌套：把这一行挂到上一项后面（支持一层）
      items[items.length - 1].sub = items[items.length - 1].sub || []
      items[items.length - 1].sub.push(m[3])
      i++
      continue
    }
    items.push({ text: m[3], sub: null })
    i++
  }
  setI(i)

  const body = items.map((it) => {
    const inner = it.sub && it.sub.length
      ? `<ul>${it.sub.map((s) => `<li>${inline(s)}</li>`).join('')}</ul>`
      : ''
    return `<li>${inline(it.text)}${inner}</li>`
  }).join('')
  const tag = ordered ? 'ol' : 'ul'
  return `<${tag}>${body}</${tag}>`
}

/** 页面外壳（移动端优先：视口 + 大字号 + 横向可滚表格） */
export function wrapHtml({ title = '文档', body = '', nav = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:14px 16px calc(28px + env(safe-area-inset-bottom));
  font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  max-width:900px;margin-inline:auto;color:#1a1a1a;background:#fff;-webkit-text-size-adjust:100%}
@media (prefers-color-scheme:dark){body{color:#e6e6e6;background:#1b1b1b}
  a{color:#6cb6ff}code{background:#2a2a2a}pre{background:#111;border-color:#333}
  th{background:#242424}tr:nth-child(even) td{background:#212121}blockquote{border-color:#444;color:#bbb}}
h1{font-size:1.45em;border-bottom:2px solid #e5e5e5;padding-bottom:.3em;margin:1.1em 0 .5em}
h2{font-size:1.25em;border-bottom:1px solid #eee;padding-bottom:.25em;margin:1.1em 0 .5em}
h3{font-size:1.1em;margin:1em 0 .4em}
p{margin:.65em 0}
a{color:#0969da;text-decoration:none;word-break:break-word}
code{background:#f0f0f0;padding:.12em .4em;border-radius:4px;font-size:.9em;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word}
pre{background:#f6f8fa;border:1px solid #e5e5e5;border-radius:8px;padding:12px;overflow-x:auto;-webkit-overflow-scrolling:touch}
pre code{background:none;padding:0;font-size:.85em;white-space:pre}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:.9em 0}
table{border-collapse:collapse;min-width:100%;font-size:.92em}
th,td{border:1px solid #ddd;padding:7px 10px;text-align:left;vertical-align:top}
th{background:#f6f8fa;font-weight:600;white-space:nowrap}
tr:nth-child(even) td{background:#fafafa}
blockquote{margin:.9em 0;padding:.3em 0 .3em 1em;border-left:4px solid #ddd;color:#555}
ul,ol{padding-left:1.5em;margin:.6em 0}
li{margin:.28em 0}
hr{border:none;border-top:1px solid #e5e5e5;margin:1.6em 0}
.nav{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px;padding:10px;border-radius:10px;background:rgba(127,127,127,.10)}
.nav a{padding:7px 13px;border-radius:8px;background:rgba(127,127,127,.14);font-size:.9em}
.nav a.on{background:#0969da;color:#fff}
.empty{padding:40px 0;text-align:center;color:#888}
</style></head>
<body>${nav}${body || '<div class="empty">（空文档）</div>'}</body></html>`
}