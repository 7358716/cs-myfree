/**
 * cs-myfree — 探测路由编排（P2 核心）
 *
 * 设计依据：2026-11-13 定稿设计稿。
 *
 * 职责：把「模型链 + 探测可用集合 + 授权」编排成一次路由决策，**纯函数、无 I/O**。
 * 实际的网络发送/记账由 adapter.stream() 的注入回调完成。
 *
 * 路由规则（用户确认）：
 *   1. 免费池优先、付费池兜底（paidAllowed=false 时付费池绝不进候选）。
 *   2. 只从「探测可用」集合里选（不再逐候选试错）。
 *   3. 池内按优先级（tier 升序）。
 *   4. 失败时：登记重试计划（仅模型失败），继续下一个可用候选。
 *   5. 全部失败：抛**详细错误**（列出每个渠道不可用 + 原因）。
 *
 * @module cs-myfree/adapter/probe-route
 */

import { normalizeModelChain, routeCandidates, groupByPool, entryKey } from './model-chain.js'
import { mergeAvailability, parseProbeCache, isProbeStale } from './probe.js'
import { registerFailure, isDue, RETRY_STATE } from './retry-scheduler.js'

/**
 * 构造一次路由决策（纯函数，不发请求）。
 *
 * @param {object} o
 * @param {object} o.chain 原始模型链（chain-overrides / model-chain 格式）
 * @param {object} o.probeCache 探测缓存（probe-cache.json 解析后的对象）
 * @param {boolean} o.paidAllowed 是否允许付费池
 * @param {number} [o.now]
 * @returns {{
 *   candidates: Array,          // 可用候选（已排序，free 在前）
 *   freeCount: number,
 *   paidCount: number,
 *   available: Set<string>,
 *   stale: boolean,             // 探测缓存是否过期（调用方据此决定是否重探）
 *   excluded: Array<{provider:string,model:string,reason:string}>,  // 被排除的条目+原因
 * }}
 */
export function planRoute(o = {}) {
  const chain = normalizeModelChain(o.chain)
  const cache = parseProbeCache(o.probeCache)
  const now = Number.isFinite(o.now) ? o.now : Date.now()
  const stale = isProbeStale(cache, now)

  // 可用集合：优先用缓存里的 available；为空时退化为「链里全部条目」（冷启动兜底）
  let available = cache.available
  if (available.size === 0) {
    available = new Set((chain.entries ?? []).map((e) => entryKey(e)))
  }

  const candidates = routeCandidates(chain, available, { paidAllowed: o.paidAllowed === true })
  const { free, paid } = groupByPool(chain)

  // 被排除的条目（不可用 / 付费未授权），供详细错误使用
  const excluded = []
  const candKeys = new Set(candidates.map((e) => entryKey(e)))
  for (const e of chain.entries ?? []) {
    const k = entryKey(e)
    if (candKeys.has(k)) continue
    let reason
    if (!available.has(k)) reason = '探测不可用'
    else if (e.pool === 'paid' && o.paidAllowed !== true) reason = '付费池未授权（free_only）'
    else reason = '未启用'
    excluded.push({ provider: e.provider, model: e.model, reason })
  }

  return {
    candidates,
    freeCount: free.filter((e) => available.has(entryKey(e))).length,
    paidCount: o.paidAllowed === true ? paid.filter((e) => available.has(entryKey(e))).length : 0,
    available,
    stale,
    excluded,
  }
}

/**
 * 构造**详细抛错**（用户确认第 2 点：至少知道哪个渠道不可用 + 原因）。
 *
 * @param {object} o
 * @param {Array} o.excluded 被排除条目（planRoute 产出）
 * @param {Array} o.failures 本轮尝试失败的条目 [{provider, model, kind, message}]
 * @param {string} [o.code]
 * @returns {Error}
 */
export function buildDetailedError(o = {}) {
  const lines = ['cs-myfree: 全部可用模型失败']
  const failures = Array.isArray(o.failures) ? o.failures : []
  if (failures.length > 0) {
    lines.push('  本轮尝试失败的渠道：')
    for (const f of failures) {
      lines.push(`    - ${f.provider}/${f.model}：${f.kind ?? 'UNKNOWN'}${f.message ? '（' + f.message + '）' : ''}`)
    }
  }
  const excluded = Array.isArray(o.excluded) ? o.excluded : []
  const byReason = new Map()
  for (const e of excluded) {
    const r = e.reason ?? '未启用'
    if (!byReason.has(r)) byReason.set(r, [])
    byReason.get(r).push(`${e.provider}/${e.model}`)
  }
  if (byReason.size > 0) {
    lines.push('  被排除的渠道：')
    for (const [reason, list] of byReason) {
      lines.push(`    - ${reason}：${list.join('、')}`)
    }
  }
  const err = new Error(lines.join('\n'))
  err.code = o.code ?? 'ALL_UNAVAILABLE'
  err.details = { failures, excluded }
  return err
}

/**
 * 处理一次失败：登记重试计划（仅模型失败），返回更新后的计划（或 null）。
 * 同时返回是否应继续下一个候选。
 *
 * @param {object|null} plan 已有重试计划（单条目维度）
 * @param {{provider:string, model:string, kind:string, at?:number, retry?:object}} fail
 * @returns {{plan:object|null, retry:boolean}}
 */
export function handleFailure(plan, fail = {}) {
  const retryCfg = fail?.retry ?? {}
  const nextPlan = registerFailure(plan, {
    provider: fail.provider,
    model: fail.model,
    kind: fail.kind,
    at: fail.at,
    intervalMs: retryCfg.intervalMs,
    maxAttempts: retryCfg.maxAttempts,
  })
  const retry = nextPlan !== null && nextPlan.state !== RETRY_STATE.EXHAUSTED
  return { plan: nextPlan, retry }
}

/**
 * 汇总多个条目的重试计划（供 UI/持久化）。
 * @param {Array} plans
 * @param {number} now
 */
export function summarizePlans(plans = [], now = Date.now()) {
  const out = { pending: [], due: [], exhausted: [] }
  for (const p of Array.isArray(plans) ? plans : []) {
    if (p?.state === RETRY_STATE.EXHAUSTED) out.exhausted.push(p)
    else if (isDue(p, now)) out.due.push(p)
    else out.pending.push(p)
  }
  return {
    pending: out.pending.length,
    due: out.due.length,
    exhausted: out.exhausted.length,
    total: (Array.isArray(plans) ? plans.length : 0),
  }
}