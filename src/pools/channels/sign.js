/**
 * cs-myfree — 华为云 SDK-HMAC-SHA256 请求签名（零依赖，只用 node:crypto）
 *
 * 用途：codearts 渠道的推理网关（snap-access.cn-north-4）**不接受 Bearer**，
 * 必须用 AK/SK（+ 可选 securityToken）做 SDK-HMAC-SHA256 签名。
 *
 * 算法（对拍参考实现 dsh-codearts-auth@1.10.261021 `lib/sign.js:19-51`）：
 *   1. uri = pathname，末尾补 '/'
 *   2. dateStamp = YYYYMMDDTHHMMSSZ
 *   3. payloadHash = sha256hex(body)
 *   4. canonicalRequest = METHOD\nURI\nQUERY\n<head:value 行>\n\n<SignedHeaders 分号列表>\n<payloadHash>
 *   5. stringToSign = "SDK-HMAC-SHA256\n" + dateStamp + "\n" + sha256hex(canonicalRequest)
 *   6. signature = HMAC-SHA256(SK, stringToSign) → 小写 hex
 *   7. Authorization: SDK-HMAC-SHA256 Access=<AK>,SignedHeaders=<h1;h2>,Signature=<hex>
 *
 * 🔴 实测坑（本机决定版，2026-11-03）：
 *    参考实现把 `content-type` 放进 SignedHeaders，在本机这个网关**恒定 401**
 *    （`APIG.0301 verify ak sk signature fail`）；**去掉 content-type 才验签通过**
 *    （3 种形态 × 2 轮一致，见 /tmp/probe-matrix.mjs）。
 *    content-type 仍照常**发送**，只是不参与签名。
 *
 * ⚠️ 安全纪律：AK/SK 只在内存中参与计算；本模块不读文件、不打印、不落盘。
 *
 * @module cs-myfree/pools/channels/sign
 */

import { createHash, createHmac } from 'node:crypto'

/** sha256 十六进制小写 */
export function sha256hex(data) {
  return createHash('sha256').update(data ?? '', 'utf8').digest('hex')
}

/** SDK 时间戳：YYYYMMDDTHHMMSSZ */
export function sdkDateStamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/** 规范化 query（按 key 字典序，保留原始编码语义） */
export function canonicalQuery(searchParams) {
  const pairs = []
  if (searchParams) for (const [k, v] of searchParams.entries()) pairs.push([k, v])
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
}

/**
 * 构造 canonicalRequest。
 * @param {{method:string, uri:string, query?:string, headers:Record<string,string>, signedHeaders:string[], payloadHash:string}} o
 */
export function buildCanonicalRequest({ method, uri, query = '', headers = {}, signedHeaders = [], payloadHash = '' }) {
  const headerLines = signedHeaders.map((h) => `${h}:${String(headers[h] ?? '').trim()}`).join('\n')
  return [method.toUpperCase(), uri, query, headerLines, '', signedHeaders.join(';'), payloadHash].join('\n')
}

/**
 * 签名一个华为云请求。
 *
 * @param {object} o
 * @param {string} o.ak  access key id
 * @param {string} o.sk  secret access key
 * @param {string} [o.securityToken] 临时凭证的 security token（可选）
 * @param {string} o.method HTTP 方法
 * @param {string} o.url 完整 URL
 * @param {string|Uint8Array} [o.body] 请求体（GET 传空）
 * @param {Record<string,string>} [o.signedExtraHeaders] 额外**参与签名**的头（如 maas_type）
 * @param {Date} [o.now] 注入时间（测试用）
 * @returns {{authorization:string, headers:Record<string,string>, signedHeaders:string[], canonicalRequest:string, stringToSign:string}}
 */
export function signHuaweiRequest({ ak, sk, securityToken, method = 'POST', url, body = '', signedExtraHeaders, now = new Date() }) {
  if (!ak || !sk) {
    throw Object.assign(new Error('codearts 需要 AK/SK（当前凭据不完整）'), { code: 'AUTH' })
  }
  const u = new URL(String(url))
  let uri = u.pathname || '/'
  if (!uri.endsWith('/')) uri += '/'
  const query = canonicalQuery(u.searchParams)
  const dateStamp = sdkDateStamp(now)
  const payloadHash = sha256hex(typeof body === 'string' ? body : Buffer.from(body ?? '').toString('utf8'))

  // 参与签名的头：host / x-sdk-date / x-sdk-content-sha256 / x-security-token (+ 显式 extra)
  // ⚠️ content-type 刻意不在此列（见文件头「实测坑」）
  const signed = { host: u.host, 'x-sdk-date': dateStamp, 'x-sdk-content-sha256': payloadHash }
  if (securityToken) signed['x-security-token'] = String(securityToken)
  if (signedExtraHeaders && typeof signedExtraHeaders === 'object') {
    for (const [k, v] of Object.entries(signedExtraHeaders)) signed[String(k).toLowerCase()] = String(v ?? '')
  }
  const signedHeaders = Object.keys(signed).sort()
  const canonicalRequest = buildCanonicalRequest({ method, uri, query, headers: signed, signedHeaders, payloadHash })
  const stringToSign = `SDK-HMAC-SHA256\n${dateStamp}\n${sha256hex(canonicalRequest)}`
  const signature = createHmac('sha256', String(sk)).update(stringToSign, 'utf8').digest('hex')
  const authorization = `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${signedHeaders.join(';')},Signature=${signature}`

  const outHeaders = {
    'x-sdk-date': dateStamp,
    'x-sdk-content-sha256': payloadHash,
    ...(securityToken ? { 'x-security-token': String(securityToken) } : {}),
  }
  return { authorization, headers: outHeaders, signedHeaders, canonicalRequest, stringToSign }
}
