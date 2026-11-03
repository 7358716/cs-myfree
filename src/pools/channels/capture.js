/**
 * cs-myfree — 凭证自动捕获/解析
 *
 * 解决的痛点（主管反馈）：
 *   「需要手动复制授权码，还得去地址栏里找」 —— 太麻烦。
 *
 * 三种从易到难的方式，全部支持：
 *   ① **粘贴整段回调 URL**（最易）—— 插件自动从 URL 里抠出 code/token
 *   ② **粘贴 JSON / 整段响应**（次易）—— 自动找 access_token 等字段
 *   ③ **AK/SK 永久授权**（最稳）—— 一次配置永久有效，不用反复登录
 *
 * @module cs-myfree/pools/channels/capture
 */

/** 常见的凭证字段名（按优先级） */
const KEY_NAMES = [
  'access_token', 'accessToken', 'token', 'id_token', 'idToken',
  'code', 'auth_code', 'authCode', 'authorization_code',
  'api_key', 'apiKey', 'secret', 'session', 'sessionId',
  'AK', 'SK', 'ak', 'sk',
]

/**
 * 从用户粘贴的**任意文本**里提取凭证。
 *
 * 支持输入：
 *   · 完整回调 URL：https://x.com/cb?code=abc&state=1
 *   · 只有查询串：code=abc&state=1
 *   · JSON：{"access_token":"abc"}
 *   · 裸 token：abc123
 *
 * @returns {{ok:boolean, credential?:string, kind?:string, extra?:object, error?:string}}
 */
export function captureCredential(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, error: '没有内容' }

  // ① JSON（含 access_token / code 等字段）
  if (/^[[{]/.test(text)) {
    try {
      const obj = JSON.parse(text)
      const found = findKey(obj)
      if (found) return { ok: true, credential: found.value, kind: 'json', extra: { field: found.key } }
      return { ok: false, error: 'JSON 里没找到 token / code 字段' }
    } catch {
      return { ok: false, error: '看着像 JSON 但格式不对' }
    }
  }

  // ② URL 或查询串 —— **只认带凭证参数的**
  const isUrl = /^https?:\/\//i.test(text)
  const looksLikeQuery = !isUrl && /^[^\s]+=[^\s]*/.test(text) && text.includes('=')
  if (isUrl || looksLikeQuery) {
    let qs = null
    try {
      qs = isUrl ? new URL(text).searchParams : new URLSearchParams(text)
    } catch { /* URL 畸形 */ }
    if (!qs) return { ok: false, error: '链接格式不对' }

    for (const k of KEY_NAMES) {
      const v = qs.get(k)
      if (v && looksLikeCredential(v)) return { ok: true, credential: v, kind: 'url', extra: { field: k } }
    }
    for (const [k, v] of qs.entries()) {
      if (KEY_NAMES.some((n) => n.toLowerCase() === k.toLowerCase()) && looksLikeCredential(v)) {
        return { ok: true, credential: v, kind: 'url', extra: { field: k } }
      }
    }
    // 🔴 关键：URL 里没有凭证参数 ⇒ **明确拒绝**，绝不把整条 URL 当令牌
    return { ok: false, error: '这是普通网页地址，里面没有 code / token 参数。登录完成后要复制**跳转后**那条带 ?code= 的链接' }
  }

  // ③ 裸令牌 —— 必须通过形态校验
  if (looksLikeCredential(text)) return { ok: true, credential: text, kind: 'raw' }

  return { ok: false, error: '识别不出来。请粘贴带 ?code= 的回调链接，或一段令牌' }
}

/**
 * 🔑 判断一段文本**像不像**凭证（严格）。
 *
 * 血泪教训：之前只判断「长度 ≥ 8 且无空格」，
 * 结果 `https://www.baidu.com`（21 字符无空格）被当成令牌保存了。
 *
 * 严格规则：
 *  · 长度 8~4096
 *  · 不含空白
 *  · 不含 URL 特征（:// 或 http 开头或含 .com/.cn 这类域名）
 *  · 字符集限定为 token 常见字符（字母数字 + - _ . ~ + / = :）
 *  · 不能是纯自然语言单词（要有数字或符号，或足够长且混合大小写）
 *
 * ⚠️ 字符集必须含 `:`：AK/SK 渠道（codearts 等 9 家）的永久授权就是
 *    `AK:SK` 形态（下游 index.js/catalog.js 也按 `split(':')` 解析）。
 *    缺了它 = 这些渠道的「AK/SK 一步登录」100% 被拒（P0 缺陷）。
 */
export function looksLikeCredential(s) {
  const v = String(s ?? '').trim()
  if (v.length < 8 || v.length > 4096) return false
  if (/\s/.test(v)) return false
  // 排除 URL 与域名
  if (/^https?:\/\//i.test(v)) return false
  if (v.includes('://')) return false
  if (/^[a-z0-9.-]+\.(com|cn|net|org|io|sh|ai|dev|app)(\/|$)/i.test(v)) return false
  // 字符集
  if (!/^[A-Za-z0-9._~+/=:-]+$/.test(v)) return false
  // 纯字母单词（如 password）拒掉；真实 token 通常含数字或符号
  const hasDigit = /[0-9]/.test(v)
  const hasSymbol = /[._~+/=:-]/.test(v)
  const hasUpper = /[A-Z]/.test(v)
  const hasLower = /[a-z]/.test(v)
  if (!hasDigit && !hasSymbol) {
    // 纯字母：必须足够长且大小写混合（如 JWT 片段）
    return v.length >= 24 && hasUpper && hasLower
  }
  return true
}

/** 在对象里深度找凭证字段 */
function findKey(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null
  for (const k of KEY_NAMES) {
    if (typeof obj[k] === 'string' && obj[k].length >= 6) return { key: k, value: obj[k] }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const r = findKey(v, depth + 1)
      if (r) return r
    }
  }
  return null
}

/**
 * AK/SK 形式（永久授权）：拼成厂商要求的格式。
 * @param {{ak:string, sk:string, format?:string}} o
 * @returns {{ok:boolean, credential?:string, error?:string}}
 */
export function buildAkSk({ ak, sk, format = '{ak}:{sk}' } = {}) {
  const a = String(ak ?? '').trim()
  const s = String(sk ?? '').trim()
  if (!a || !s) return { ok: false, error: 'AK 和 SK 都要填' }
  return { ok: true, credential: format.replace('{ak}', a).replace('{sk}', s) }
}

/** 凭证脱敏预览（给 UI 显示"识别到 xxx"） */
export function previewCapture(result) {
  if (!result?.ok) return result?.error || '未能识别'
  const c = String(result.credential)
  const shown = c.length <= 10 ? '****' : `${c.slice(0, 4)}…${c.slice(-4)}`
  const fieldName = result.extra?.field ? `（字段 ${result.extra.field}）` : ''
  return `识别到 ${shown}${fieldName}，长度 ${c.length}`
}
