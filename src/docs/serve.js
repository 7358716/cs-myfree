/**
 * 文档服务（只读）：把本机 Markdown 通过 /cs-myfree/docs/ 暴露
 *
 * 为什么放在 cs-myfree 里而不是独立插件：宿主 profile 的 node_modules 在本机
 * 是**不可写**的（沙箱 + 权限），新插件挂不上去；cs-myfree 已经在 profile 里，
 * 加一条 prefix 路由即可，不需要动 profile。
 *
 * 🔴 安全边界（与独立插件版一致）：
 *   1. 只读 allowDirs 白名单目录；路径 resolve 后做**边界校验**（越界 403）
 *   2. 只提供 .md/.markdown；渲染器全量转义 HTML
 *   3. 默认只放行本机 + trustedHosts
 *
 * @module cs-myfree/docs/serve
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, sep, basename } from 'node:path'
import { renderMarkdown, wrapHtml, escapeHtml } from './markdown.js'

export const DOCS_PREFIX = '/docs'
const MAX_BYTES = 2 * 1024 * 1024

/**
 * 解析并校验请求路径 → 绝对路径；越界/不合法返回 null。
 * @param {string} docsRoot 已 resolve 的根目录
 * @param {string} urlPath 形如 `/cs-myfree/docs/a.md`（prefix 已剥离前的完整 path）
 * @param {string} [prefix] 完整前缀（默认 `/cs-myfree/docs`）
 */
export function resolveDocPath(docsRoot, urlPath, prefix = `/cs-myfree${DOCS_PREFIX}`) {
  try {
    let p = String(urlPath ?? '').split('?')[0].split('#')[0]
    if (p === prefix || p === prefix + '/') return docsRoot
    if (!p.startsWith(prefix + '/')) return null
    p = p.slice(prefix.length + 1)
    try { p = decodeURIComponent(p) } catch { return null }
    if (p.includes('\0')) return null
    const target = resolve(docsRoot, p)
    if (target !== docsRoot && !target.startsWith(docsRoot + sep)) return null
    return target
  } catch { return null }
}

function renderListing(entries) {
  const items = entries.map((e) => {
    const href = `/cs-myfree${DOCS_PREFIX}/${e.rel}`
    if (e.isDir) return `<li>📁 <a href="${href}/">${escapeHtml(e.name)}/</a></li>`
    const size = e.size >= 1024 ? `${(e.size / 1024).toFixed(1)} KB` : `${e.size} B`
    const when = e.mtime ? new Date(e.mtime).toLocaleString('zh-CN', { hour12: false }) : ''
    return `<li>📄 <a href="${href}">${escapeHtml(e.name)}</a> <span style="opacity:.6;font-size:.85em">${size}${when ? ' · ' + escapeHtml(when) : ''}</span></li>`
  }).join('')
  return `<h1>文档</h1><p style="opacity:.7;font-size:.92em">服务器上的 Markdown 文档（只读）。点开即可在手机上阅读。</p>
<ul>${items || '<li style="opacity:.6">（这个目录是空的）</li>'}</ul>`
}

/**
 * 创建文档请求处理器。
 * @param {{docsRoot:string, allowDirs?:string[], trustedHosts?:string[], log?:object}} o
 * @returns {(req:object, res:object)=>Promise<void>}
 */
export function createDocsHandler({ docsRoot = '/home/ubuntu/output2026/butlers/dev/design', allowDirs = null, trustedHosts = [], log = console } = {}) {
  let root
  try { root = resolve(docsRoot) } catch { root = null }
  const allowed = (Array.isArray(allowDirs) && allowDirs.length ? allowDirs : [docsRoot])
    .map((d) => { try { return resolve(d) } catch { return null } }).filter(Boolean)
  const inAllow = (abs) => allowed.some((a) => abs === a || abs.startsWith(a + sep))

  const hostOk = (req) => {
    const h = String(req?.headers?.host ?? '').toLowerCase()
    if (!h) return true
    const bare = h.split(':')[0]
    if (['localhost', '127.0.0.1', '::1'].includes(bare)) return true
    if (!Array.isArray(trustedHosts) || trustedHosts.length === 0) return true
    return trustedHosts.some((t) => String(t).toLowerCase() === h || String(t).toLowerCase() === bare)
  }

  const send = (res, code, body) => {
    try {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    } catch { /* 连接已断 */ }
  }
  const page = (t, b, nav = '') => wrapHtml({ title: t, body: b, nav })

  return async function docsHandler(req, res) {
    try {
      if (!root) return send(res, 500, page('500', '<h1>500</h1><p>文档根目录配置非法。</p>'))
      if (!hostOk(req)) return send(res, 403, page('403', '<h1>403</h1><p>该 Host 不在信任清单里。</p>'))
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, page('405', '<h1>405</h1><p>只支持 GET。</p>'))
      }
      const target = resolveDocPath(root, String(req.url ?? '/'))
      if (!target) return send(res, 403, page('403', '<h1>403</h1><p>路径不合法（越界或不存在）。</p>'))
      if (!inAllow(target)) return send(res, 403, page('403', '<h1>403</h1><p>该路径不在允许的文档目录内。</p>'))

      let st
      try { st = await stat(target) } catch { return send(res, 404, page('404', '<h1>404</h1><p>没有这个文档。</p>')) }

      if (st.isDirectory()) {
        let names = []
        try { names = await readdir(target) } catch { names = [] }
        const entries = []
        for (const nm of names.sort()) {
          if (nm.startsWith('.')) continue
          const abs = join(target, nm)
          if (!inAllow(abs)) continue
          try {
            const s2 = await stat(abs)
            if (s2.isDirectory()) entries.push({ name: nm, rel: encodeURIComponent(nm), isDir: true })
            else if (/\.(md|markdown)$/i.test(nm)) {
              entries.push({ name: nm, rel: encodeURIComponent(nm), isDir: false, size: s2.size, mtime: s2.mtimeMs })
            }
          } catch { /* 跳过读不到的 */ }
        }
        return send(res, 200, page('文档', renderListing(entries)))
      }

      if (!/\.(md|markdown)$/i.test(target)) {
        return send(res, 403, page('403', '<h1>403</h1><p>只提供 Markdown 文档。</p>'))
      }
      if (st.size > MAX_BYTES) {
        return send(res, 413, page('413', '<h1>413</h1><p>文档太大（>2MB）。</p>'))
      }
      const md = await readFile(target, 'utf8')
      const title = basename(target).replace(/\.(md|markdown)$/i, '')
      const nav = '<div class="nav"><a href="/cs-myfree/docs/">📁 全部文档</a></div>'
      return send(res, 200, page(title, renderMarkdown(md), nav))
    } catch (err) {
      try { log?.warn?.(`docs 处理失败：${err?.message ?? err}`) } catch { /* 忽略 */ }
      return send(res, 500, page('500', '<h1>500</h1><p>渲染失败，详见服务端日志。</p>'))
    }
  }
}
