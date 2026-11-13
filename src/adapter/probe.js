/**
 * cs-myfree — 模型可用性探测（取代「按链降级」）
 *
 * 设计依据：2026-11-13 定稿设计稿。
 *
 * 核心思想：
 *   · 不再「打一个失败再换下一个」；而是「先探测出当前可用的模型集合，只在该集合里路由」。
 *   · 探测粒度 = **模型可用**：多渠道同模型，**任一账号可用即该模型可用**。
 *   · 探测用真实推理 ping（复用 keyless/probeOne 的思路），结果带 TTL 缓存（默认 5 分钟）。
 *
 * 本模块只做**纯函数 + 缓存读写**（无网络、无 console）。
 * 真实探测请求由调用方注入 `probeFn`（默认走 keyless.probeOne / driver）。
 *
 * @module cs-myfree/adapter/probe
 */

import { entryKey } from './model-chain.js'

/** 探测结果状态 */
export const PROBE_STATE = Object.freeze({
  OK: 'ok',
  FAIL: 'fail',
  UNKNOWN: 'unknown',
})

/**
 * 解析探测缓存（纯函数）。
 * @param {object} cache 缓存对象
 * @returns {{at:number, ttlMs:number, results:Array, available:Set<string>}}
 */
export function parseProbeCache(cache = {}) {
  const at = Number.isFinite(cache?.at) ? cache.at : 0
  const ttlMs = Number.isFinite(cache?.ttlMs) && cache.ttlMs > 0 ? cache.ttlMs : 5 * 60 * 1000
  const results = Array.isArray(cache?.results) ? cache.results : []
  const available = new Set(Array.isArray(cache?.available) ? cache.available : [])
  return { at, ttlMs, results, available }
}

/** 判断探测缓存是否过期（纯函数） */
export function isProbeStale(cache = {}, now = Date.now()) {
  const at = Number(cache?.at) || 0
  const ttlMs = Number(cache?.ttlMs) > 0 ? cache.ttlMs : 5 * 60 * 1000
  return now - at > ttlMs
}

/**
 * 把一组探测结果归并为「可用集合」。
 *
 * 归并规则（用户确认：多渠道同模型，任一账号可用即该模型可用）：
 *   · 同一 `provider+model` 的多条探测结果，只要有一条 `ok:true`，该条目即可用；
 *   · 全部 `ok:false` 或缺失 ⇒ 不可用；
 *   · `available` 集合元素为 `provider\u0000model`（与 model-chain.entryKey 一致）。
 *
 * @param {Array<{provider:string, model:string, ok:boolean, error?:string, ms?:number, at?:number}>} results
 * @returns {Set<string>}
 */
export function mergeAvailability(results = []) {
  const byKey = new Map()   // key → { ok, best }
  for (const r of Array.isArray(results) ? results : []) {
    const key = `${r?.provider ?? ''}\u0000${r?.model ?? ''}`
    if (!byKey.has(key)) byKey.set(key, { ok: false, best: null })
    const slot = byKey.get(key)
    if (r?.ok === true) {
      slot.ok = true
      // 记录最快的一次（延迟最小）
      const ms = Number(r?.ms)
      if (Number.isFinite(ms) && (slot.best === null || ms < slot.best)) slot.best = ms
    }
  }
  const available = new Set()
  for (const [key, v] of byKey) if (v.ok) available.add(key)
  return available
}

/**
 * 把探测缓存序列化为可持久化对象（纯函数）。
 * @param {Set<string>|string[]} available
 * @param {Array} results
 * @param {{at?:number, ttlMs?:number}} [opts]
 */
export function serializeProbeCache(available, results = [], opts = {}) {
  const at = Number.isFinite(opts?.at) ? opts.at : Date.now()
  const ttlMs = Number.isFinite(opts?.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : 5 * 60 * 1000
  return {
    schema: 'cs-myfree/probe-cache/v1',
    at,
    ttlMs,
    available: available instanceof Set ? [...available] : [...(available ?? [])],
    results: Array.isArray(results) ? results : [],
  }
}

/**
 * 构造一条探测结果记录（纯函数，供调用方落盘前使用）。
 * @param {{provider:string, model:string, ok:boolean, ms?:number, error?:string, at?:number}} r
 */
export function makeProbeResult(r = {}) {
  const at = Number.isFinite(r?.at) ? r.at : Date.now()
  return {
    provider: r?.provider ?? null,
    model: r?.model ?? null,
    ok: r?.ok === true,
    ms: Number.isFinite(r?.ms) ? r.ms : null,
    error: r?.error ?? null,
    at,
  }
}

/**
 * 判定「模型失败」是否属于可重试类（供 retry-scheduler 与路由共用）。
 * @param {string} kind 失败语义（failure-map.KIND 之一）
 * @returns {boolean}
 */
export function isRetryableKind(kind) {
  return ['SERVER', 'TIMEOUT', 'EMPTY_RESPONSE', 'TRANSPORT'].includes(String(kind ?? ''))
}