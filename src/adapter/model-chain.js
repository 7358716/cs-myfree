/**
 * cs-myfree — 模型链（免费池 / 付费池，均带优先级）
 *
 * 设计依据：2026-11-13 定稿设计稿。
 *
 * 核心变化（相对旧「降级链」）：
 *   · 「降级链」→「模型链」：不再是「打一个失败再换下一个」的隐式降级，
 *     而是「先探测出可用集合，只在可用集合里按优先级选」。
 *   · 模型链分两个池：**免费池（free）** 与 **付费池（paid）**，各自有独立优先级。
 *   · 探测粒度 = 模型可用（多渠道同模型，任一账号可用即该模型可用）。
 *
 * 本模块只做**纯函数**（无 I/O、无网络、无 console），便于表驱动单测。
 * 磁盘读写由调用方（index.js 装配层）用 config/store.js 的原子写完成。
 *
 * 向后兼容：旧 `chain-overrides.json` 只有 `chain` 数组、无 `pools`/`retry` 段。
 * 读取时缺段一律用 DEFAULT_MODEL_CHAIN 的默认值（全免费池、付费池空、重试默认）。
 *
 * @module cs-myfree/adapter/model-chain
 */

import { FREE_PROVIDERS, CHANNEL_FREE } from '../audit/pricing.js'

/** 池名 */
export const POOL = Object.freeze({ FREE: 'free', PAID: 'paid' })

/** 池的合法取值 */
export const POOL_NAMES = Object.freeze([POOL.FREE, POOL.PAID])

/** 重试可重试的失败语义（仅模型失败；终态失败不重试） */
export const RETRYABLE_KINDS = Object.freeze([
  'SERVER', 'TIMEOUT', 'EMPTY_RESPONSE', 'TRANSPORT',
])

/** 默认重试间隔（30 分钟，可配置） */
export const DEFAULT_RETRY_INTERVAL_MS = 30 * 60 * 1000

/** 默认单计划最大重试次数 */
export const DEFAULT_MAX_RETRY_ATTEMPTS = 3

/** 默认探测缓存 TTL（5 分钟） */
export const DEFAULT_PROBE_TTL_MS = 5 * 60 * 1000

/**
 * 默认模型链（向后兼容 + 开箱即用）。
 * 免费池：免密源 + 免费渠道；付费池：DeepSeek 官方（需授权）。
 */
export const DEFAULT_MODEL_CHAIN = Object.freeze({
  schema: 'cs-myfree/model-chain/v1',
  pools: {
    free: {
      // 免费池优先级（数字越小越优先）
      order: ['kilo', 'ovh', 'codearts', 'buddy', 'workbuddy', 'loomy', 'qoder', 'qodercn', 'trae', 'cline', 'raccoon', 'minimax', 'minimaxintl', 'zcode', 'officeace', 'accio', 'qiniu', 'gemini', 'deepseek-web'],
      probeTtlMs: DEFAULT_PROBE_TTL_MS,
    },
    paid: {
      // 付费池优先级
      order: ['deepseek-official', 'ark'],
      requireAuth: true,
    },
  },
  // 条目级覆盖（可选）：按 provider+model 覆盖 tier/paid/disabled
  entries: [],
  retry: {
    intervalMs: DEFAULT_RETRY_INTERVAL_MS,
    maxAttempts: DEFAULT_MAX_RETRY_ATTEMPTS,
    kinds: RETRYABLE_KINDS,
  },
})

/** 某 provider 是否免费（免密源 / 渠道自带额度 / 显式标记） */
export function isFreeProvider(provider) {
  const p = String(provider ?? '').replace(/^.*\//, '')
  return FREE_PROVIDERS.includes(p) || CHANNEL_FREE.includes(p)
}

/**
 * 判定一个条目的池归属。
 * 优先级：显式 `pool` 字段 > `paid === true` ⇒ paid > provider 免费判定 ⇒ 默认 free（保守）。
 * @param {{provider?:string, paid?:boolean, pool?:string}} e
 * @returns {'free'|'paid'}
 */
export function poolOf(e = {}) {
  if (e?.pool === POOL.PAID) return POOL.PAID
  if (e?.pool === POOL.FREE) return POOL.FREE
  if (e?.paid === true) return POOL.PAID
  const p = String(e?.provider ?? '').replace(/^.*\//, '')
  if (PAID_PROVIDERS.includes(p)) return POOL.PAID
  if (isFreeProvider(e?.provider)) return POOL.FREE
  return POOL.FREE   // 未知 provider 保守归免费池（绝不因未知而默认付费）
}

/** 付费池内置 provider（不在 CHANNEL_FREE / FREE_PROVIDERS 里，且不是用户自定义） */
export const PAID_PROVIDERS = Object.freeze(['deepseek-official', 'ark', 'volc-ark'])

/**
 * 归一化模型链条目（纯函数，不改磁盘）。
 * @param {object} e 原始条目
 * @param {number} index 序号
 * @returns {object|null} 归一化条目
 */
export function normalizeChainEntry(e, index = 0) {
  if (!e || typeof e !== 'object') return null
  const provider = String(e.provider ?? '').trim()
  const model = String(e.model ?? '').trim()
  if (!provider || !model) return null
  const pool = poolOf(e)
  const tier = Number.isInteger(e.tier) && e.tier >= 0 ? e.tier : (pool === POOL.FREE ? 0 : 1)
  const out = {
    provider,
    model,
    pool,
    tier,
    enabled: e.disabled !== true && e.enabled !== false,
  }
  if (e.paid === true) out.paid = true
  const cw = Number(e.contextWindow)
  if (Number.isInteger(cw) && cw > 0) out.contextWindow = cw
  if (typeof e.note === 'string' && e.note.trim() !== '') out.note = e.note.trim()
  out._i = index
  return out
}

/**
 * 归一化整张模型链（纯函数）。
 * 输入可能是：旧 chain-overrides 的 `{chain:[...]}`、新格式的 `{pools,entries,retry}`、或直接数组。
 * 缺段一律用默认值（向后兼容）。
 * @param {object|Array} raw
 * @returns {{pools:{free:{order:string[],probeTtlMs:number},paid:{order:string[],requireAuth:boolean}}, entries:Array, retry:{intervalMs:number,maxAttempts:number,kinds:string[]}}}
 */
export function normalizeModelChain(raw) {
  const src = Array.isArray(raw) ? { chain: raw } : (raw && typeof raw === 'object' ? raw : {})
  const def = DEFAULT_MODEL_CHAIN

  // 池：合并默认 + 用户覆盖（浅合并，order 数组整体替换）
  const pools = {
    free: {
      order: Array.isArray(src?.pools?.free?.order) ? src.pools.free.order.map(String) : [...def.pools.free.order],
      probeTtlMs: Number.isFinite(src?.pools?.free?.probeTtlMs) && src.pools.free.probeTtlMs > 0
        ? src.pools.free.probeTtlMs : def.pools.free.probeTtlMs,
    },
    paid: {
      order: Array.isArray(src?.pools?.paid?.order) ? src.pools.paid.order.map(String) : [...def.pools.paid.order],
      requireAuth: src?.pools?.paid?.requireAuth !== false,
    },
  }

  // 条目：旧 chain 数组 → 归一化；新 entries 数组 → 归一化；两者合并去重
  const rawEntries = Array.isArray(src?.chain) ? src.chain : (Array.isArray(src?.entries) ? src.entries : [])
  const entries = []
  const seen = new Set()
  for (const e of rawEntries) {
    const n = normalizeChainEntry(e, entries.length)
    if (!n) continue
    const k = `${n.provider}\u0000${n.model}`
    if (seen.has(k)) continue
    seen.add(k)
    entries.push(n)
  }

  // 重试：合并默认 + 用户覆盖
  const retry = {
    intervalMs: Number.isFinite(src?.retry?.intervalMs) && src.retry.intervalMs >= 0
      ? src.retry.intervalMs : def.retry.intervalMs,
    maxAttempts: Number.isInteger(src?.retry?.maxAttempts) && src.retry.maxAttempts > 0
      ? src.retry.maxAttempts : def.retry.maxAttempts,
    kinds: Array.isArray(src?.retry?.kinds) && src.retry.kinds.length > 0
      ? src.retry.kinds.map(String) : [...def.retry.kinds],
  }

  return { schema: def.schema, pools, entries, retry }
}

/**
 * 把模型链按池分组（免费池 / 付费池），组内按优先级（tier 升序，再 _i）排序。
 * @param {ReturnType<typeof normalizeModelChain>} chain
 * @returns {{free:Array, paid:Array}}
 */
export function groupByPool(chain = {}) {
  const entries = Array.isArray(chain?.entries) ? chain.entries : []
  const free = entries.filter((e) => e.pool === POOL.FREE && e.enabled)
  const paid = entries.filter((e) => e.pool === POOL.PAID && e.enabled)
  const byTier = (a, b) => (a.tier - b.tier) || (a._i - b._i)
  return {
    free: free.sort(byTier),
    paid: paid.sort(byTier),
  }
}

/**
 * 从模型链 + 探测可用集合，产出**路由候选列表**（纯函数）。
 *
 * 规则（2026-11-13 定稿）：
 *   · 免费池优先、付费池兜底；
 *   · 只保留「探测可用」的条目（available 集合）；
 *   · 组内按 tier 升序；
 *   · `paidAllowed` 为 false 时**绝不**包含付费池条目（fail-closed）。
 *
 * @param {ReturnType<typeof normalizeModelChain>} chain
 * @param {Set<string>|string[]} available 可用条目键集合（`provider\u0000model`）
 * @param {{paidAllowed?:boolean}} opts
 * @returns {Array} 候选条目（已排序，free 在前 paid 在后）
 */
export function routeCandidates(chain = {}, available = [], opts = {}) {
  const { paidAllowed = false } = opts
  const avail = available instanceof Set ? available : new Set(available)
  const { free, paid } = groupByPool(chain)
  const key = (e) => `${e.provider}\u0000${e.model}`

  const freeAvail = free.filter((e) => avail.has(key(e)))
  const paidAvail = paidAllowed ? paid.filter((e) => avail.has(key(e))) : []

  return [...freeAvail, ...paidAvail]
}

/** 条目键（provider+model），供 available 集合与路由共用 */
export function entryKey(e) {
  return `${e?.provider ?? ''}\u0000${e?.model ?? ''}`
}