/**
 * cs-myfree — 失败码翻译（治「UNKNOWN 失明」）
 *
 * 设计依据：v3 §3.3。现状问题（实测）：第三方错误码一律被归一成 UNKNOWN，
 * 账本 36.7% 失明 ⇒ 无法决定「该重试还是该换渠道」。
 *
 * 分层（v3 §3.3 两条硬约束）：
 *  · 本模块只做「错误 → 语义」的翻译，**不决定重试**
 *  · 重试白名单在 adapter 的 providerRetryPolicy()，**刻意排除 RATE_LIMIT**
 *    （该车道 429 带递增 retry-after，重试会把一次配额墙变三次墙）
 *
 * @module cs-myfree/adapter/failure-map
 */

/** 失败语义（对齐 v3 的 FailureKind 设计） */
export const KIND = Object.freeze({
  AUTH: 'AUTH',
  QUOTA: 'QUOTA',
  RATE_LIMIT: 'RATE_LIMIT',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  NOT_FOUND: 'NOT_FOUND',
  REGION_BLOCKED: 'REGION_BLOCKED',
  PERMISSION: 'PERMISSION',
  INVALID_REQUEST: 'INVALID_REQUEST',
  TIMEOUT: 'TIMEOUT',
  TRANSPORT: 'TRANSPORT',
  SERVER: 'SERVER',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  UNKNOWN: 'UNKNOWN',
})

/** 这些是「短期不会自愈」的终态 ⇒ 拉黑该 provider/model */
export const TERMINAL = Object.freeze([
  KIND.AUTH, KIND.MODEL_NOT_FOUND, KIND.NOT_FOUND,
  KIND.REGION_BLOCKED, KIND.PERMISSION, KIND.INVALID_REQUEST,
])

/** 分级 TTL（毫秒）：QUOTA 是账号级临时耗尽，RATE_LIMIT 更短 */
export const TTL_MS = Object.freeze({
  [KIND.QUOTA]: 45 * 60 * 1000,
  [KIND.RATE_LIMIT]: 10 * 60 * 1000,
  [KIND.AUTH]: 6 * 3600 * 1000,
  [KIND.MODEL_NOT_FOUND]: 6 * 3600 * 1000,
  [KIND.NOT_FOUND]: 6 * 3600 * 1000,
  [KIND.REGION_BLOCKED]: 6 * 3600 * 1000,
  [KIND.PERMISSION]: 6 * 3600 * 1000,
  [KIND.INVALID_REQUEST]: 6 * 3600 * 1000,
})
export const DEFAULT_TTL_MS = 6 * 3600 * 1000

/**
 * 文本规则优先于状态码（v3 §3.3：文本赢语义）。
 * ⚠️ 刻意不按「5xx 的消息文本」判定（反向代理对 503 说的 reason phrase
 *    就是 "Service Unavailable"，读它会把好模型摘掉）。
 */
/**
 * ⚠️ 陷阱：JS 正则的 `\b` 只认 \`[A-Za-z0-9_]\` 为词字符，**汉字不是**，
 * 所以 `\b(额度)` 在字符串开头**永远不匹配**。故 ASCII 词用 \b 包裹、
 * 中文词单独成组（不加 \b）—— 由 buildRule() 统一拼装。
 */
function buildRule(asciiWords, cjkWords) {
  const parts = []
  if (asciiWords.length) parts.push(`\\b(?:${asciiWords.join('|')})\\b`)
  if (cjkWords.length) parts.push(`(?:${cjkWords.join('|')})`)
  return new RegExp(parts.join('|'), 'i')
}

const TEXT_RULES = [
  [buildRule(['quota', 'insufficient', 'no credit'], ['余额不足', '额度', '积分不足']), KIND.QUOTA],
  [buildRule(['rate limit', 'too many requests'], ['限流', '请求过多']), KIND.RATE_LIMIT],
  [buildRule(['region', 'country'], ['地区', '区域']), KIND.REGION_BLOCKED],
  [buildRule(['invalid api key', 'unauthori[sz]ed', 'authentication'], ['凭证', '登录已失效', '未登录']), KIND.AUTH],
  [buildRule(['no such model', 'model not found', 'does not serve'], ['模型不存在']), KIND.MODEL_NOT_FOUND],
  [buildRule(['permission', 'forbidden'], ['无权', '权限']), KIND.PERMISSION],
]

/** 状态码兜底（仅当没有文本规则命中时才用） */
const STATUS_RULES = [
  [401, KIND.AUTH], [402, KIND.QUOTA], [403, KIND.PERMISSION],
  [404, KIND.MODEL_NOT_FOUND], [429, KIND.RATE_LIMIT],
  [408, KIND.TIMEOUT], [425, KIND.TIMEOUT],
]

/**
 * 把一次失败翻译成语义。
 * @param {{message?:string, code?:string, status?:number, cause?:any}} err
 * @returns {{kind:string, ttlMs:number, retryable:boolean}}
 */
export function classify(err = {}) {
  const msg = String(err.message ?? '')
  const code = String(err.code ?? '')

  // ① 文本规则优先
  for (const [re, kind] of TEXT_RULES) {
    if (re.test(msg)) return verdict(kind)
  }
  // ② 已知结构化码
  if (code === 'EMPTY_RESPONSE') return verdict(KIND.EMPTY_RESPONSE)
  if (/^(ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|UND_ERR)/.test(code)) return verdict(KIND.TRANSPORT)
  if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') return verdict(KIND.TIMEOUT)
  // ③ 状态码
  const status = Number(err.status)
  if (Number.isFinite(status)) {
    for (const [s, kind] of STATUS_RULES) if (status === s) return verdict(kind)
    if (status >= 500) return verdict(KIND.SERVER)
    if (status >= 400) return verdict(KIND.INVALID_REQUEST)
  }
  // ④ 传输层 cause 链
  const causeCode = err.cause?.code
  if (causeCode) return classify({ code: causeCode, message: msg })
  return verdict(KIND.UNKNOWN)
}

function verdict(kind) {
  return {
    kind,
    ttlMs: TTL_MS[kind] ?? DEFAULT_TTL_MS,
    retryable: !TERMINAL.includes(kind),
  }
}
