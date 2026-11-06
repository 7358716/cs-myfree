/**
 * cs-myfree — **黑名单层**（终态失败的短期拉黑）
 *
 * ## 为什么需要（真实账本证据，2026-11-04）
 *
 * `failure-map.js` 早就定义了 `TERMINAL`（AUTH / MODEL_NOT_FOUND / NOT_FOUND /
 * REGION_BLOCKED / PERMISSION / INVALID_REQUEST ⇒ 短期不自愈）和 `retryable:false`，
 * 但**没有任何地方消费它**：
 *
 *   · buddy 73 次调用 **73 次全败**（INVALID_REQUEST 66 / AUTH 6），
 *   · qoder 73 次调用 **73 次全败**（INVALID_REQUEST 71），
 *
 * 且它们一直留在生效链里 ⇒ **每次请求都还要按顺序去撞一遍**。这与并发闸门无关，
 * 纯粹是把「已知死掉的渠道」当成活渠道在烧往返。
 *
 * ## 设计原则
 *
 * 1. **这是过滤层，不是排序**：契约 §2 冻结的排序（tier → billing → loadRatio →
 *    last429At → failRate → _i）一行不改；黑名单只在准入流水线里**剔除**候选。
 * 2. **billing 硬过滤先于黑名单**：付费未授权是"不许花钱"，比"渠道坏了"更根本；
 *    准入器里黑名单是步骤 ① 之后的 ①.5。
 * 3. **绝不被兜底放宽**：与 cooldown/concurrency 不同，黑名单**不参与空集回退**
 *    （否则"全黑"时会退回去撞死渠道，等于没做）。
 * 4. **纯函数 + 注入时钟**：无 I/O、可单测；TTL 取 `failure-map.TTL_MS[kind]`。
 * 5. **可解除**：成功一次即解除该 provider；支持手动 `clear()`。
 * 6. **粒度 = provider 级**（与 design/19 §3 一致）：终态失败（AUTH / INVALID_REQUEST / …）
 *    基本是「这个渠道/账号不可用」，不是「某个模型名写错」。若按 model 拉黑，会连带把同渠道
 *    其它**可用**模型一起跳过，而且 `clear(provider)` 清不掉 model 级条目 ⇒ 永远解除不了。
 *    （verifier 复核 P2：旧实现支持 model 级、准入却用单参探针 ⇒ 连坐且无法解除，现统一 provider 级。）
 *
 * ⚠️ 不持久化（进程内）：重启后黑名单为空 ⇒ 每个坏渠道最多再撞一次就会重新拉黑。
 *    这是有意的：失败语义可能因重新登录/换模型而失效，持久化黑名单容易变成"永久误杀"。
 *
 * @module cs-myfree/adapter/blacklist
 */

import { TERMINAL, TTL_MS, DEFAULT_TTL_MS } from './failure-map.js'

/** 这些 kind 属于「短期不会自愈」⇒ 应拉黑 */
export function isTerminalKind(kind) {
  return TERMINAL.includes(kind)
}

/** 该 kind 的拉黑时长（毫秒） */
export function ttlForKind(kind) {
  return TTL_MS[kind] ?? DEFAULT_TTL_MS
}

/** 条目键：**只按 provider**（黑名单是 provider 级语义，见文件头原则 6） */
function keyOf(provider) {
  return String(provider ?? '')
}

/**
 * 创建黑名单。
 *
 * @param {object} [o]
 * @param {() => number} [o.now] 注入时钟（测试用）
 * @param {number} [o.maxEntries] 容量上限（防内存泄漏）
 */
export function createBlacklist({ now = () => Date.now(), maxEntries = 2048 } = {}) {
  /** key -> { provider, model, kind, until, at, hits } */
  const map = new Map()

  const prune = (at = now()) => {
    for (const [k, v] of map) if (v.until <= at) map.delete(k)
  }

  return {
    /**
     * 记录一次终态失败。
     * @param {string} provider
     * @param {string} kind 失败语义（非 TERMINAL 会被忽略）
     * @param {{note?:string}} [o] ⚠️ `model` 已废弃：本层是 **provider 级**语义
     * @returns {{provider:string, model:null, kind:string, until:number, ttlMs:number}|null}
     */
    record(provider, kind, { note = null } = {}) {
      if (!provider || !isTerminalKind(kind)) return null
      prune()
      // 容量淘汰（最旧先走）
      while (map.size >= maxEntries) {
        let oldestKey = null
        let oldestAt = Infinity
        for (const [k, v] of map) if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k }
        if (oldestKey === null) break
        map.delete(oldestKey)
      }
      const at = now()
      const ttlMs = ttlForKind(kind)
      const key = keyOf(provider)
      const prev = map.get(key)
      // 重复失败只刷新 TTL / 命中次数，不重复建条目（事件由 adapter 侧节流）
      const entry = {
        provider: String(provider),
        model: null,
        kind,
        until: at + ttlMs,
        at,
        ttlMs: ttlMs,
        note,
        hits: (prev?.hits ?? 0) + 1,
      }
      map.set(key, entry)
      return { provider: entry.provider, model: null, kind, until: entry.until, ttlMs }
    },

    /**
     * 该 provider 是否被拉黑（过期不算）。
     * 粒度 = provider 级：一个终态失败即挡掉该渠道的全部模型（见文件头原则 6）。
     */
    isBlacklisted(provider) {
      const entry = map.get(keyOf(provider))
      return Boolean(entry && entry.until > now())
    },

    /** 取条目（诊断用；过期返回 null） */
    get(provider) {
      const at = now()
      const hit = map.get(keyOf(provider))
      if (!hit || hit.until <= at) return null
      return { ...hit, remainMs: hit.until - at }
    },

    /**
     * 解除拉黑（成功一次 / 手动解除）。provider 级 ⇒ 清掉该 provider 的条目。
     * @returns {boolean} 是否真的解除了一条
     */
    clear(provider) {
      const key = keyOf(provider)
      const entry = map.get(key)
      if (!entry || entry.until <= now()) return false
      map.delete(key)
      return true
    },

    /** 清空（诊断页"全部解除"） */
    clearAll() { map.clear() },

    /** 诊断快照（无凭据，可直接展示） */
    snapshot() {
      const at = now()
      prune(at)
      return [...map.values()]
        .map((v) => ({ provider: v.provider, model: v.model, kind: v.kind, until: v.until, remainMs: Math.max(0, v.until - at), hits: v.hits ?? 1 }))
        .sort((a, b) => b.remainMs - a.remainMs)
    },

    get size() { prune(); return map.size },
  }
}

/**
 * 进程级共享黑名单（adapter 与诊断页共用同一份）。
 */
let sharedBlacklist = null
export function getSharedBlacklist(opts) {
  if (!sharedBlacklist) sharedBlacklist = createBlacklist(opts)
  return sharedBlacklist
}
export function resetSharedBlacklist() { sharedBlacklist = null }
