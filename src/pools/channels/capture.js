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

  // ① JSON
  if (/^[[{]/.test(text)) {
    try {
      const obj = JSON.parse(text)
      const found = findKey(obj)
      if (found) return { ok: true, credential: found.value, kind: 'json', extra: { field: found.key } }
      return { ok: false, error: 'JSON 里没找到 token / code 字段' }
    } catch { /* 不是合法 JSON，继续 */ }
  }

  // ② URL 或查询串
  let qs = null
  try {
    if (/^https?:\/\//i.test(text)) qs = new URL(text).searchParams
    else if (text.includes('=') && !text.includes(' ')) qs = new URLSearchParams(text)
  } catch { /* ignore */ }

  if (qs) {
    for (const k of KEY_NAMES) {
      const v = qs.get(k)
      if (v && v.length >= 6) return { ok: true, credential: v, kind: 'url', extra: { field: k } }
    }
    // 大小写不敏感再找一遍
    for (const [k, v] of qs.entries()) {
      if (KEY_NAMES.some((n) => n.toLowerCase() === k.toLowerCase()) && v.length >= 6) {
        return { ok: true, credential: v, kind: 'url', extra: { field: k } }
      }
    }
    return { ok: false, error: '链接里没找到 code / token 参数' }
  }

  // ③ 裸凭证（长度够就当 token）
  if (text.length >= 8 && !/\s/.test(text)) {
    return { ok: true, credential: text, kind: 'raw' }
  }

  return { ok: false, error: '识别不出来。可以粘贴完整回调链接，或直接粘贴 token' }
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
