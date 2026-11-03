/**
 * cs-myfree — 本地路由安全围栏
 *
 * 🔴 为什么必须有（安全性核心）：
 *   本插件注册的路由在**宿主 /api 之前**匹配。若不加围栏，
 *   任何能访问 Web 端口的人都能调用 —— 而 DSH 常被部署在公网
 *   （通过反向代理暴露到公网是常见做法）。
 *
 * 🔴 v1.7.1 修复（生产实测的**认证绕过漏洞**，与 cs-guard v1.8.0 同源）：
 *   旧实现第 ③ 条是「Cookie 里出现 `dsh-auth-` 前缀就放行」，**完全不验签**。
 *   生产实测：`Cookie: dsh-auth-forged` + 公网 Host ⇒ /cs-myfree/state 返回 200，
 *   等于任何外部人都能读**并写**本插件配置（/config、/scope、/chain、/channels/save）。
 *   注意生产是 nginx 反代 ⇒ `remoteAddress` 恒为 127.0.0.1，只看地址也挡不住。
 *
 *   正确判据（与 cs-guard v1.8.0 对齐）：
 *     ① Origin 同源（防 CSRF）
 *     ② **回环 + localhost** 直连（本机管理员）→ 放行
 *     ③ 其余一律**委托宿主 connection 服务的真实会话校验**
 *        （`connection.requestRejection(req)`：验 HMAC 签名 + 可信 Host + 会话）
 *     ④ 拿不到 connection 服务 ⇒ **fail-closed 拒绝**（绝不按 cookie 名放行）
 *
 * @module cs-myfree/web/guard
 */

/** 是否回环地址 */
export function isLoopbackAddr(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
    || (typeof addr === 'string' && addr.startsWith('127.'))
}

/** 从 Host 头取主机名（正确剥掉 IPv6 的方括号与端口） */
export function hostNameOf(host) {
  if (typeof host !== 'string') return ''
  const h = host.trim()
  if (h === '') return ''
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return (end > 0 ? h.slice(1, end) : h.slice(1)).toLowerCase()
  }
  return h.split(':')[0].toLowerCase()
}

/** Host 头是否本地 */
export function isLocalHostHeader(host) {
  const name = hostNameOf(host)
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}

/** Host 头是否在可信清单里 */
export function isTrustedHostHeader(host, trustedHosts = []) {
  const list = Array.isArray(trustedHosts) ? trustedHosts : []
  if (list.length === 0) return false
  const h = String(host || '').toLowerCase()
  const name = hostNameOf(host)
  return list.some((t) => {
    const tt = String(t ?? '').toLowerCase()
    if (tt === '') return false
    return tt === h || hostNameOf(tt) === name
  })
}

/**
 * 仅作「是否带 cookie」的**诊断信号**。
 *
 * ⚠️ **绝不能**用它做放行判据 —— cookie 名可以随便伪造（v1.7.0 漏洞的根源）。
 */
export function hasAuthCookie(req) {
  const cookie = (req?.headers && req.headers.cookie) || ''
  return /(?:^|;\s*)dsh-auth-/.test(cookie)
}

/** 安全地从宿主拿 connection 服务（拿不到返回 null，不抛） */
export function safeGetConnection(getConnection) {
  try {
    const c = typeof getConnection === 'function' ? getConnection() : getConnection
    return c && typeof c.requestRejection === 'function' ? c : null
  } catch {
    return null
  }
}

/**
 * 委托宿主做**真实**会话校验。
 * @returns {{ok:true}|{ok:false, reason:string, status:number}}
 */
export function verifySession(req, conn) {
  try {
    const rejection = conn.requestRejection(req)
    if (rejection === undefined || rejection === null || rejection === 0) return { ok: true }
    const status = rejection === 401 ? 401 : 403
    return {
      ok: false,
      status,
      reason: status === 401 ? 'invalid-or-missing-session' : 'untrusted-authority-or-forbidden',
    }
  } catch {
    return { ok: false, status: 403, reason: 'auth-check-failed' }
  }
}

/**
 * 判定一个请求是否放行。
 *
 * @param {any} req
 * @param {{trustedHosts?:string[], getConnection?:(()=>any)|any, connection?:any}} [opts]
 * @returns {{ok:boolean, reason?:string, status?:number}}
 */
export function judge(req, { trustedHosts = [], getConnection, connection } = {}) {
  const hostHeader = req?.headers && req.headers.host
  const origin = req?.headers && req.headers.origin

  // ① Origin 同源（防 CSRF）—— 放在最前，命中即拒
  if (typeof origin === 'string' && origin !== '') {
    let originHost = null
    try { originHost = new URL(origin).host } catch { originHost = null }
    if (originHost !== hostHeader) return { ok: false, status: 403, reason: 'cross-origin' }
  }

  const addr = req?.socket && req.socket.remoteAddress

  // ② 直连本地（不经代理）→ 放行（本机管理员；Host 必须是 localhost）
  if (isLoopbackAddr(addr) && isLocalHostHeader(hostHeader)) {
    return { ok: true }
  }

  // ③ 其余：必须由宿主 connection 服务做真实校验（签名/cookie 有效性/可信 Host）
  const conn = safeGetConnection(getConnection ?? connection)
  if (conn) return verifySession(req, conn)

  // ④ fail-closed：拿不到宿主校验能力时**绝不**按 cookie 名放行
  if (hasAuthCookie(req)) return { ok: false, status: 403, reason: 'auth-unverifiable' }
  return {
    ok: false,
    status: 403,
    reason: isLoopbackAddr(addr) ? 'proxied-without-auth' : 'external-without-auth',
  }
}

/** 统一 JSON 响应（带 no-store，防缓存泄漏） */
export function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** 对外错误文本统一脱敏（绝不让 URL 里的凭据/token 进日志或响应） */
export function redactText(input) {
  let s = String(input ?? '')
  try {
    s = s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    s = s.replace(/([?&](?:token|access_token|refresh_token|api[_-]?key|apikey|key|secret|password|securitytoken|security_token)=)[^&\s"']+/gi, '$1***')
    s = s.replace(/\b(Bearer|Basic|SDK-HMAC-SHA256)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***')
    s = s.replace(/\b(sk|pk|AKID)[-_A-Za-z0-9]{8,}/g, '***')
  } catch { /* 保底不抛 */ }
  return s
}

/** 对外错误文本统一脱敏 + 截断 */
export function safeErrorText(err, max = 200) {
  try {
    const s = typeof err === 'string' ? err : String(err?.message ?? err)
    return redactText(s).slice(0, max)
  } catch {
    return '未知错误'
  }
}

export const __internal = { isLoopbackAddr, isLocalHostHeader, isTrustedHostHeader, hasAuthCookie, hostNameOf }
