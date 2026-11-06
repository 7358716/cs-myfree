/**
 * cs-myfree — 轻量 web 工具：fetch + 内存缓存 + 限流 + 多源搜索编排
 *
 * 供 DSH 侧（或任意 HTTP 客户端）调用：
 *   · POST /cs-myfree/search      单 URL fetch（webFetch，兼容保留）
 *   · POST /cs-myfree/search/run  多源真实搜索（runMultiSourceSearch，契约 C3）
 * 设计：纯函数内核 + 可注入 fetchImpl/clock/limiter，便于单测（**单测绝不真联网**）。
 *
 * @module cs-myfree/web/search
 */

import { PARSERS } from '../search/sources.js'
import { fuseResults } from '../search/fuse.js'

const DEFAULT_TTL_MS = 5 * 60 * 1000
const DEFAULT_RATE_PER_MIN = 20

export function createSearchCache({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const store = new Map()
  function keyOf(url) { return String(url) }
  function get(url) {
    const k = keyOf(url)
    const e = store.get(k)
    if (!e) return null
    if (now() - e.at > ttlMs) { store.delete(k); return null }
    return e.value
  }
  function set(url, value) { store.set(keyOf(url), { at: now(), value }) }
  function clear() { store.clear() }
  function size() { return store.size }
  return { get, set, clear, size, ttlMs }
}

export function createRateLimiter({ perMin = DEFAULT_RATE_PER_MIN, now = () => Date.now() } = {}) {
  const buckets = new Map()
  function allow(key = 'global') {
    const k = String(key)
    const nowMs = now()
    const windowStart = nowMs - 60_000
    let arr = buckets.get(k) || []
    arr = arr.filter((t) => t > windowStart)
    if (arr.length >= perMin) { buckets.set(k, arr); return false }
    arr.push(nowMs)
    buckets.set(k, arr)
    return true
  }
  function reset(key) { if (key) buckets.delete(String(key)); else buckets.clear() }
  return { allow, reset, perMin }
}

/**
 * 执行一次 web fetch（带缓存 + 限流）。
 * @param {object} opts
 * @returns {Promise<{ok:boolean, status?:number, body?:string, cached?:boolean, error?:string, retryAfterMs?:number}>}
 */
export async function webFetch(opts = {}) {
  const {
    url,
    fetchImpl = globalThis.fetch,
    cache = null,
    limiter = null,
    key = 'global',
    timeoutMs = 10_000,
    now = () => Date.now(),
  } = opts
  if (!url || typeof url !== 'string') return { ok: false, error: 'missing url' }
  if (limiter && !limiter.allow(key)) {
    return { ok: false, error: 'rate limited', retryAfterMs: 60_000 }
  }
  if (cache) {
    const c = cache.get(url)
    if (c) return { ok: true, status: c.status, body: c.body, cached: true }
  }
  let timer
  try {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    if (ctrl) timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const r = await fetchImpl(url, ctrl ? { signal: ctrl.signal } : {})
    if (timer) clearTimeout(timer)
    const text = await r.text()
    const value = { status: r.status, body: text.slice(0, 200_000) }
    if (cache && r.ok) cache.set(url, value)
    return { ok: r.ok, status: r.status, body: value.body, cached: false }
  } catch (e) {
    if (timer) clearTimeout(timer)
    return { ok: false, error: String((e && e.message) || e) }
  }
}

export const DEFAULTS = { ttlMs: DEFAULT_TTL_MS, perMin: DEFAULT_RATE_PER_MIN }

// ═══════════════════════════════════════════════════════════════════════════
// 多源真实搜索（契约 C3：POST /cs-myfree/search/run）
// ═══════════════════════════════════════════════════════════════════════════
//
// 与「宿主 search provider」（index.js buildSearchProvider）的区别：
//   · 那边要满足宿主 sources 形状（toHostSources），这边是**设置页可调试**的
//     显式端点：要能看到**每个源**各自的 ok/耗时/条数/错误，便于用户判断
//     「是我配置错了，还是这家源挂了」。
//   · 因此这里的 `sources` 是**源体检报告**，`results` 才是融合后的结果。
//
// 三条硬约束（v3 §5 + 契约 C3）：
//   1. 受控并发 ≤2（源站对突发并发敏感，串行太慢、全并发容易被盾）
//   2. 总预算 budgetMs 是**整轮**预算，不是每源预算
//   3. 超时**不报错**：用已返回的部分结果，置 timedOut=true（用户至少能拿到东西）

/** /search/run 默认受控并发（契约 C3：≤2） */
export const RUN_CONCURRENCY = 2
/** 总预算兜底（配置缺失/非法时用契约 C1 的 15000） */
export const RUN_BUDGET_MS = 15_000
/** 总预算上限（配错成 10 分钟会把设置页按钮拖死） */
export const RUN_MAX_BUDGET_MS = 60_000
/** maxResults 兜底与上限 */
export const RUN_MAX_RESULTS = 8
export const RUN_MAX_RESULTS_LIMIT = 50
/** 查询词长度上限（URL 长度与源站宽容度） */
export const RUN_MAX_QUERY_LEN = 200

/** 数字兜底：非法/越界一律夹到 [lo, hi]，缺省用 def */
function clampInt(v, def, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

/**
 * 多源真实搜索（受控并发 + 整轮预算 + 部分结果）。
 *
 * @param {object} opts
 * @param {string} opts.q                     查询词（必填，空白 ⇒ ok:false）
 * @param {number} [opts.maxResults]          融合后结果条数（兜底 8、上限 50）
 * @param {string[]} [opts.sources]           要跑的源 id（缺省 = 全部 PARSERS）
 * @param {Function} [opts.fetchImpl]         注入的 fetch（单测禁用真网络）
 * @param {number} [opts.budgetMs]            整轮总预算（clamp 到 1..60000）
 * @param {number} [opts.concurrency]         受控并发（默认 2）
 * @param {object} [opts.limiter]             createRateLimiter 实例（按源独立计数桶）
 * @param {Function} [opts.now]               时钟（单测可注入）
 * @returns {Promise<{ok:boolean, at?:number, q?:string, sources?:Array, results?:Array, total?:number, budgetMs?:number, timedOut?:boolean, error?:string}>}
 */
export async function runMultiSourceSearch(opts = {}) {
  const {
    q,
    maxResults = RUN_MAX_RESULTS,
    sources = null,
    fetchImpl = globalThis.fetch,
    budgetMs = RUN_BUDGET_MS,
    concurrency = RUN_CONCURRENCY,
    limiter = null,
    now = () => Date.now(),
  } = opts

  const startMs = now()
  const query = String(q ?? '').trim().slice(0, RUN_MAX_QUERY_LEN)
  const budget = clampInt(budgetMs, RUN_BUDGET_MS, 1, RUN_MAX_BUDGET_MS)
  const max = clampInt(maxResults, RUN_MAX_RESULTS, 1, RUN_MAX_RESULTS_LIMIT)
  const empty = { at: startMs, q: query, sources: [], results: [], total: 0, budgetMs: budget, timedOut: false }

  if (!query) return { ok: false, error: '缺少查询词 q', ...empty }
  if (typeof fetchImpl !== 'function') return { ok: false, error: '当前环境没有可用的 fetch', ...empty }

  // ── 选源：请求指定 ⇒ 只跑指定的（未知 id 单列一条 error，让 UI 显性提示）──
  //    注意：不去重排序以外做任何"猜测"，源 id 必须与 PARSERS 完全一致。
  const known = Object.keys(PARSERS)
  const requested = Array.isArray(sources) && sources.length ? sources : known
  const selected = []
  const unknown = []
  for (const raw of [...new Set(requested.map((s) => String(s ?? '').trim()).filter(Boolean))]) {
    if (PARSERS[raw]) selected.push(raw)
    else unknown.push({ id: raw, ok: false, ms: 0, count: 0, error: '未知搜索源' })
  }
  if (selected.length === 0) {
    return {
      ok: false,
      error: `没有可用的搜索源（可用：${known.join(' / ')}）`,
      ...empty,
      sources: unknown,
    }
  }

  // ── 整轮预算：到点统一 abort 所有在途请求 ──
  //    「signal 只是取消信号，不是超时」（v3 §5 硬约束 2）⇒ 超时必须自建，这里用
  //    一个共享 controller + 总预算闹钟；单源失败/被 abort 都不影响其它源。
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const deadline = startMs + budget
  let timedOut = false
  const timer = ctrl ? setTimeout(() => { timedOut = true; try { ctrl.abort() } catch { /* 已 abort */ } }, budget) : null
  // Node 里未 clearTimeout 的定时器会拖住进程（跑测试时表现为 hang）⇒ 単源一律 finally 清理

  /** 每个源一条体检记录；collected 与 selected 同序（融合需要**按源序**建批次） */
  const detail = new Array(selected.length).fill(null)
  const collected = new Array(selected.length).fill(null)
  let cursor = 0

  const runOne = async (id, i) => {
    const t0 = now()
    // 限流桶按源独立（'run:<id>'）：与 POST /search 的 'global' 桶互不抢占
    if (limiter && !limiter.allow(`run:${id}`)) {
      detail[i] = { id, ok: false, ms: 0, count: 0, error: 'rate limited（每分钟上限，稍后再试）' }
      return
    }
    // 预算已耗尽：本轮不再发起新请求（已完成的源结果仍然保留）
    if (now() >= deadline) {
      timedOut = true
      detail[i] = { id, ok: false, ms: 0, count: 0, error: `超出总预算 ${budget}ms，未执行` }
      return
    }
    try {
      const init = { headers: { 'user-agent': 'Mozilla/5.0' } }
      if (ctrl) init.signal = ctrl.signal
      const res = await fetchImpl(PARSERS[id].url(query), init)
      if (!res || res.ok === false) throw new Error(`HTTP ${res?.status ?? 'unknown'}`)
      const text = await res.text()
      const items = PARSERS[id].parse(text)
      detail[i] = { id, ok: true, ms: now() - t0, count: items.length, error: null }
      collected[i] = { source: id, items }
    } catch (err) {
      // 被总预算 abort ⇒ 计入 timedOut（契约 C3：超时用部分结果，不报错）
      const aborted = ctrl ? ctrl.signal.aborted === true : false
      if (aborted) timedOut = true
      detail[i] = {
        id,
        ok: false,
        ms: now() - t0,
        count: 0,
        error: aborted ? `timeout（超出总预算 ${budget}ms）` : String(err?.message ?? err).slice(0, 120),
      }
    }
  }

  // ── 受控并发 worker 池（≤2）：慢源只占自己的名额，不会堵住后面的源 ──
  const width = Math.min(clampInt(concurrency, RUN_CONCURRENCY, 1, 8), selected.length)
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= selected.length) return
      await runOne(selected[i], i)
    }
  })

  try {
    await Promise.all(workers)
  } finally {
    if (timer) clearTimeout(timer)
  }

  // ── 融合：按源序建批次（fuse 的 bestPos/tiebreak 依赖批次顺序，不能按完成序）──
  const batches = collected.filter(Boolean)
  const fused = fuseResults(batches, { max })
  // 契约 C3：results 每项 { title, url, snippet, source }。
  //   · source = 首个贡献该 URL 的源（fuse 的 seenIn 插入序）
  //   · seenIn = 契约外的附加字段（UI 可选展示"来自 N 个源"，忽略也不影响）
  const results = fused.slice(0, max).map((r) => ({
    title: r.title ?? '',
    url: r.url,
    snippet: r.snippet ?? '',
    source: (r.seenIn && r.seenIn[0]) || 'unknown',
    seenIn: r.seenIn ?? [],
  }))

  return {
    ok: true,
    at: now(),
    q: query,
    sources: [...detail.map((d, i) => d ?? { id: selected[i], ok: false, ms: 0, count: 0, error: '未执行' }), ...unknown],
    results,
    total: results.length,
    budgetMs: budget,
    timedOut,
  }
}
