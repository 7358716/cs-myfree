/**
 * cs-myfree — 本地路由安全围栏
 *
 * 🔴 为什么必须有（安全性核心）：
 *   本插件注册的路由在**宿主 /api 之前**匹配。若不加围栏，
 *   任何能访问 Web 端口的人都能调用 —— 而 DSH 常被部署在公网
 *   （通过反向代理暴露到公网是常见做法）。
 *
 * 三层判据（与内核/本机已实战验证的同一套）：
 *   ① 来源必须是回环，**或者**（可信 Host + 已登录 cookie）
 *   ② Host 必须是 localhost 或显式配置的可信主机
 *   ③ Origin（若带）必须与 Host 同源（防 CSRF）
 *
 * @module cs-myfree/web/guard
 */

/** 是否回环地址 */
export function isLoopbackAddr(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
    || (typeof addr === 'string' && addr.startsWith('127.'))
}

/** Host 头是否本地 */
export function isLocalHostHeader(host) {
  if (typeof host !== 'string' || host === '') return false
  const name = host.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase()
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}

/** Host 头是否在可信清单里 */
export function isTrustedHostHeader(host, trustedHosts = []) {
  const list = Array.isArray(trustedHosts) ? trustedHosts : []
  if (list.length === 0) return false
  const h = String(host || '').toLowerCase()
  const name = h.split(':')[0].replace(/^\[|\]$/g, '')
  return list.some((t) => {
    const tt = String(t ?? '').toLowerCase()
    if (tt === '') return false
    return tt === h || tt.split(':')[0].replace(/^\[|\]$/g, '') === name
  })
}

/** 是否带登录 cookie（内核发的是 dsh-auth-<random>） */
export function hasAuthCookie(req) {
  const cookie = (req?.headers && req.headers.cookie) || ''
  return /(?:^|;\s*)dsh-auth-/.test(cookie)
}

/**
 * 判定一个请求是否放行。
 * @returns {{ok:boolean, reason?:string}}
 */
export function judge(req, { trustedHosts = [] } = {}) {
  const addr = req?.socket && req.socket.remoteAddress

  // ① 非回环 ⇒ 必须「可信 Host + 已登录」
  if (!isLoopbackAddr(addr)) {
    const host = req?.headers && req.headers.host
    if (!(isTrustedHostHeader(host, trustedHosts) && hasAuthCookie(req))) {
      return { ok: false, reason: 'external-without-auth' }
    }
  }

  // ② Host 校验（回环来源也要校验，防 DNS rebinding）
  const hostHeader = req?.headers && req.headers.host
  if (!isLocalHostHeader(hostHeader) && !isTrustedHostHeader(hostHeader, trustedHosts)) {
    return { ok: false, reason: 'unexpected-host' }
  }

  // ③ Origin 同源（防 CSRF）
  const origin = req?.headers && req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    let originHost = null
    try { originHost = new URL(origin).host } catch { originHost = null }
    if (originHost !== hostHeader) return { ok: false, reason: 'cross-origin' }
  }

  return { ok: true }
}

/** 统一 JSON 响应（带 no-store，防缓存泄漏） */
export function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}
