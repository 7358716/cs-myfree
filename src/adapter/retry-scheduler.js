/**
 * cs-myfree — 自动重试调度器（仅针对「模型失败」）
 *
 * 设计依据：2026-11-13 定稿设计稿。
 *
 * 核心规则（用户确认）：
 *   · 重试**只针对模型失败**：SERVER / TIMEOUT / EMPTY_RESPONSE / TRANSPORT。
 *     终态失败（AUTH/QUOTA/PERMISSION/INVALID_REQUEST/MODEL_NOT_FOUND/…）**不**进入重试。
 *   · 重试间隔**可配置**，默认 30 分钟。
 *   · 每个失败条目最多重试 N 次（默认 3），超过标记「需人工介入」。
 *   · **不自动重启**：本调度器只更新「可用性/重试计划」，不发起新请求、不请求 DSH 重启。
 *
 * 本模块只做**纯函数**（无 I/O、无网络、无 console），便于表驱动单测。
 * 持久化（retry-plan.json）由调用方用 config/store.js 的原子写完成。
 *
 * @module cs-myfree/adapter/retry-scheduler
 */

import { RETRYABLE_KINDS, DEFAULT_RETRY_INTERVAL_MS, DEFAULT_MAX_RETRY_ATTEMPTS } from './model-chain.js'

/** 重试计划条目状态 */
export const RETRY_STATE = Object.freeze({
  PENDING: 'pending',     // 等待重试
  DUE: 'due',             // 已到重试时间
  EXHAUSTED: 'exhausted', // 超过最大次数，需人工
})

/**
 * 判断失败是否属于「可重试的模型失败」。
 * @param {string} kind failure-map.KIND
 * @param {string[]} kinds 可重试语义清单（默认 RETRYABLE_KINDS）
 * @returns {boolean}
 */
export function isModelFailure(kind, kinds = RETRYABLE_KINDS) {
  const list = Array.isArray(kinds) && kinds.length > 0 ? kinds : RETRYABLE_KINDS
  return list.includes(String(kind ?? ''))
}

/**
 * 创建一条重试计划（纯函数）。
 * @param {{provider:string, model:string, kind:string, at?:number, intervalMs?:number, maxAttempts?:number, attempt?:number}} o
 * @returns {object} 重试计划条目
 */
export function makeRetryPlan(o = {}) {
  const now = Number.isFinite(o?.at) ? o.at : Date.now()
  const intervalMs = Number.isFinite(o?.intervalMs) && o.intervalMs >= 0 ? o.intervalMs : DEFAULT_RETRY_INTERVAL_MS
  const maxAttempts = Number.isInteger(o?.maxAttempts) && o.maxAttempts > 0 ? o.maxAttempts : DEFAULT_MAX_RETRY_ATTEMPTS
  const attempt = Number.isInteger(o?.attempt) ? o.at : 1
  return {
    provider: o?.provider ?? null,
    model: o?.model ?? null,
    kind: o?.kind ?? null,
    attempt,
    maxAttempts,
    nextAt: now + intervalMs,
    intervalMs,
    state: RETRY_STATE.PENDING,
  }
}

/**
 * 登记一次失败：若可重试则返回新计划/更新计划，否则返回 null（不重试）。
 * @param {object} plan 已有计划（或 null）
 * @param {{provider:string, model:string, kind:string, at?:number, intervalMs?:number, maxAttempts?:number}} fail
 * @returns {object|null}
 */
export function registerFailure(plan, fail = {}) {
  if (!isModelFailure(fail?.kind)) return null   // 终态失败不重试
  const attempt = plan?.attempt ?? 0
  const maxAttempts = plan?.maxAttempts ?? (Number.isInteger(fail?.maxAttempts) && fail.maxAttempts > 0 ? fail.maxAttempts : DEFAULT_MAX_RETRY_ATTEMPTS)
  const nextAttempt = attempt + 1
  if (nextAttempt > maxAttempts) {
    // 超过上限：标记需人工，不再自动重试
    return {
      provider: fail?.provider ?? plan?.provider ?? null,
      model: fail?.model ?? plan?.model ?? null,
      kind: fail?.kind ?? plan?.kind ?? null,
      attempt: nextAttempt - 1,
      maxAttempts,
      nextAt: Number.isFinite(plan?.nextAt) ? plan.nextAt : Date.now(),
      intervalMs: plan?.intervalMs ?? DEFAULT_RETRY_INTERVAL_MS,
      state: RETRY_STATE.EXHAUSTED,
    }
  }
  const intervalMs = Number.isFinite(fail?.intervalMs) && fail.intervalMs >= 0 ? fail.intervalMs : (plan?.intervalMs ?? DEFAULT_RETRY_INTERVAL_MS)
  const at = Number.isFinite(fail?.at) ? fail.at : Date.now()
  return {
    provider: fail?.provider ?? plan?.provider ?? null,
    model: fail?.model ?? plan?.model ?? null,
    kind: fail?.kind ?? plan?.kind ?? null,
    attempt: nextAttempt,
    maxAttempts,
    nextAt: at + intervalMs,
    intervalMs,
    state: RETRY_STATE.PENDING,
  }
}

/**
 * 判断计划是否已到重试时间（纯函数）。
 * @param {object} plan
 * @param {number} now
 * @returns {boolean}
 */
export function isDue(plan, now = Date.now()) {
  if (!plan || plan.state === RETRY_STATE.EXHAUSTED) return false
  return Number.isFinite(plan.nextAt) && now >= plan.nextAt
}

/**
 * 从一组计划里挑出「已到重试时间」的（纯函数）。
 * @param {Array} plans
 * @param {number} now
 * @returns {Array}
 */
export function duePlans(plans = [], now = Date.now()) {
  return (Array.isArray(plans) ? plans : []).filter((p) => isDue(p, now))
}

/**
 * 把计划分组：pending / due / exhausted（供 UI 展示）。
 * @param {Array} plans
 * @param {number} now
 */
export function groupPlans(plans = [], now = Date.now()) {
  const out = { pending: [], due: [], exhausted: [] }
  for (const p of Array.isArray(plans) ? plans : []) {
    if (p?.state === RETRY_STATE.EXHAUSTED) out.exhausted.push(p)
    else if (isDue(p, now)) out.due.push(p)
    else out.pending.push(p)
  }
  return out
}

/**
 * 校验并归一化计划数组（纯函数，防脏数据）。
 * @param {Array} raw
 * @returns {Array}
 */
export function normalizePlans(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue
    if (!p.provider || !p.model) continue
    out.push({
      provider: String(p.provider),
      model: String(p.model),
      kind: p.kind ?? null,
      attempt: Number.isInteger(p.attempt) ? p.attempt : 1,
      maxAttempts: Number.isInteger(p.maxAttempts) && p.maxAttempts > 0 ? p.maxAttempts : DEFAULT_MAX_RETRY_ATTEMPTS,
      nextAt: Number.isFinite(p.nextAt) ? p.nextAt : Date.now(),
      intervalMs: Number.isFinite(p.intervalMs) && p.intervalMs >= 0 ? p.intervalMs : DEFAULT_RETRY_INTERVAL_MS,
      state: p.state === RETRY_STATE.EXHAUSTED ? RETRY_STATE.EXHAUSTED : RETRY_STATE.PENDING,
    })
  }
  return out
}