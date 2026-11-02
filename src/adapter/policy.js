/**
 * cs-myfree — 重试策略（宿主 providerRetryPolicy 的返回值）
 *
 * 设计依据：v3 §3.3 的两条硬约束，两条都有**事故实证**：
 *
 * ① 必须**扁平返回**，不能嵌套 backoff
 *    宿主把它**原样存储**而不经 resolver，嵌套会让所有延迟变 NaN
 *    ⇒ durable session log 拒绝 ⇒ 可恢复的瞬态故障升级成整轮 abort
 *
 * ② retryableCodes **必须刻意排除 RATE_LIMIT**
 *    该车道 429 带**递增 retry-after**，「两次自动重试把一次配额墙变三次墙」
 *    （ourfree Issue #13 实测）。区域拒绝同理：那是出口属性，不是瞬态。
 *
 * ③ 宿主 maxRetries 压到 **1**（11-01 事故实证：默认 5 会在同一坏源上
 *    打 19 次重试、烧 61 分钟）
 *
 * @module cs-myfree/adapter/policy
 */

/** 允许宿主自动重发的码（刻意只有 4 个） */
export const RETRYABLE_CODES = Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT'])

/**
 * 返回一个**已完全解析、扁平**的策略对象。
 * @param {{maxRetries?:number, initialDelayMs?:number, maxDelayMs?:number, jitterRatio?:number}} over
 */
export function providerRetryPolicy(over = {}) {
  return Object.freeze({
    mode: 'normal',
    // ⚠️ 默认 1（不是宿主的 5）——重试权收归降级链
    maxRetries: Number.isInteger(over.maxRetries) ? over.maxRetries : 1,
    // ⚠️ 刻意排除 RATE_LIMIT 与区域拒绝（见文件头）
    retryableCodes: RETRYABLE_CODES,
    // ⚠️ 扁平字段：嵌套 backoff 会让延迟变 NaN
    initialDelayMs: Number.isFinite(over.initialDelayMs) ? over.initialDelayMs : 500,
    maxDelayMs: Number.isFinite(over.maxDelayMs) ? over.maxDelayMs : 8_000,
    jitterRatio: Number.isFinite(over.jitterRatio) ? over.jitterRatio : 0.2,
  })
}

/** 断言：策略对象是扁平的（防回归） */
export function assertFlatPolicy(p) {
  const bad = []
  if (p && typeof p.backoff === 'object') bad.push('不得嵌套 backoff')
  for (const k of ['initialDelayMs', 'maxDelayMs', 'jitterRatio', 'maxRetries']) {
    if (!(k in (p ?? {}))) bad.push(`缺扁平字段 ${k}`)
  }
  if (Array.isArray(p?.retryableCodes) && p.retryableCodes.includes('RATE_LIMIT')) {
    bad.push('retryableCodes 不得含 RATE_LIMIT')
  }
  return { ok: bad.length === 0, problems: bad }
}
