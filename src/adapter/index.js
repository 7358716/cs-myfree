/**
 * cs-myfree — 降级链 adapter（契约合规版）
 *
 * 设计依据：v3 §3。用 adapter 而非钩子（关键决策）。
 *
 * 🔴 v1.1.1 及之前**完全不可用**的原因（已修）：
 *    `registerAdapter('cs-myfree', adapter)` 传了字符串 —— 宿主签名是
 *    `registerAdapter(providers: string[], adapter)`，字符串会被当数组遍历；
 *    且 `providerInfo` 缺 `id`、`listModels` 缺 `provider`、`resolveModel` 缺
 *    `provider`、`context` 用了顶层字段 —— 每一处都会抛错，被静默吞掉。
 *
 * 现在全部按 `dsh-llm/lib/index.js` 的实测契约实现。
 *
 * @module cs-myfree/adapter
 */

import { classify, KIND } from './failure-map.js'
import { createLadder, createHeld, DEFAULT_BUDGET } from './ladder.js'
import { providerRetryPolicy } from './policy.js'
import { mergeChain } from './chain-overrides.js'
import { makeProviderInfo, makeModelInfo, checkProviderInfo, checkModelInfo } from './contract.js'
import { toHostChunks } from './chunks.js'
import { computeCost, FREE_PROVIDERS, CHANNEL_FREE } from '../audit/pricing.js'
import { createConcurrencyGate, getSharedGate } from './concurrency.js'
import { CHANNELS } from '../pools/channels/protocols.js'
import {
  admitCandidates, resolveBilling, normalizeBillingTier, BILLING_TIER, BILLING,
} from './admission.js'
import { getGlobalHints } from './routing-hints.js'
import { createBlacklist, isTerminalKind, ttlForKind } from './blacklist.js'
import { DEFAULT_TTL_MS } from './failure-map.js'
// 契约 E3 的唯一判定点（`config/scope.js` 已实现并导出；这里只负责**消费**，不重写语义）
import { resolveSubagentRouting } from '../config/scope.js'
// ── 探测路由（P2，2026-11-13 定稿设计）─────────────────────────────────────
//    受 `routing.useProbeRoute` 开关保护（默认 false ⇒ 行为与冻结版一致，零回归）。
import { planRoute, buildDetailedError } from './probe-route.js'
import { readJson as readJsonFile, atomicWrite } from '../config/store.js'
import { join } from 'node:path'

export { providerRetryPolicy }

export const PROVIDER_ID = 'cs-myfree'

/**
 * 渠道名 → 注册 provider id 别名
 *
 * 🔴 为什么需要（P1 修复）：宿主按 provider 精确查注册表（`dsh-llm:2264`），
 *    链内候选 provider 是渠道名（`codearts`/`buddy`/`loomy`…），而 myfree 只注册
 *    `cs-myfree` 一个 id。任何"以渠道名发起请求/重放/续跑"的场合，宿主按渠道名查
 *    注册表必然抛 `NO_ADAPTER`。
 *
 * 修复策略：注册时**同时**注册渠道名别名 —— 宿主按任一名字都能查到同一个 adapter。
 * `providerInfo()` / `providerRetryPolicy()` / `listModels()` / `resolveModel()` /
 * `prepareCall()` 对渠道名一律放行（返回与 `cs-myfree` 相同的信息）。
 *
 * ⚠️ 边界：不注册 `deepseek-official`（宿主自带适配器）、`kilo`（免密池已在链内）
 *    等"非 CHANNELS 表"的 id —— 它们不在 `CHANNELS` 里，注册会导致重复声明。
 *
 * @returns {string[]} 渠道名数组（不含 `cs-myfree`）
 */
export function providerAliases() {
  try {
    return Object.keys(CHANNELS).filter((k) => k !== PROVIDER_ID && k !== 'kilo')
  } catch {
    return []
  }
}

/**
 * 路由配置的**默认值**（契约 B `rules.configurable` 的兜底口径）。
 *
 * 🔴 默认值刻意与现状一致（零回归）：
 *   · `priority: 'balanced'`   ⇒ 排序仍走 `policy-switch.PHASE4_POLICY`（blended）
 *   · `autoSwitch: true`       ⇒ 自动切换/兜底重试全部保持开启（现有行为）
 *   · `blacklistTtlMs: 6h`     ⇒ 与 `failure-map.DEFAULT_TTL_MS` 相同（终态失败 TTL）
 *   · 冷却基值不在这里写死：真实值从**闸门**读（15s / 4s），不配置就没人改它。
 */
export const ROUTING_DEFAULTS = Object.freeze({
  priority: 'balanced',
  autoSwitch: true,
  blacklistTtlMs: DEFAULT_TTL_MS,
})

/** `routing.priority` 的合法取值（与 `rules.configurable` 的 options 一致） */
export const ROUTING_PRIORITY_OPTIONS = Object.freeze(['free-first', 'balanced', 'reliability-first'])

/**
 * 切换成功计量（契约 A，**口径 A**）。
 *
 * 口径原文（逐字实现，见 `design/22` §A2）：
 *   1. 「真正发出请求」的锚点 = 5 处 `onEvent({type:'success'})` 之前的实际候选尝试；
 *      `channel-busy` 跳过**不算**尝试。
 *   2. `firstAttemptProvider`：本轮第一个真正发出请求的候选（只记首个，不覆盖）。
 *   3. `isSwitch = firstAttemptProvider !== null && String(cand.provider) !== firstAttemptProvider`
 *      · isSwitch ⇒ total++、byProvider[cand.provider]++、byModel['provider/model']++
 *      · **不论 isSwitch** ⇒ attempts.total++、attempts.byProvider[cand.provider]++
 *   4. 纯内存累积（每个 adapter 实例一份；插件在进程里只建一个 adapter ⇒ 等价进程级），重启归零。
 *
 * 为什么要单独一个计量器而不是散在 5 个成功分支里：本项目已经踩过
 * 「统计分散导致口径漂移」的坑（见 `design/22` §A2.5），所以**只有一个入口**。
 *
 * @param {{now?:() => number}} [o]
 */
export function createSwitchMeter({ now = () => Date.now() } = {}) {
  const byProvider = new Map()      // 切换后成功的「到达方」
  const byModel = new Map()         // 'provider/model'
  const attemptsByProvider = new Map()  // 分母：每次成功的实际尝试方
  const byPath = new Map()          // 哪条补救路径救回来的（诊断用）
  let total = 0
  let attemptsTotal = 0
  let last = null
  let lastAt = null

  const bump = (map, key) => {
    if (typeof key !== 'string' || key === '') return
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  /** 降序对象（页面直接渲染，不用再排） */
  const sortedObj = (map) => Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]))

  return {
    /**
     * 记一次成功（**5 个成功分支的唯一入口**）。
     *
     * @param {object} o
     * @param {string} o.provider 本次成功的候选 provider
     * @param {string|null} [o.model]
     * @param {string|null} [o.firstProvider] 本轮首个真正发出请求的 provider（无 ⇒ null）
     * @param {string|null} [o.firstModel]
     * @param {number} [o.attemptNo] 本轮第几次真正发出请求才成功（账本 `attempts`）
     * @param {string} [o.path] 补救路径（main / cooldown-retry / local-saturation / second-attempt / last-resort）
     * @returns {{switched:boolean, attempts:number, at:number}}
     */
    success({
      provider = null, model = null, firstProvider = null, firstModel = null,
      attemptNo = 1, path = 'main',
    } = {}) {
      const at = now()
      const cur = String(provider ?? '')
      const isSwitch = firstProvider !== null && firstProvider !== undefined && cur !== String(firstProvider)
      // 分母：**每一次**成功都算一次「切换机会」（不管是不是切换）——契约 A2.3
      attemptsTotal += 1
      bump(attemptsByProvider, cur)
      bump(byPath, path)
      if (isSwitch) {
        total += 1
        bump(byProvider, cur)
        bump(byModel, `${cur}/${String(model ?? '')}`)
        last = {
          at,
          from: String(firstProvider),
          to: cur,
          modelFrom: firstModel ?? null,
          modelTo: model ?? null,
        }
      }
      lastAt = at
      return { switched: isSwitch, attempts: Math.max(1, Number(attemptNo) || 1), at }
    },

    /** 契约 A1 的返回体（字段与顺序按契约；`byPath` 是本实现追加的诊断维度） */
    snapshot() {
      return {
        at: lastAt ?? now(),
        total,
        byProvider: sortedObj(byProvider),
        byModel: sortedObj(byModel),
        attempts: { total: attemptsTotal, byProvider: sortedObj(attemptsByProvider) },
        // 分母 0 ⇒ null（页面显示「暂无数据」，不是 0%）
        switchSuccessRate: attemptsTotal > 0
          ? Number(((total / attemptsTotal) * 100).toFixed(1))
          : null,
        last,
        byPath: sortedObj(byPath),
      }
    },

    /** 归零（诊断页「重置统计」/单测用） */
    reset() {
      byProvider.clear(); byModel.clear(); attemptsByProvider.clear(); byPath.clear()
      total = 0; attemptsTotal = 0; last = null; lastAt = null
    },
  }
}

/**
 * 黑名单 TTL 覆盖视图（契约 B 的 `routing.blacklistTtlMs`）。
 *
 * 为什么要在 adapter 侧做一层视图：拉黑时长由 `blacklist.js` 内部消费
 * `failure-map.TTL_MS` 的分级表，`createBlacklist()` **没有 TTL 注入口**
 * （该文件不在本组写权内）。若只把配置读进来不落地，就是「页面能改但后端不读」的假开关。
 *
 * 因此这里做**生效视图**：记录时另存「配置 TTL」的到期时间，探针 / 快照 / 解除
 * 全部以配置 TTL 为准 ⇒ 改了立刻生效，且页面看到的 `until/ttlMs` 与真实拦截面一致。
 *
 * ⚠️ `ttlMs = null`（未配置）⇒ **纯透传**内层实例，行为与冻结版一字不差（零回归）。
 *
 * @param {object} inner blacklist.js 的实例（共享/自建均可）
 * @param {() => number} now 注入时钟（测试可用假时钟）
 */
export function createBlacklistView(inner, now = () => Date.now()) {
  /** provider -> 配置 TTL 的到期时间戳 */
  const untils = new Map()
  let ttlMs = null

  const prune = (at = now()) => {
    for (const [k, v] of untils) if (v <= at) untils.delete(k)
    return at
  }
  const keyOf = (provider) => String(provider ?? '')

  return {
    /** 设置覆盖 TTL（null/非法 ⇒ 关闭覆盖，回到内层分级 TTL） */
    setTtlMs(v) {
      const n = Number(v)
      ttlMs = Number.isFinite(n) && n > 0 ? n : null
      if (ttlMs === null) untils.clear()
      return ttlMs
    },
    get ttlMs() { return ttlMs },

    record(provider, kind, o) {
      const r = typeof inner?.record === 'function' ? inner.record(provider, kind, o) : null
      if (!r || ttlMs === null) return r
      const until = now() + ttlMs
      untils.set(keyOf(provider), until)
      // 返回值同样按生效口径给（调用方可能直接用它发事件）
      return { ...r, until, ttlMs }
    },

    isBlacklisted(provider) {
      const key = keyOf(provider)
      const at = prune()
      const u = untils.get(key)
      // 有配置期记录 ⇒ 以配置 TTL 为准（到期就**不再算拉黑**，即使内层还记着 6h）
      if (u !== undefined) return u > at
      // 没有配置期记录（例如别的模块写进共享实例的历史条目）⇒ 沿用内层判定
      return typeof inner?.isBlacklisted === 'function' ? inner.isBlacklisted(provider) === true : false
    },

    get(provider) {
      const key = keyOf(provider)
      const at = prune()
      const u = untils.get(key)
      if (u !== undefined) {
        if (u <= at) return null
        const base = typeof inner?.get === 'function' ? inner.get(provider) : null
        return { ...(base ?? { provider: key, model: null }), until: u, ttlMs, remainMs: Math.max(0, u - at) }
      }
      return typeof inner?.get === 'function' ? inner.get(provider) : null
    },

    clear(provider) {
      untils.delete(keyOf(provider))
      return typeof inner?.clear === 'function' ? inner.clear(provider) : false
    },

    clearAll() {
      untils.clear()
      if (typeof inner?.clearAll === 'function') inner.clearAll()
    },

    /** 生效快照（与 `routingSnapshot().blacklist` 同口径：过期条目不再出现） */
    snapshot() {
      const at = prune()
      const base = typeof inner?.snapshot === 'function' ? (inner.snapshot() ?? []) : []
      const out = []
      for (const v of base) {
        const key = keyOf(v.provider)
        const u = untils.get(key)
        const until = u === undefined ? Number(v.until) || 0 : u
        if (until <= at) continue
        out.push({
          ...v,
          // 未覆盖时按该 kind 的**分级 TTL** 如实给出（blacklist.snapshot() 本身不带 ttlMs）
          ttlMs: u === undefined ? (Number(v.ttlMs) || ttlForKind(v.kind)) : ttlMs,
          until,
          remainMs: Math.max(0, until - at),
        })
      }
      return out.sort((a, b) => b.remainMs - a.remainMs)
    },

    get size() {
      prune()
      const innerSize = typeof inner?.size === 'number' ? inner.size : 0
      return Math.max(innerSize, untils.size)
    },
  }
}

/**
 * 错误是否表示「上游渠道并发已满」。
 *
 * codearts 的报文形如：
 *   `HTTP 400: {"error_code":"TM.00001041","error_msg":"并发会话数已达上限(3个)"}`
 * driver 会把它包成中文可读文案（含「并发会话已满」）。
 */
export function isChannelBusyError(err) {
  const s = String(err?.message ?? '')
  return /TM\.00001041/.test(s)
    || /并发会话/.test(s)
    || /并发已满/.test(s)
    || /concurrent session/i.test(s)
}

/** 无账号时的安全兜底：只有免密源 */
export const DEFAULT_CANDIDATES = Object.freeze([
  { provider: 'kilo-free', model: 'kilo-auto/free', tier: 1, inputModalities: ['text'] },
])

/**
 * 契约 E3 的**唯一落地处**：按子智能体路由策略调整「准入之后」的候选**顺序**。
 *
 * 三条纪律（一条都不许松）：
 *   1. `auto`（默认）/ `follow` / 没有配置 ⇒ **原样返回入参本身**（零回归：连数组拷贝都不做）；
 *   2. `pinned` 且 `model` 非空 ⇒ 把「精确匹配」的候选**前置**（匹配项之间保持原有相对顺序）；
 *   3. 一条都匹配不到 ⇒ **保持原序**（fail-open：绝不因为"钉的模型不在这条链上"把候选集清空，
 *      否则用户钉错一个模型名就会让整轮请求直接失败 —— 这比"没钉上"糟得多）。
 *
 * ⚠️ 这里只动**顺序**：付费授权过滤 / 黑名单 / 冷却 / 并发这几层过滤一律不碰
 *    （pinned 也不能突破授权、不能顶着重试冷却硬撞失败源）。
 *
 * @param {Array} ordered 准入后的候选（`admitCandidates().eligible`）
 * @param {{mode?:string, model?:string|null}|null} routing `resolveSubagentRouting()` 的结果
 * @returns {Array} 调整后的候选（无操作时返回入参本身）
 */
export function pinSubagentCandidates(ordered, routing) {
  const list = Array.isArray(ordered) ? ordered : []
  if (!routing || routing.mode !== 'pinned') return list
  const want = typeof routing.model === 'string' ? routing.model.trim().toLowerCase() : ''
  if (want === '') return list
  const matched = []
  const rest = []
  for (const cand of list) {
    const qualified = `${String(cand?.provider ?? '')}/${String(cand?.model ?? '')}`.toLowerCase()
    const bare = String(cand?.model ?? '').toLowerCase()
    // 两种写法都认：`provider/model`（精确）与裸模型名（`cand.model` 本身就是它）
    if (qualified === want || bare === want) matched.push(cand)
    else rest.push(cand)
  }
  // 匹配不到 ⇒ fail-open（保持原序，绝不空集）
  if (matched.length === 0) return list
  return [...matched, ...rest]
}

/**
 * 创建 adapter。
 *
 * @param {object} opts
 * @param {Array}  opts.builtin     内置链
 * @param {Array}  opts.overrides   用户覆盖
 * @param {Function} opts.send      async ({provider, model, messages, signal, options}) => AsyncIterable<chunk>
 * @param {object} opts.budget      回合预算
 * @param {Function} opts.onEvent   审计回调
 */
export function createAdapter(opts = {}) {
  const {
    builtin = DEFAULT_CANDIDATES,
    overrides = [],
    send,
    budget = {},
    onEvent = () => {},
    onRecord = () => {},
    extraModels = () => [],        // 已登录渠道的模型（动态）
    directModel = null,            // (modelId) => 候选 | null：用户请求的模型不在链里时的直连解析
    now = () => Date.now(),
    providerId = PROVIDER_ID,
    displayName = 'Myfree（免费模型）',
    concurrency = null,            // 并发闸门（默认按渠道内置上限）
    routingHints = null,           // hint 注册表（缺省读 globalThis 符号；两者都没有 ⇒ free_only）
    blacklist = null,              // 终态失败黑名单（缺省用进程级共享实例）
    /**
     * 路由配置（**可选**）：`cfg` 或 `() => cfg`（函数形式支持配置热更新后重读）。
     *
     * 契约 B 硬要求：`rules.configurable` 里每个 path 必须**真能 patch 生效**。
     * 这里负责「读配置 ⇒ 覆盖默认值」的落地（默认值不变 ⇒ 零回归）：
     *   · `routing.cooldownMs`      → 闸门 `busyCooldownMs`（失败冷却基值）
     *   · `routing.rateCooldownMs`  → 闸门 `rateLimitCooldownMs`（429 退避基值）
     *   · `routing.blacklistTtlMs`  → 黑名单 TTL 覆盖（见 createBlacklistView）
     *   · `sources.limits.<id>`     → 闸门每家并发上限
     *   · `routing.priority`        → 准入排序策略（reliability-first = 对照用排序）
     *   · `routing.autoSwitch`      → 是否允许自动切换/兜底重试（false = 只走主循环）
     * ⚠️ 不传 ⇒ 一切走默认值（不碰闸门、不碰黑名单 TTL）。
     */
    routingConfig = null,
    /**
     * 子智能体路由策略（契约 E3，**可选**）：`{ mode, model, fallback }`
     * 或 `() => ({ mode, model, fallback })`（函数形态支持配置热更新后重读）。
     *
     * 三选项语义（用户原话，见 `config/scope.js` 的契约 E2 注释）：
     *   · `auto`   —— 不跟随路由、自动选路（**默认 = 今天的行为，零回归**）
     *   · `pinned` —— 不跟随路由、固定到 `model`（仍保留 `fallback` 这一层兜底）
     *   · `follow` —— 跟随路由（hint 的 `billing_tier` 已由 cs-bots 写成上级值 ⇒ 这里无需额外排序）
     *
     * ⚠️ 不传 / `undefined` / 脏值 ⇒ 一律按「无配置」处理（`normalizeSubagentRouting` 归一成
     *    `{ mode:'auto', model:null, fallback:'global' }`），行为与未接线时**完全一致**。
     */
    subagentRouting = null,
    /**
     * **账号解析器**（账号级并发，2026-11-06 用户需求 #2，**可选**）
     *
     * `(cand) => accountId | null`：告诉闸门「这次请求用的是该渠道的哪个账号」。
     * 不传 / 返回空 ⇒ 退化为 `provider#default` 单槽，**行为与改造前完全一致**（零回归）。
     *
     * 为什么用解析器而不是链条目字段：链条目的权威形状由 `mergeChain()`/`normalizeEntry()`
     * 定义（只保留 provider/model/tier/paid/disabled/contextWindow/note），凭据与账号
     * 由装配层按 provider 解析 —— 账号身份只有装配层知道。故这里留一个**注入点**，
     * 装配层接线后即可让「同一渠道的两个账号各占各自名额」。
     */
    accountOf = null,
  } = opts

  if (typeof send !== 'function') throw new TypeError('createAdapter 需要 send 函数')

  // 🔴 并发闸门：渠道有会话数上限（codearts=3），超了上游直接拒绝
  // 默认用**进程级共享闸门**：真实对话（adapter）与连通性测试（driver）
  // 必须共用同一份名额，否则上游会话数照样被打满（实测 5 并发全挂）。
  const gate = concurrency ?? getSharedGate()

  // 🔴 黑名单层（终态失败短期拉黑）：buddy/qoder 这类 100% 全败渠道此前每次请求都还在被尝试。
  //    默认每个 adapter 一份（注入共享实例可由插件装配层做，便于 /state 展示与手动解除）；
  //    这样单测之间不会互相污染。
  //
  //    ⚠️ 外面再套一层 `createBlacklistView`：它只在**配置了 `routing.blacklistTtlMs`** 时
  //       才改写生效 TTL，未配置就是纯透传（零回归）。页面可改 ⇒ 后端真读。
  const denyList = createBlacklistView(blacklist ?? createBlacklist(), now)

  // ── 切换成功计量（契约 A）：进程内累积、不随单次请求重置 ──
  const switchMeter = createSwitchMeter({ now })

  // ── 探测路由（P2，2026-11-13 定稿）─────────────────────────────────────
  // 探测缓存与重试计划的**内存态**（与磁盘通过 readProbeCache/writeProbeCache 同步）。
  // 受 `routing.useProbeRoute` 开关保护；默认 false ⇒ 完全走原逻辑。
  const dshHomeForProbe = () => process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh')
  const probeCachePath = () => join(dshHomeForProbe(), 'cs-myfree', 'probe-cache.json')
  const retryPlanPath = () => join(dshHomeForProbe(), 'cs-myfree', 'retry-plan.json')

  /** 读探测缓存（失败 ⇒ 空缓存，绝不抛） */
  const readProbeCache = async () => {
    try {
      const r = await readJsonFile(probeCachePath(), {})
      return r?.ok && r.value && typeof r.value === 'object' ? r.value : {}
    } catch { return {} }
  }
  /** 写探测缓存（原子写；失败不影响主流程） */
  const writeProbeCache = async (cache) => {
    try { await atomicWrite(probeCachePath(), cache) } catch { /* ignore */ }
  }
  /** 读重试计划（失败 ⇒ 空数组） */
  const readRetryPlans = async () => {
    try {
      const r = await readJsonFile(retryPlanPath(), { plans: [] })
      return r?.ok && r.value && Array.isArray(r.value.plans) ? r.value.plans : []
    } catch { return [] }
  }
  /** 写重试计划（原子写） */
  const writeRetryPlans = async (plans) => {
    try { await atomicWrite(retryPlanPath(), { schema: 'cs-myfree/retry-plan/v1', at: now(), plans }) } catch { /* ignore */ }
  }

  /**
   * 路由配置读取（支持「传 cfg 对象」与「传取 cfg 的函数」两种形态）。
   * 函数形态用于配置热更新：每次请求重新读一遍，页面改完**不必重启**。
   */
  const routingConfigOf = () => {
    try { return typeof routingConfig === 'function' ? routingConfig() : routingConfig } catch { return null }
  }

  /**
   * 严格数字归一：只认「真数字」或「非空数字字符串」。
   * ⚠️ `Number(null) === 0`、`Number('') === 0` —— 配置里清空/删除的字段（值为 null）
   * 若直接 Number() 会被当成 `0`（冷却变成"不冷却"、时长变成"立即过期"），所以必须挡住。
   */
  const numIf = (v, fallback) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : fallback
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v)
      return Number.isFinite(n) ? n : fallback
    }
    return fallback
  }

  /** 闸门在**本 adapter 构造时**的参数（配置被清空时用于恢复默认，避免"改过就回不去"） */
  const gateDefaults = {
    busyCooldownMs: numIf(gate?.busyCooldownMs, null),
    rateLimitCooldownMs: numIf(gate?.rateLimitCooldownMs, null),
  }

  /**
   * 生效路由配置（`rules.configurable` 的 value 来源；只读、无副作用）。
   * `configured` 逐项标明「这一项是不是真的由配置指定」，页面据此区分配置值与默认值。
   */
  const routingEffective = {
    priority: ROUTING_DEFAULTS.priority,
    autoSwitch: ROUTING_DEFAULTS.autoSwitch,
    cooldownMs: gateDefaults.busyCooldownMs,
    rateCooldownMs: gateDefaults.rateLimitCooldownMs,
    blacklistTtlMs: ROUTING_DEFAULTS.blacklistTtlMs,
    globalCooldownMs: null,
    useProbeRoute: false,
    probeTtlMs: null,
    maxCooldownMs: Number(gate?.maxCooldownMs) || null,
    limits: {},
    configured: {
      priority: false, autoSwitch: false, cooldownMs: false,
      rateCooldownMs: false, blacklistTtlMs: false, globalCooldownMs: false, useProbeRoute: false, limits: false,
    },
    source: 'default',
  }

  /**
   * 🔴 把配置**真正写进**运行时（契约 B 的核心一条）。
   *
   * 每次 `stream()` 开头调用一次（配置热更新即时生效）；构造时也调一次。
   * 只改传了且合法的字段 —— 未配置 ⇒ 一律回到默认值/闸门原值，默认行为不变。
   *
   * @returns {typeof routingEffective} 生效快照
   */
  const applyRoutingConfig = () => {
    const raw = routingConfigOf()
    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
    // 两种形态都认：完整 cfg（有 routing/sources 段）或直接的 routing 段
    const routing = isObj(raw?.routing) ? raw.routing : (isObj(raw) ? raw : {})
    const sources = isObj(raw?.sources) ? raw.sources : null

    // ① 路由优先目标
    const prio = typeof routing.priority === 'string' ? routing.priority.trim() : ''
    routingEffective.configured.priority = ROUTING_PRIORITY_OPTIONS.includes(prio)
    routingEffective.priority = routingEffective.configured.priority ? prio : ROUTING_DEFAULTS.priority

    // ② 自动选路（false ⇒ 关掉有界重试/二次尝试/最后兜底，只走主循环）
    routingEffective.configured.autoSwitch = typeof routing.autoSwitch === 'boolean'
    routingEffective.autoSwitch = routingEffective.configured.autoSwitch
      ? routing.autoSwitch
      : ROUTING_DEFAULTS.autoSwitch

    // ③ 冷却基值（写闸门；配置被删 ⇒ 恢复构造时的默认值）
    const patch = {}
    const cd = numIf(routing.cooldownMs, NaN)
    routingEffective.configured.cooldownMs = Number.isFinite(cd) && cd >= 0
    if (routingEffective.configured.cooldownMs) patch.busyCooldownMs = cd
    else if (gateDefaults.busyCooldownMs !== null) patch.busyCooldownMs = gateDefaults.busyCooldownMs

    const rc = numIf(routing.rateCooldownMs, NaN)
    routingEffective.configured.rateCooldownMs = Number.isFinite(rc) && rc >= 0
    if (routingEffective.configured.rateCooldownMs) patch.rateLimitCooldownMs = rc
    else if (gateDefaults.rateLimitCooldownMs !== null) patch.rateLimitCooldownMs = gateDefaults.rateLimitCooldownMs

    // ④ 每家渠道并发上限（`sources.limits.<id>`）
    //    ⚠️ 每轮先复位（配置被删掉后不能还标着"已配置"）
    routingEffective.configured.limits = false
    const limIn = sources?.limits
    if (limIn && typeof limIn === 'object' && !Array.isArray(limIn)) {
      const clean = {}
      for (const [k, v] of Object.entries(limIn)) {
        const n = numIf(v, NaN)
        if (Number.isFinite(n) && n > 0) clean[k] = n
      }
      if (Object.keys(clean).length > 0) { patch.limits = clean; routingEffective.configured.limits = true }
    }

    try {
      if (typeof gate?.configure === 'function' && Object.keys(patch).length > 0) gate.configure(patch)
    } catch { /* 重配置失败绝不影响主流程（保留旧值） */ }

    // ⑤ 黑名单 TTL 覆盖
    const bl = numIf(routing.blacklistTtlMs, NaN)
    routingEffective.configured.blacklistTtlMs = Number.isFinite(bl) && bl > 0
    denyList.setTtlMs(routingEffective.configured.blacklistTtlMs ? bl : null)
    routingEffective.blacklistTtlMs = routingEffective.configured.blacklistTtlMs
      ? bl
      : ROUTING_DEFAULTS.blacklistTtlMs

    // ⑥ 全部渠道失败后链路休眠（记录配置，零 I/O，不调闸门；默认 null ⇒ 不休眠）
    const gc = numIf(routing.globalCooldownMs, null)
    routingEffective.configured.globalCooldownMs = gc !== null
    routingEffective.globalCooldownMs = gc !== null ? gc : null

    // ⑦ 探测路由开关（P2，默认 false ⇒ 走原 ladder 逻辑，零回归）
    routingEffective.configured.useProbeRoute = typeof routing.useProbeRoute === 'boolean'
    routingEffective.useProbeRoute = routingEffective.configured.useProbeRoute
      ? routing.useProbeRoute
      : false
    const pt = numIf(routing.probeTtlMs, null)
    routingEffective.probeTtlMs = pt !== null && pt > 0 ? pt : null

    // 生效值一律从闸门回读（唯一事实来源；也覆盖"注入的假闸门没有 configure"的场景）
    routingEffective.cooldownMs = numIf(gate?.busyCooldownMs, gateDefaults.busyCooldownMs)
    routingEffective.rateCooldownMs = numIf(gate?.rateLimitCooldownMs, gateDefaults.rateLimitCooldownMs)
    routingEffective.maxCooldownMs = numIf(gate?.maxCooldownMs, null)
    try {
      const lim = gate?.limits
      routingEffective.limits = lim && typeof lim === 'object' ? { ...lim } : {}
    } catch { routingEffective.limits = {} }
    const anyConfigured = Object.values(routingEffective.configured).some(Boolean)
    routingEffective.source = anyConfigured ? 'config' : 'default'
    return routingEffective
  }

  // 构造时应用一次（服务启动即生效，不必等第一次请求）
  applyRoutingConfig()

  /**
   * 🔴 上下文容量（contextWindow）—— 这是「会话越跑越断」的根因。
   *
   * 真实缺陷（2026-11-04 排查）：链路条目从未设置 `contextWindow` ⇒
   * `makeModelInfo` 拿不到值 ⇒ 宿主**不知道模型容量** ⇒ **不触发自动压缩**
   * ⇒ 会话上下文无限增长（实测已到 66.7 万 token 且只增不减）⇒ 必然中断。
   *
   * 保守取值（宁可让宿主早压缩，也不要撞上游硬限）：
   *   · codearts 标称 1M，但实测 60 万+ 开始不稳 ⇒ 报 **256k**（留足安全边界）
   *   · 免密源（kilo/ovh）实测上下文有限 ⇒ 报 **64k**
   *   · 渠道条目可显式覆盖（entry.contextWindow 优先）
   */
  const CONTEXT_DEFAULTS = {
    codearts: 262_144,      // 标称 1M，实测 60 万+ 不稳 ⇒ 报 256k 让宿主早压缩
    buddy: 131_072,
    workbuddy: 131_072,
    trae: 1_000_000,        // 官方标称
    cline: 200_000,
    minimax: 1_000_000,
    minimaxintl: 1_000_000,
    loomy: 128_000,
    raccoon: 128_000,
    officeace: 200_000,
    accio: 1_000_000,
    kilo: 65_536,           // 免密源实测上下文有限
    ovh: 32_768,
    pollinations: 16_384,
  }
  const DEFAULT_CONTEXT = 65_536

  /** 取某候选的 contextWindow（条目显式值 > 渠道默认 > 兜底） */
  const contextOf = (e) => {
    const explicit = Number(e?.contextWindow)
    if (Number.isInteger(explicit) && explicit > 0) return explicit
    const prov = String(e?.provider ?? '').replace(/-free$|-vision$/, '')
    return CONTEXT_DEFAULTS[prov] ?? DEFAULT_CONTEXT
  }

  let currentBuiltin = Array.isArray(builtin) ? builtin : []
  let currentOverrides = Array.isArray(overrides) ? overrides : []
  let chain = mergeChain(currentBuiltin, currentOverrides)

  /**
   * 全部可选模型 = 链里的模型 + 已登录渠道的模型（去重）。
   * 宿主 listModels 要求 id 唯一，所以渠道模型带 `<channel>/<model>` 前缀。
   */
  function catalog() {
    const seen = new Map()
    for (const e of chain) {
      if (seen.has(e.model)) continue
      seen.set(e.model, e)
    }
    // 追加已登录渠道的模型（id 已带渠道前缀，天然不撞名）
    try {
      for (const m of extraModels() || []) {
        if (!m?.id || seen.has(m.id)) continue
        seen.set(m.id, {
          provider: m.channelId,
          model: m.id,
          name: m.name,
          tier: 9,                        // 渠道模型排在免密源之后，但可手动钉选
          inputModalities: m.inputModalities,
          channelModel: true,
        })
      }
    } catch { /* extraModels 出错不影响免密源 */ }
    return [...seen.values()]
  }

  /** 请求的模型对应的候选（链 → 渠道目录 → 直连解析）；找不到返回 null */
  function resolveRequested(wantModel) {
    if (typeof wantModel !== 'string' || wantModel === '') return null
    const inChain = chain.find((e) => e.model === wantModel)
    if (inChain) return inChain
    const inCatalog = catalog().find((e) => e.model === wantModel)
    if (inCatalog) return inCatalog
    if (typeof directModel === 'function') {
      try {
        const d = directModel(wantModel)
        if (d && typeof d.model === 'string' && d.model !== '') {
          return { tier: 0, channelModel: true, ...d, model: wantModel }
        }
      } catch { /* 直连解析失败 ⇒ 按原链降级 */ }
    }
    return null
  }

  /**
   * 候选顺序：**请求的模型优先直连**，失败后才按 tier 降级。
   *
   * 🔴 修的是「用户选了渠道模型，实际却调 kilo」：
   *    渠道模型不在 `chain` 里（它是 extraModels 动态追加的），
   *    旧实现只按 `chain` 排序 ⇒ 请求的 model 永远匹配不到 ⇒ 直接落到 tier 最小的免密源。
   */
  function candidatesFor(wantModel) {
    const rest = orderCandidates(chain, null)
    const hit = resolveRequested(wantModel)
    if (!hit) return rest
    const key = `${hit.provider}\u0000${hit.model}`
    // 🔑 pinned：用户显式请求的模型。准入流水线里「过滤后若仍存活 ⇒ 固定排第一」
    //    （保留既有行为）；被付费授权过滤掉时**照样丢弃**（用户请求不能突破授权）。
    return [{ ...hit, pinned: true }, ...rest.filter((e) => `${e.provider}\u0000${e.model}` !== key)]
  }

  /**
   * 渠道成本属性（**唯一事实来源**：`audit/pricing.js` 的声明 + protocols 的渠道元数据）。
   *
   * 顺序：protocols 的 `billing`（已按 pricing.js 声明落地并标注 billingSource）
   *      → pricing 的 FREE_PROVIDERS / CHANNEL_FREE
   *      → `xxx-free` 后缀（免密源命名约定）⇒ free
   *      → 推不出 ⇒ null（准入器按 unknown 处理，排序上等同 free，成本保守）
   */
  const channelBillingOf = (provider) => {
    const raw = String(provider ?? '')
    const id = raw.replace(/-free$|-vision$/, '')
    const declared = CHANNELS[id]?.billing
    if (declared === 'free' || declared === 'paid') return declared
    if (FREE_PROVIDERS.includes(id) || CHANNEL_FREE.includes(id)) return 'free'
    if (id !== raw) return 'free'
    return null
  }

  /**
   * 会话授权标签（**fail-closed**）：默认 `free_only`。
   *
   * 解析顺序（契约 §3）：
   *   1. `options.metadata?.billing_tier`（宿主将来若支持）
   *   2. 旁路注册表 hint[options.sessionId]（Phase 2 接入，见 `routing-hints.js`）
   *   3. 默认 `'free_only'`
   * 任何一种异常都落回 `'free_only'` —— 授权只降不升。
   */
  /**
   * hint 注册表解析：显式注入 > globalThis 符号。
   * 每次请求都重新取（注册表可能在 adapter 创建之后才安装/热重载）。
   * 两者都没有 ⇒ null（⇒ 走 free_only，cs-bots 单独安装时的正常降级路径）。
   */
  const hintRegistryOf = () => {
    if (routingHints && typeof routingHints.get === 'function') return routingHints
    return getGlobalHints()
  }
  const hintLookup = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    try {
      const reg = hintRegistryOf()
      return reg ? reg.get(sessionId) : null
    } catch {
      return null     // 注册表异常绝不影响对话（授权 fail-closed）
    }
  }
  const billingTierOf = (options) => {
    try {
      const fromMeta = options?.metadata?.billing_tier
      if (typeof fromMeta === 'string' && fromMeta !== '') return normalizeBillingTier(fromMeta)
    } catch { /* 冻结对象/代理异常 ⇒ 继续往下 */ }
    try {
      const hint = hintLookup(options?.sessionId)
      if (hint && typeof hint.billing_tier === 'string') return normalizeBillingTier(hint.billing_tier)
    } catch { /* 注册表异常绝不影响对话 */ }
    return BILLING_TIER.FREE_ONLY
  }

  /**
   * 子智能体路由**配置**读取（契约 E3；两种形态都认，函数优先）。
   *
   * 与 `routingConfigOf` 同源纪律：
   *   · 函数形态 ⇒ 每次请求重新求值（设置页改完不必重启）；
   *   · 对象形态 ⇒ 直接用（快照语义）；
   *   · 任何异常 / 空值 ⇒ `null`（⇒ `resolveSubagentRouting` 归一成默认 `auto`，零回归）。
   */
  const subagentRoutingOf = () => {
    try {
      const raw = typeof subagentRouting === 'function' ? subagentRouting() : subagentRouting
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
    } catch {
      return null   // 配置读取异常绝不影响对话（一律回退「无配置」= auto）
    }
  }

  /**
   * 候选的**账号标识**（账号级并发维度）。
   *
   * 🔴 零回归红线：解析不出账号 ⇒ 一律返回 `null`，闸门按 `provider#default` 单槽计数，
   *    与改造前**逐字节一致**。只有真的拿到账号串时，同一渠道的多个账号才会各占名额。
   *
   * 取值顺序：
   *   1. 装配层注入的 `accountOf(cand)`（唯一推荐接法 —— 凭据/账号只有装配层知道）
   *   2. 候选自带的账号字段（`accountId` / `account_id` / `account` / `credentialRef`）
   *      —— 兼容未来把账号直接写进链条目/直连候选的场景
   *   3. 都没有 ⇒ `null`
   *
   * @param {object} cand 候选
   * @returns {string|null}
   */
  const hasAccountId = (v) => {
    const s = v === undefined || v === null ? '' : String(v).trim()
    return s === '' ? null : s
  }
  const accountIdOfCandidate = (cand) => {
    if (!cand || typeof cand !== 'object') return null
    try {
      if (typeof accountOf === 'function') {
        const fromInjected = hasAccountId(accountOf(cand))
        if (fromInjected) return fromInjected
      }
    } catch { /* 解析器异常 ⇒ 当作「没有账号」（零回归），绝不影响对话 */ }
    for (const f of ['accountId', 'account_id', 'account', 'credentialRef']) {
      const v = cand[f]
      if (typeof v === 'string' || typeof v === 'number') {
        const s = hasAccountId(v)
        if (s) return s
      }
    }
    return null
  }

  /**
   * 闸门探针（准入器用）。
   * ⚠️ 自定义闸门可能没有 `stats/isCooling`（测试注入的假闸门）⇒ 一律安全降级：
   *    拿不到信息就当「不冷却 / 无负载」，绝不让诊断能力影响主流程。
   *
   * 🔴 账号级（2026-11-06）：给了 `accountId` 且闸门支持账号维度时**只看该账号**；
   *    没给账号 ⇒ 走原口径（provider 级），**零回归**。
   */
  const gateProbe = {
    isCooling(provider, accountId) {
      try {
        const acc = hasAccountId(accountId)
        if (acc && typeof gate?.isCooling === 'function') return gate.isCooling(provider, acc) === true
        return typeof gate?.isCooling === 'function' && gate.isCooling(provider) === true
      } catch { return false }
    },
    stats(provider) {
      try { return typeof gate?.stats === 'function' ? gate.stats(provider) : null } catch { return null }
    },
    loadOf(provider) {
      const st = gateProbe.stats(provider)
      if (!st) return null
      return { active: Number(st.active) || 0, limit: Number(st.limit) || 1 }
    },
    last429At(provider) {
      const st = gateProbe.stats(provider)
      return Number(st?.last429At) || 0
    },
    /** 是否处于 429 限流冷却（重试路径必须**跳过**，永不放宽） */
    isRateCooling(provider, accountId) {
      try {
        const acc = hasAccountId(accountId)
        if (acc && typeof gate?.isRateCooling === 'function') return gate.isRateCooling(provider, acc) === true
        return gateProbe.stats(provider)?.rateCooling === true
      } catch { return false }
    },
    /** 失败率 EWMA（契约 v1.1 §11）：无样本 ⇒ 0（不预设"它不可靠"） */
    failRateOf(provider) {
      const st = gateProbe.stats(provider)
      return Number(st?.failRate) || 0
    },
  }

  /** 最近一次准入结果（诊断页/服务用） */
  let lastAdmission = null
  let lastAdmissionAt = null

  /** 黑名单探针（准入器用；探针异常绝不影响选路） */
  const blacklistProbe = (provider) => {
    try { return typeof denyList?.isBlacklisted === 'function' ? denyList.isBlacklisted(provider) === true : false } catch { return false }
  }

  /** 终态失败 ⇒ 记黑名单 + 发事件（同一渠道重复失败只刷新 TTL，不重复刷事件） */
  const recordBlacklist = (cand, verdict) => {
    const kind = verdict?.kind
    if (!isTerminalKind(kind)) return
    try {
      // 粒度 = provider（黑名单语义见 blacklist.js 原则 6）：终态失败即挡掉该渠道全部模型
      const entry = denyList.record(cand.provider, kind)
      if (!entry) return
      onEvent({
        type: 'blacklist', provider: entry.provider, model: entry.model, kind,
        ttlMs: entry.ttlMs ?? ttlForKind(kind), until: entry.until ?? null, at: now(),
      })
    } catch { /* 拉黑失败绝不影响主流程 */ }
  }

  /** 成功一次 ⇒ 解除该 provider/model 的黑名单 */
  const clearBlacklist = (cand) => {
    try { denyList.clear?.(cand.provider) } catch { /* ignore */ }
  }

  /** 候选 = 链路候选 + 成本属性（纯数据，交给准入器排序/过滤） */
  function candidatesWithBilling(wantModel) {
    return candidatesFor(wantModel).map((e) => {
      const rb = resolveBilling(e, { channelBilling: channelBillingOf(e.provider) })
      return { ...e, billing: rb.billing, billingSource: rb.source }
    })
  }

  return {
    /** 更新链（配置变更后调用） */
    setChain(nextBuiltin, nextOverrides) {
      if (Array.isArray(nextBuiltin)) currentBuiltin = nextBuiltin
      if (Array.isArray(nextOverrides)) currentOverrides = nextOverrides
      chain = mergeChain(currentBuiltin, currentOverrides)
      return chain.length
    },

    /** 读取当前生效链的三件套（页面与选路共用同一份数据 —— 铁律2） */
    getChain() {
      return {
        builtin: currentBuiltin.map((e) => ({ ...e })),
        overrides: currentOverrides.map((e) => ({ ...e })),
        effective: chain.map((e) => ({ ...e })),
      }
    },

    /** 更新可用模型总数（含渠道模型），供 UI/诊断展示 */
    modelCount() {
      return catalog().length
    },

    /** 供页面展示（与选路共用同一份数据） */
    describe() {
      return { providers: [providerId], chain: chain.map((e) => ({ ...e })) }
    },

    /**
     * 当前候选链的**成本/并发视图**（诊断与验证指标用；契约 §3）。
     * 每项：{provider, model, tier, billing, billingSource, pinned}
     */
    chainSnapshot() {
      return candidatesWithBilling(null).map((e) => ({
        provider: e.provider,
        model: e.model,
        tier: e.tier,
        billing: e.billing,
        billingSource: e.billingSource,
        pinned: e.pinned === true,
      }))
    },

    /**
     * 最近一次准入结果（含**逐条去留原因**，契约 §3 的 admissionSnapshot）。
     * 没有跑过请求时返回 null（页面据此显示「尚无数据」，不假装有数据）。
     */
    admissionSnapshot() {
      if (!lastAdmission) return null
      return {
        at: lastAdmissionAt,
        stats: { ...lastAdmission.stats },
        excluded: lastAdmission.excluded.map((x) => ({
          provider: x.candidate?.provider ?? null,
          model: x.candidate?.model ?? null,
          reason: x.reason,
        })),
        eligible: lastAdmission.eligible.map((c) => ({
          provider: c.provider,
          model: c.model,
          tier: c.tier,
          billing: c.billing ?? BILLING.UNKNOWN,
          pinned: c.pinned === true,
        })),
      }
    },

    // ── 契约 A：切换成功统计（口径 A）────────────────────────────────
    /**
     * 切换成功快照（与 `admissionSnapshot()` 同级；`/state.routing.switches` 的唯一数据源）。
     *
     * 口径（契约 A2，逐字）：本轮最终 success 的 provider ≠ 本轮**首个真正发出请求**的
     * provider ⇒ 记 1 次切换成功；分母是「每一次成功」（= 切换机会数）。
     *
     * @returns {{at:number, total:number, byProvider:object, byModel:object,
     *            attempts:{total:number, byProvider:object},
     *            switchSuccessRate:number|null,
     *            last:null|{at:number, from:string, to:string, modelFrom:string|null, modelTo:string|null}}}
     */
    switchSnapshot() {
      return switchMeter.snapshot()
    },

    /** 归零切换统计（诊断页「重置」用；不影响闸门/黑名单） */
    resetSwitchStats() {
      switchMeter.reset()
      return switchMeter.snapshot()
    },

    /** 生效黑名单快照（含配置 TTL 覆盖后的真实 until；`/state.routing.blacklist` 优先用它） */
    blacklistSnapshot() {
      try { return denyList.snapshot() } catch { return [] }
    },

    /**
     * 生效路由配置（契约 B `rules.configurable` 的 value 来源）。
     * 返回体：{priority, autoSwitch, cooldownMs, rateCooldownMs, blacklistTtlMs,
     *          maxCooldownMs, limits, configured, source}
     */
    routingConfigSnapshot() {
      try { applyRoutingConfig() } catch { /* 读取失败 ⇒ 用上次的值 */ }
      return {
        ...routingEffective,
        configured: { ...routingEffective.configured },
        limits: { ...routingEffective.limits },
      }
    },

    // ── 契约②：必须含 id 且等于 provider（渠道名别名同样放行，P1 修复）──
    providerInfo(provider) {
      if (provider !== providerId && !providerAliases().includes(provider)) return undefined
      return makeProviderInfo(provider, { name: displayName })
    },

    // ── 契约⑤：返回扁平策略（渠道名别名同样放行）──
    providerRetryPolicy(provider) {
      if (provider !== providerId && !providerAliases().includes(provider)) return undefined
      return providerRetryPolicy()
    },

    // ── 契约③：每项必须有 provider（渠道名别名同样放行）──
    listModels(provider) {
      if (provider !== providerId && !providerAliases().includes(provider)) return []
      return catalog().map((e) => makeModelInfo(provider, {
        id: e.model,
        name: e.name || e.model,
        contextWindow: contextOf(e),
        inputModalities: e.inputModalities,
        supportsVision: e.supportsVision,
      }))
    },

    /**
     * 契约⑦（DSH 0.2.2-rc.1 新增）：图片请求计价。
     *
     * 🔴 为什么必须有：宿主在**模型切换 + 上下文压缩**时调用
     *    `adapter.imageRequestPricing(provider, model)`（dsh-llm/lib/index.js:2053）。
     *    0.2.2-rc.1 之前没有这个调用；升级后若 adapter 不实现 ⇒ 抛
     *    `imageRequestPricing is not a function` ⇒ `MODEL_SWITCH_COMPACTION_FAILED`
     *    （实测 2026-11-08 20:08，本会话与另一会话同时报错）。
     *
     * 本插件是**文本路由**（图片走 vision 链路单独处理），这里如实返回 undefined
     * 表示「图片请求不计价」，而不是抛错。
     */
    imageRequestPricing(_provider, _model) {
      return undefined
    },

    /**
     * 契约⑧（DSH 0.2.2-rc.1 新增）：图片请求目标尺寸。
     *
     * 🔴 同上：宿主在图片请求序列化时调用 `adapter.imageRequestTarget(provider, model, image)`
     *    （dsh-llm/lib/index.js:2063）。缺了同样会在图片相关路径抛 not a function。
     *    默认行为（与宿主基类一致）：原样保留规范化后的图片尺寸/字节目标。
     *    本插件文本路由不重采样图片，原样返回即可。
     */
    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
    },

    // ── 契约④：provider + id 都必须对（渠道名别名同样放行）──
    resolveModel(provider, model) {
      if (provider !== providerId && !providerAliases().includes(provider)) return undefined
      const hit = resolveRequested(model)
      if (!hit) return undefined
      return makeModelInfo(provider, {
        id: model,
        name: hit.name || model,
        contextWindow: contextOf(hit),
        inputModalities: hit.inputModalities,
        supportsVision: hit.supportsVision,
      })
    },

    // ── 契约⑥：prepareCall 返回 { model, stream } ──
    async prepareCall(provider, model) {
      return {
        model: this.resolveModel(provider, model),
        stream: (options) => this.stream(options),
      }
    },

    /**
     * 主流程：按链逐层尝试，直到某个候选**产出可见答案**。
     * @param {{provider:string, model:string, messages:Array, signal?:AbortSignal}} options
     */
    async *stream(options = {}) {
      const ladder = createLadder(budget).begin(now())

      // ── 生效路由配置（契约 B：页面改了不用重启，每次请求重读一遍）──
      //    返回 {priority, autoSwitch, cooldownMs, rateCooldownMs, blacklistTtlMs, ...}
      //    未配置 ⇒ 全部默认值（autoSwitch=true / priority='balanced'）⇒ 行为与冻结版一致。
      const rt = applyRoutingConfig()
      // 「reliability-first」= 把可靠性(失败率)提到负载之前（对照用排序，见 policy-switch.js）
      const sortPolicy = rt.priority === 'reliability-first' ? 'failrate-first' : null

      // ── 切换统计（契约 A，口径 A）────────────────────────────────
      /** 本轮**第一个真正发出请求**的候选（只记首个，不覆盖；channel-busy 跳过不算） */
      let firstAttempt = null
      /** 本轮**真正发出请求**的次数（账本的 `attempts` 字段用） */
      let sendSeq = 0

      /**
       * 「真正发出请求」的锚点（契约 A2.1）。
       * 🔴 必须在 `gate.acquire()` **成功之后**调用 —— 渠道并发满而 `continue` 的那条路
       * 不算尝试（否则分母被虚增，"切换成功率"会莫名变低）。
       */
      const markSent = (cand) => {
        sendSeq += 1
        attemptedProviders.add(String(cand.provider))
        if (!firstAttempt) {
          firstAttempt = { provider: String(cand.provider ?? ''), model: cand.model ?? null, at: now() }
        }
      }

      /**
       * 🔴 成功记账的**唯一入口**（契约 A2.5）：5 处 `onEvent({type:'success'})` 全部走它，
       * 严禁各写一遍 —— 本项目已经踩过「统计分散导致口径漂移」的坑。
       *
       * @param {object} cand 成功的候选
       * @param {{path?:string}} [extra] 补救路径标记（main / cooldown-retry / local-saturation /
       *                                 second-attempt / last-resort），用于诊断"哪条路救回来的"
       * @returns {{switched:boolean, attempts:number}} 账本需要的两个字段
       */
      const recordSuccess = (cand, extra = {}) => switchMeter.success({
        provider: cand?.provider ?? null,
        model: cand?.model ?? null,
        firstProvider: firstAttempt?.provider ?? null,
        firstModel: firstAttempt?.model ?? null,
        attemptNo: sendSeq,
        path: extra.path ?? 'main',
      })

      // ── 准入流水线（契约 §2）：**循环之前**一次性决定候选顺序 ──
      //
      //  physically 的降级链（ladder/failure-map）一字不动：这里只改变
      //  「按什么顺序试」，并在授权不允许时把付费候选提前摘掉。
      const billingTier = billingTierOf(options)
      // ── 契约 E3：子智能体路由策略（auto / pinned / follow）──────────────────
      //    hint（cs-bots 写的 `follow_parent_routing` / `pinned_model`）优先于配置；
      //    两者都没有 ⇒ `auto`（= 今天的行为）。三种 mode 的落地：
      //      · `auto`   —— 不额外排序（下面 `pinSubagentCandidates` 直接原样返回）；
      //      · `pinned` —— 把钉的模型前置（**只改顺序**，过滤层与授权一律不碰；匹配不到保持原序）；
      //      · `follow` —— 也不额外排序：hint 的 `billing_tier` 已由 cs-bots 按"跟随上级"写成
      //                    上级值，`billingTierOf` 照旧读它就是跟随；再排一次反而会把上级的
      //                    选路结果改掉（等于没跟随）。
      const subagentRoutingEffective = resolveSubagentRouting({
        config: subagentRoutingOf(),
        hint: hintLookup(options?.sessionId),
      })
      // 准入时被「冷却」挡住的候选（只对通过 billing 过滤的候选计数 —— 付费未授权不算）
      const coolingSeen = new Set()
      const isCoolingProbe = (provider) => {
        const cooling = gateProbe.isCooling(provider)
        if (cooling) coolingSeen.add(String(provider ?? ''))
        return cooling
      }
      const admitted = admitCandidates({
        candidates: candidatesWithBilling(options.model),
        billingTier,
        isCooling: isCoolingProbe,
        loadOf: gateProbe.loadOf,
        last429At: gateProbe.last429At,
        failRateOf: gateProbe.failRateOf,
        isBlacklisted: blacklistProbe,
        sortPolicy,
      })
      lastAdmission = admitted
      lastAdmissionAt = now()
      onEvent({ type: 'admission', ...admitted.stats, at: lastAdmissionAt })

      const ordered = pinSubagentCandidates(admitted.eligible, subagentRoutingEffective)
      let lastErr = null

      /** 因「渠道并发已满」被跳过的次数（不消耗失败预算） */
      let busySkips = 0
      /** 本轮**真正发出过请求**的渠道（兜底重试据此避免重复打已失败的候选） */
      const attemptedProviders = new Set()
      /** 最后一次失败所对应的候选（v1.4「二次尝试」要用同一个候选） */
      let lastFailedCand = null
      /** 二次尝试是否已用过（每请求 ≤1 次） */
      let secondAttemptDone = false
      /** 账本 code 覆盖（仅并发满 ⇒ RATE_LIMIT；不影响路由/梯子） */
      let ledgerCode = null
      /** 整条链都忙时，做一次**有界的短重试**（不排队、不多等） */
      let busyRetried = false

      for (const cand of ordered) {
        if (ladder.exhausted(now())) {
          onEvent({ type: 'budget-exhausted', at: now() })
          break
        }
        // 🔴 本请求前半段已把该渠道拉黑（终态失败）⇒ 同渠道后续候选直接跳过：
        //    准入列表是循环前算好的，这里补一道"当场生效"的守卫（省一次注定失败的发送）。
        if (blacklistProbe(cand.provider)) {
          onEvent({ type: 'skipped-blacklisted', provider: cand.provider, model: cand.model, at: now() })
          continue
        }
        const held = createHeld()
        ledgerCode = null

        let releaseSlot = () => {}
        try {
          onEvent({ type: 'attempt', provider: cand.provider, model: cand.model, layer: ladder.snapshot().layer })

          // 🔴 并发闸门（主管要求：**不排队、不超并发、满了直接降级**）
          //
          //    主智能体 + 多个子智能体（teammate）会并发打同一渠道，
          //    上游会话数满了会直接拒绝。这里**不等** ⇒ 立刻换下一个候选，
          //    既保证「不超并发」，又不会让整队串行等待。
          const slot = await gate.acquire(cand.provider, accountIdOfCandidate(cand))
          if (!slot.ok) {
            onEvent({
              type: 'channel-busy', provider: cand.provider, model: cand.model,
              active: slot.active, limit: slot.limit, at: now(),
            })
            // 不当作失败（不消耗 ladder 的失败判定），直接尝试下一个候选
            busySkips += 1
            lastErr = Object.assign(
              new Error(`渠道 ${cand.provider} 并发已满（${slot.active}/${slot.limit}），已自动降级下一个候选`),
              { code: 'CHANNEL_BUSY' },
            )
            continue
          }
          releaseSlot = () => { try { slot.release() } catch { /* ignore */ } }
          // 真正发出请求才计入尝试预算（因忙跳过不算一次失败尝试）
          ladder.countAttempt()
          markSent(cand)

          // 渠道模型（id 形如 codearts/xxx）交给 send 自己判断分发
          const iter = await send({
            provider: cand.provider,
            model: cand.model,
            messages: options.messages,
            signal: options.signal,
            options,
            isChannelModel: cand.channelModel === true,
          })

          // 提交点：先在**简化增量**层缓冲，提交后才转成宿主的块事件流
          //
          // 🔴 血泪教训（「说到一半停/总截断」的真因）：
          //    createHeld().push 在**已提交后**返回 { committed:true, chunk, released:[] }。
          //    上一版只搬 `released`（空数组）⇒ 提交点之后的每个增量都被丢弃，
          //    用户只看到第一个 text-delta。必须两者都收。
          const buffered = []
          for await (const chunk of iter) {
            const r = held.push(chunk)
            if (r.released?.length) buffered.push(...r.released)
            if (r.chunk) buffered.push(r.chunk)
          }

          if (!held.isCommitted) {
            lastErr = { kind: KIND.EMPTY_RESPONSE, message: 'no visible answer' }
            lastFailedCand = cand
            // 行为反馈校准（契约 v1.1 §11）：空答案也是失败样本（权重 0.6）
            try { gate.markFailure?.(cand.provider, KIND.EMPTY_RESPONSE, accountIdOfCandidate(cand)) } catch { /* ignore */ }
            onEvent({ type: 'empty-response', provider: cand.provider })
            continue
          }

          // 把缓冲的简化增量翻译成符合宿主契约的 block 事件流
          async function* replay() { for (const c of buffered) yield c }
          yield* toHostChunks(replay())
          // 契约 A2.5：成功统计只走 recordSuccess（口径 A 的唯一实现）
          const booked = recordSuccess(cand, { path: 'main' })
          onEvent({ type: 'success', provider: cand.provider, model: cand.model })
          // 成功 ⇒ 清冷却 + 连续 429 计数归零（退避曲线随冲突密度重置）+ **解除黑名单**
          try { gate.markSuccess?.(cand.provider, accountIdOfCandidate(cand)) } catch { /* 诊断能力不得影响主流程 */ }
          clearBlacklist(cand)

          // 记一笔（自有账本，失败不影响主流程）
          try {
            let inTok = 0, outTok = 0, cacheRead = 0
            for (const c of buffered) {
              // 独立 usage 增量（OpenAI 流末帧）与 finish.usage 两种形态都要认
              const u = c.type === 'usage' ? c.usage
                : (c.type === 'finish' && c.usage ? c.usage : null)
              if (!u) continue
              inTok = Number(u.inputTokens) || inTok
              outTok = Number(u.outputTokens) || outTok
              cacheRead = Number(u.cacheReadTokens) || cacheRead
            }
            // 🔴 真实计价（此前硬编码 cost:0 / paid:false ⇒ 付费调用永不计费）
            //    cost=null 表示「价格未知」，必须如实记，不能当 0
            const priced = computeCost({
              provider: cand.provider, model: cand.model,
              inTokens: inTok, outTokens: outTok, cacheReadTokens: cacheRead, at: now(),
            })
            onRecord({
              at: now(), provider: cand.provider, model: cand.model,
              in: inTok, out: outTok, cacheRead,
              cost: priced.costCNY, paid: priced.paid, ok: true,
              // 分账口径（契约 §3）：这次调用发生在什么授权下、候选本身是免费还是付费
              billingTier, billing: cand.billing ?? BILLING.UNKNOWN,
              // 🔴 账号级隔离统计：记录 accountId，UI 可按「codearts#账号A」展示成功/失败率
              account: accountIdOfCandidate(cand) ?? null,
              // 成功笔无失败语义
              kind: null,
              // 契约 A3：这一笔是不是「切换后成功」+ 本轮第几次尝试才成功
              switched: booked.switched === true, attempts: booked.attempts,
              ms: now() - (ladder.snapshot().startedAt || now()),
            })
          } catch { /* ignore */ }
          return
        } catch (err) {
          lastErr = classify(err)
          // 🔴 上游「并发会话已满」是 HTTP 400，failure-map 只按状态码会归到 INVALID_REQUEST
          //    （终态、且进账本是"参数被拒绝"）。它本质是**容量/限流**：
          //    driver 已经置 code='RATE_LIMIT'，这里把语义对齐到 RATE_LIMIT（既有 13 类之一），
          //    避免①账本误记参数错误 ②梯子走 swap-model 而不是 swap-account ③误伤黑名单。
          //    ⚠️ failure-map.js 是契约红线（不改），所以在 adapter 侧归一。
          // 🔴 上游「并发会话已满」是 HTTP 400，failure-map 只按状态码会归到 INVALID_REQUEST。
          //    它本质是**容量/限流**（driver 已置 code='RATE_LIMIT'）。failure-map.js 是契约红线
          //    （不改），所以在这里做**窄修**：只纠正**账本 code**，不改 lastErr.kind（路由/梯子行为
          //    与冻结版完全一致 ⇒ harness 零回归）。这样账本不再把并发满记成"参数被拒绝"。
          lastFailedCand = cand
          // 账本口径纠正：并发满记 RATE_LIMIT（只影响 onRecord.code，不改 lastErr.kind ⇒ 路由不变）
          if (isChannelBusyError(err)) ledgerCode = KIND.RATE_LIMIT
          // 行为反馈校准（契约 v1.1 §11）：**每个失败分支**都要喂失败率 EWMA
          //（429 权重 1.0、其它失败 0.6）；冷却/退避仍由 markBusy 单独负责。
          try { gate.markFailure?.(cand.provider, lastErr?.kind, accountIdOfCandidate(cand)) } catch { /* ignore */ }
          // 🔴 终态失败 ⇒ 拉黑（buddy/qoder 这类 100% 全败渠道不再每次请求都撞一遍）。
          //    ⚠️ 上游「并发已满」虽被 classify 归到 INVALID_REQUEST，但它是**瞬时**的，
          //       由 markBusy 的冷却处理，绝不能拉黑 6 小时。
          if (!isChannelBusyError(err)) recordBlacklist(cand, lastErr)
          // 🔴 上游报「并发已满」⇒ 该渠道进入冷却期，本次直接降级，
          //    不再对它重试（实测：名额约 10 秒才归还，重试只是白等）
          if (isChannelBusyError(err)) {
            try { gate.markBusy(cand.provider, undefined, accountIdOfCandidate(cand)) } catch { /* ignore */ }
            onEvent({
              type: 'channel-cooldown', provider: cand.provider, model: cand.model,
              reason: String(err?.message ?? '').slice(0, 120), at: now(),
            })
          } else if (lastErr?.kind === KIND.RATE_LIMIT) {
            // 🔴 429 必须喂闸门（改造 4 的真实来源）
            //
            //    真实缺陷（Lead/verifier 实测）：此前只有「并发已满」才 markBusy，
            //    HTTP 429（KIND.RATE_LIMIT）完全不进闸门 ⇒ streak429/last429At 恒 0
            //    ⇒ 指数退避（15/30/60/120s）与准入排序第 4 项（last429At）在真实
            //    请求路径上**永远不生效**。仿真里表现为「尝试次数上升、子智能体重试率上升」。
            // 🔴 429 写 **rate 冷却**（rateCoolUntil，指数退避 15/30/60/120s）：
            //    与「并发满」的 busy 冷却分开记账，**任何重试都不得放宽** rate 冷却
            //    （否则会在限流窗口里重打 —— verifier 实测 110 次 429 里 54 次是这种白打）。
            try {
              if (typeof gate.markRateLimited === 'function') gate.markRateLimited(cand.provider, accountIdOfCandidate(cand))
              else gate.markBusy(cand.provider, undefined, accountIdOfCandidate(cand))
            } catch { /* ignore */ }
            onEvent({
              type: 'rate-limit-cooldown', provider: cand.provider, model: cand.model,
              streak429: (() => { try { return gateProbe.stats(cand.provider)?.streak429 ?? null } catch { return null } })(),
              at: now(),
            })
          }
          onEvent({ type: 'failure', provider: cand.provider, model: cand.model, kind: lastErr.kind })
          try {
            const failedPriced = computeCost({ provider: cand.provider, model: cand.model, inTokens: 0, outTokens: 0, at: now() })
            onRecord({
              at: now(), provider: cand.provider, model: cand.model,
              in: 0, out: 0, cost: 0, paid: failedPriced.paid, ok: false,
              code: ledgerCode ?? lastErr.kind,
              // 🔴 账号级隔离统计
              account: accountIdOfCandidate(cand) ?? null,
              // 🔴 失败语义（kind），供 fourDimFailureBreakdown 按 provider+model+kind+accountId 聚合
              kind: lastErr.kind ?? null,
              billingTier, billing: cand.billing ?? BILLING.UNKNOWN,
            })
          } catch { /* ignore */ }
          const step = ladder.onFailure(lastErr, cand, now())
          onEvent({ type: 'ladder', layer: step.layer, action: step.action, reason: step.reason })
          if (step.action === 'report') break
        } finally {
          // 🔴 无论成功/失败/抛错，都必须释放名额（否则会话名额泄漏 ⇒ 后续全挂）
          releaseSlot()
        }
      }

      // 🔴 整轮被「并发满 / 冷却」挡过 ⇒ 做**一次**有界兜底重试（不排队、不循环）
      //
      // 为什么要兜底：冷却过滤是「省一次注定失败的往返」的优化，**不是授权**。
      // 若把它当硬闸，一次短暂限流（429 窗口）就会把所有候选挡在门外 ⇒
      // 整轮请求直接失败（实测可用性 100% → 96%）。所以允许**一次**放宽：
      //   · 冷却放宽：准入不再按冷却过滤；闸门侧逐渠道 `relaxCooldown()` 临时放行
      //   · **billing 绝不放宽**：候选集仍由 admitCandidates(billingTier) 产出
      // 失败会重新 markBusy ⇒ streak429 继续累加，冷却按指数退避变长（不会越放越松）。
      // 仍然失败 ⇒ 如实抛错，不无限重试。
      const coolingSkips = coolingSeen.size
      // 🔴 `routing.autoSwitch === false` ⇒ 关掉所有自动补救（只走主循环，
      //    失败就如实上报）。这是「自动选路」这个设置项的真实作用点。
      if (rt.autoSwitch !== false && (busySkips > 0 || coolingSkips > 0) && !busyRetried && !ladder.exhausted(now())) {
        busyRetried = true
        // TODO(契约 E3-fallback，尚未接线)：`subagentRouting.fallback === 'scope'`
        //   （"兜底用本层单独设置的链"）这里**没有**落地 —— 原因：adapter 只持有装配层
        //   合并后的**一条**链（builtin + overrides），拿不到"本层作用域链"；要落地必须把
        //   scope 链一路传进来（装配层 + 配置层改造，改动面大、回归风险高），故先留 TODO。
        //   现状：无论 `fallback` 取 `global` 还是 `scope`，回退都用同一条链（= 今天的行为，
        //   安全侧：至少不会因为缺配置而空集）。字段本身已被读入并进入 `resolveSubagentRouting`，
        //   接线时只需在这里换候选来源，不必改判定逻辑。
        const retryAdmitted = admitCandidates({
          candidates: candidatesWithBilling(options.model),
          billingTier,                       // ⚠️ 授权绝不放宽
          // ⚠️ 只跳过 **429 限流冷却** 的候选；并发满冷却（busyCoolUntil）留给 relaxCooldown 放宽
          isCooling: (provider) => gateProbe.isRateCooling(provider),
          // 并发过滤也放宽：本轮没发送过的候选即使"名额满"也进重试队列
          //（闸门仍会判忙 ⇒ 只是不再因为它被准入提前剔除；不会重复发送同一候选）
          loadOf: () => null,
          isBlacklisted: blacklistProbe,     // 黑名单也不放宽（终态失败不再撞）
          last429At: gateProbe.last429At,
          failRateOf: gateProbe.failRateOf,
          sortPolicy,
        })
        onEvent({
          type: 'cooldown-retry', busySkips, cooldownSkips: coolingSkips,
          kept: retryAdmitted.eligible.length, billingTier, waitMs: 1200, round: 1, at: now(),
        })
        await new Promise((r) => setTimeout(r, 1200))
        // ⚠️ 只重试本轮**没真正发送过**的候选（例如被冷却/忙挡住的）：
        //    同一个请求内**同一候选绝不尝试两次**（防止短冷却把重试变成对失败源连打）。
        const retryOrder = retryAdmitted.eligible.filter(
          // ⚠️ 二次过滤：准入的"空集兜底"会把冷却候选放回集合，rate 冷却必须在这里也挡住
          (c) => !attemptedProviders.has(String(c.provider)) && !gateProbe.isRateCooling(c.provider, accountIdOfCandidate(c)),
        )
        for (const cand of retryOrder) {
          if (ladder.exhausted(now())) break
          // 临时放开该渠道的冷却窗口（闸门没有这个方法 ⇒ 冷却仍生效，行为退回旧版）
          try { gate.relaxCooldown?.(cand.provider, accountIdOfCandidate(cand)) } catch { /* ignore */ }
          const slot = await gate.acquire(cand.provider, accountIdOfCandidate(cand))
          if (!slot.ok) continue
          try {
            // 发送前就登记：即使 send 抛错，"本候选本轮已尝试过"也必须成立
            //（否则第二轮兜底会重复打同一失败源 / 误判"零发送"）
            markSent(cand)
            const iter = await send({
              provider: cand.provider,
              model: cand.model,
              messages: options.messages,
              signal: options.signal,
              options,
              isChannelModel: cand.channelModel === true,
            })
            const buffered = []
            const held2 = createHeld()
            for await (const chunk of iter) {
              const r0 = held2.push(chunk)
              if (r0.released?.length) buffered.push(...r0.released)
              if (r0.chunk) buffered.push(r0.chunk)
            }
            if (!held2.isCommitted) continue
            async function* replay2() { for (const c of buffered) yield c }
            yield* toHostChunks(replay2())
            recordSuccess(cand, { path: 'cooldown-retry' })
            onEvent({ type: 'success', provider: cand.provider, model: cand.model, afterCooldownRetry: true })
            try { gate.markSuccess?.(cand.provider, accountIdOfCandidate(cand)) } catch { /* ignore */ }
            clearBlacklist(cand)
            return
          } catch (err) {
            // 重试里的失败同样要喂闸门（否则 streak429 永远停在 1，退避不增长）
            const cls = classify(err)
            lastErr = cls                       // 真实上游失败语义（不再沿用主循环的 CHANNEL_BUSY）
            lastFailedCand = cand
            try { gate.markFailure?.(cand.provider, cls?.kind, accountIdOfCandidate(cand)) } catch { /* ignore */ }
            if (isChannelBusyError(err)) {
              try { gate.markBusy(cand.provider, undefined, accountIdOfCandidate(cand)) } catch { /* ignore */ }
            } else if (cls?.kind === KIND.RATE_LIMIT) {
              try {
                if (typeof gate.markRateLimited === 'function') gate.markRateLimited(cand.provider, accountIdOfCandidate(cand))
                else gate.markBusy(cand.provider, undefined, accountIdOfCandidate(cand))
              } catch { /* ignore */ }
            }
          } finally {
            try { slot.release() } catch { /* ignore */ }
          }
        }

        // ── 第二段有界等待（契约 v1.3，**仅限**「纯本地饱和」）──
        //
        // 条件（三者必须同时成立，缺一不补）：
        //   ① 本请求**零上游发送**（attemptedProviders 为空 ⇒ 没有任何候选真的打出去过）；
        //   ② 失败原因是 CHANNEL_BUSY（所有候选都被本地并发闸门判忙）；
        //   ③ 本次重试尚未超过两段（总计 ≤2 次等待、≤2.4s）。
        // 理由：纯本地饱和不是上游故障；直接抛错等于把「我们自己的并发保护」变成
        //       用户可见的故障。两段等待仍然**不排队、不超并发**（闸门照旧每次 acquire）。
        // 其它任何情形（有发送、或非 CHANNEL_BUSY）一律不补第二段，避免变成排队。
        const zeroSend = attemptedProviders.size === 0
        if (zeroSend && lastErr?.code === 'CHANNEL_BUSY' && !ladder.exhausted(now())) {
          // 同上（契约 E3-fallback）：`fallback === 'scope'` 的「本层链兜底」与第一段共用
          // 同一个 TODO，接线点也在此处（候选来源 = 本层链）；当前一律用同一条（全局口径）链。
          const second = admitCandidates({
            candidates: candidatesWithBilling(options.model),
            billingTier,                       // 授权仍不放宽
            isCooling: (provider) => gateProbe.isRateCooling(provider),   // rate 冷却同样跳过
            loadOf: () => null,
            isBlacklisted: blacklistProbe,
            last429At: gateProbe.last429At,
            failRateOf: gateProbe.failRateOf,
            sortPolicy,
          })
          const secondOrder = second.eligible.filter(
            (c) => !attemptedProviders.has(String(c.provider)) && !gateProbe.isRateCooling(c.provider, accountIdOfCandidate(c)),
          )
          onEvent({
            type: 'cooldown-retry', busySkips, cooldownSkips: coolingSkips,
            kept: secondOrder.length, billingTier, waitMs: 1200, round: 2,
            reason: 'LOCAL_SATURATION', at: now(),
          })
          await new Promise((r) => setTimeout(r, 1200))
          for (const cand of secondOrder) {
            if (ladder.exhausted(now())) break
            // 与第一段一样：本段也临时放开冷却窗口（否则"全冷却"时整段等效空转）
            try { gate.relaxCooldown?.(cand.provider, accountIdOfCandidate(cand)) } catch { /* ignore */ }
            const slot = await gate.acquire(cand.provider, accountIdOfCandidate(cand))
            if (!slot.ok) continue
            try {
              markSent(cand)
              const iter = await send({
                provider: cand.provider,
                model: cand.model,
                messages: options.messages,
                signal: options.signal,
                options,
                isChannelModel: cand.channelModel === true,
              })
              const buffered = []
              const held3 = createHeld()
              for await (const chunk of iter) {
                const r3 = held3.push(chunk)
                if (r3.released?.length) buffered.push(...r3.released)
                if (r3.chunk) buffered.push(r3.chunk)
              }
              ladder.countAttempt()
              if (!held3.isCommitted) continue
              async function* replay3() { for (const c of buffered) yield c }
              yield* toHostChunks(replay3())
              recordSuccess(cand, { path: 'local-saturation' })
              onEvent({ type: 'success', provider: cand.provider, model: cand.model, afterCooldownRetry: 2 })
              try { gate.markSuccess?.(cand.provider, accountIdOfCandidate(cand)) } catch { /* ignore */ }
              return
            } catch (err) {
              const cls2 = classify(err)
              lastErr = cls2
              lastFailedCand = cand
              try { gate.markFailure?.(cand.provider, cls2?.kind, accountIdOfCandidate(cand)) } catch { /* ignore */ }
              if (isChannelBusyError(err)) {
                try { gate.markBusy(cand.provider, undefined, accountIdOfCandidate(cand)) } catch { /* ignore */ }
              } else if (cls2?.kind === KIND.RATE_LIMIT) {
                try {
                  if (typeof gate.markRateLimited === 'function') gate.markRateLimited(cand.provider, accountIdOfCandidate(cand))
                  else gate.markBusy(cand.provider, undefined, accountIdOfCandidate(cand))
                } catch { /* ignore */ }
              }
            } finally {
              try { slot.release() } catch { /* ignore */ }
            }
          }
        }
      }

      // ── 二次尝试（契约 v1.4，**每请求至多一次**）──
      //
      // 允许范围：**非 429** 的瞬时失败（SERVER / TRANSPORT / TIMEOUT / EMPTY_RESPONSE）
      // 对**同一个候选**再试一次。目的：救回"这条渠道只是一时抽风"的尾事件。
      // 硬约束：429（rate 冷却）与 CHANNEL_BUSY 一律不重试；不碰处于 rate 冷却的候选；
      //         `ladder.countAttempt()` 如实记账；失败同样 `markFailure`。
      const SECOND_ATTEMPT_KINDS = new Set([KIND.TRANSPORT, KIND.TIMEOUT, KIND.SERVER, KIND.EMPTY_RESPONSE])
      if (rt.autoSwitch !== false
        && !secondAttemptDone
        && lastFailedCand
        && SECOND_ATTEMPT_KINDS.has(lastErr?.kind)
        && !gateProbe.isRateCooling(lastFailedCand.provider, accountIdOfCandidate(lastFailedCand))
        && !ladder.exhausted(now())) {
        secondAttemptDone = true
        const cand = lastFailedCand
        onEvent({
          type: 'second-attempt', provider: cand.provider, model: cand.model,
          kind: lastErr?.kind ?? null, at: now(),
        })
        // 只放宽 **busy** 冷却（rate 冷却绝不放宽；上面已确认不在 rate 冷却）
        try { gate.relaxCooldown?.(cand.provider, accountIdOfCandidate(cand)) } catch { /* ignore */ }
        let s2 = null
        try { s2 = await gate.acquire(cand.provider, accountIdOfCandidate(cand)) } catch { s2 = null }
        if (s2?.ok) {
          try {
            ladder.countAttempt()
            markSent(cand)
            const iter = await send({
              provider: cand.provider,
              model: cand.model,
              messages: options.messages,
              signal: options.signal,
              options,
              isChannelModel: cand.channelModel === true,
            })
            const buffered = []
            const held5 = createHeld()
            for await (const chunk of iter) {
              const r5 = held5.push(chunk)
              if (r5.released?.length) buffered.push(...r5.released)
              if (r5.chunk) buffered.push(r5.chunk)
            }
            if (held5.isCommitted) {
              async function* replay5() { for (const c of buffered) yield c }
              yield* toHostChunks(replay5())
              recordSuccess(cand, { path: 'second-attempt' })
              onEvent({ type: 'success', provider: cand.provider, model: cand.model, afterSecondAttempt: true })
              try { gate.markSuccess?.(cand.provider, accountIdOfCandidate(cand)) } catch { /* ignore */ }
              clearBlacklist(cand)
              return
            }
            lastErr = { kind: KIND.EMPTY_RESPONSE, message: 'no visible answer (second-attempt)' }
            try { gate.markFailure?.(cand.provider, KIND.EMPTY_RESPONSE, accountIdOfCandidate(cand)) } catch { /* ignore */ }
          } catch (err) {
            const cls5 = classify(err)
            lastErr = cls5
            lastFailedCand = cand
            try { gate.markFailure?.(cand.provider, cls5?.kind, accountIdOfCandidate(cand)) } catch { /* ignore */ }
            if (isChannelBusyError(err)) {
              try { gate.markBusy(cand.provider, undefined, accountIdOfCandidate(cand)) } catch { /* ignore */ }
            } else if (cls5?.kind === KIND.RATE_LIMIT) {
              try {
                if (typeof gate.markRateLimited === 'function') gate.markRateLimited(cand.provider, accountIdOfCandidate(cand))
                else gate.markBusy(cand.provider, undefined, accountIdOfCandidate(cand))
              } catch { /* ignore */ }
            }
          } finally {
            try { s2.release() } catch { /* ignore */ }
          }
        }
      }

      // ── 最后兜底（契约 v1.3 追加，**每请求至多一次**，不等待）──
      //
      // 为什么需要：主循环 + 有界重试都失败后，若账本预算还没用完、而最后错误属于
      // **瞬时类**（TRANSPORT/TIMEOUT/SERVER/RATE_LIMIT/EMPTY_RESPONSE），直接抛错等于
      // 把一次"可能就是运气差"的请求变成用户可见故障。这里用**最可靠/最空闲**的那个候选
      // （`candidateScore` 最小，与准入排序同一把尺子）再发**一次**：
      //   · 不等待（不排队）；`ladder.countAttempt()` 如实记账（不突破预算）；
      //   · billing 硬过滤照旧（free_only 下不会碰 paid）；
      //   · 每请求最多 1 次、无循环。
      const TRANSIENT_KINDS = new Set([KIND.TRANSPORT, KIND.TIMEOUT, KIND.SERVER, KIND.RATE_LIMIT, KIND.EMPTY_RESPONSE])
      if (rt.autoSwitch !== false && !secondAttemptDone && TRANSIENT_KINDS.has(lastErr?.kind) && !ladder.exhausted(now())) {
        const lrAdmitted = admitCandidates({
          candidates: candidatesWithBilling(options.model),
          billingTier,                       // ⚠️ 授权绝不放宽
          // 唯一例外：429 rate 冷却**必须**跳过（在限流窗口里重打只有白打）
          isCooling: (provider) => gateProbe.isRateCooling(provider),
          loadOf: () => null,                // 不看本地名额（闸门仍会判忙）
          isBlacklisted: blacklistProbe,
          last429At: gateProbe.last429At,
          failRateOf: gateProbe.failRateOf,
          sortPolicy,
        })
        // ⚠️ rate 冷却候选**一律剔除**（last-resort 也不碰：限流窗口里重打只有白打）
        const notRate = lrAdmitted.eligible.filter((c) => !gateProbe.isRateCooling(c.provider, accountIdOfCandidate(c)))
        // 优先「本轮没发送过」的候选；若全都试过，才允许重发**分数最小**的那一个（仅此一次）
        const untried = notRate.filter((c) => !attemptedProviders.has(String(c.provider)))
        const cand = untried[0] ?? notRate[0] ?? null
        if (cand) {
          onEvent({
            type: 'last-resort', provider: cand.provider, model: cand.model,
            kind: lastErr?.kind ?? null, reused: attemptedProviders.has(String(cand.provider)),
            at: now(),
          })
          let lrSlot = null
          // 最后兜底是"最后机会"：busy 与 rate 冷却都临时放开（每请求至多 1 次，不批量白打）
          try { gate.relaxCooldown?.(cand.provider, accountIdOfCandidate(cand)) } catch { /* ignore */ }

          try { lrSlot = await gate.acquire(cand.provider, accountIdOfCandidate(cand)) } catch { lrSlot = null }
          if (lrSlot?.ok) {
            try {
              ladder.countAttempt()
              markSent(cand)
              const iter = await send({
                provider: cand.provider,
                model: cand.model,
                messages: options.messages,
                signal: options.signal,
                options,
                isChannelModel: cand.channelModel === true,
              })
              const buffered = []
              const held4 = createHeld()
              for await (const chunk of iter) {
                const r4 = held4.push(chunk)
                if (r4.released?.length) buffered.push(...r4.released)
                if (r4.chunk) buffered.push(r4.chunk)
              }
              if (held4.isCommitted) {
                async function* replay4() { for (const c of buffered) yield c }
                yield* toHostChunks(replay4())
                recordSuccess(cand, { path: 'last-resort' })
                onEvent({ type: 'success', provider: cand.provider, model: cand.model, afterLastResort: true })
                try { gate.markSuccess?.(cand.provider, accountIdOfCandidate(cand)) } catch { /* ignore */ }
                clearBlacklist(cand)
                return
              }
              lastErr = { kind: KIND.EMPTY_RESPONSE, message: 'no visible answer (last-resort)' }
              try { gate.markFailure?.(cand.provider, KIND.EMPTY_RESPONSE, accountIdOfCandidate(cand)) } catch { /* ignore */ }
            } catch (err) {
              const cls3 = classify(err)
              lastErr = cls3
              lastFailedCand = cand
              try { gate.markFailure?.(cand.provider, cls3?.kind, accountIdOfCandidate(cand)) } catch { /* ignore */ }
              if (isChannelBusyError(err)) {
                try { gate.markBusy(cand.provider, undefined, accountIdOfCandidate(cand)) } catch { /* ignore */ }
              } else if (cls3?.kind === KIND.RATE_LIMIT) {
                try {
                  if (typeof gate.markRateLimited === 'function') gate.markRateLimited(cand.provider, accountIdOfCandidate(cand))
                  else gate.markBusy(cand.provider, undefined, accountIdOfCandidate(cand))
                } catch { /* ignore */ }
              }
            } finally {
              try { lrSlot.release() } catch { /* ignore */ }
            }
          }
        }
      }

      // 🔴 全部候选都被「付费授权」过滤掉 ⇒ 不是未知失败，而是**授权不足**（fail-closed）。
      //    沿用既有 13 类失败语义里的 PERMISSION（不新增失败码），但给出可读文案。
      const billingBlocked = admitted.eligible.length === 0 && admitted.stats.droppedBilling > 0
      const code = billingBlocked ? KIND.PERMISSION : (lastErr?.code ?? lastErr?.kind ?? 'UNKNOWN')

      // 🔴 详细抛错（用户确认第 2 点）：列出每个候选的失败原因（provider/model/kind）。
      //    收集本轮 attemptedProviders 对应的失败详情（从 lastErr 推断，尽量给出可读信息）。
      const failureDetails = []
      for (const p of attemptedProviders) {
        // 简化：只记录最后一次已知失败（精确逐候选失败需改造发送循环，留作后续）
        if (lastFailedCand && String(lastFailedCand.provider) === String(p)) {
          failureDetails.push({ provider: p, model: lastFailedCand.model ?? null, kind: lastErr?.kind ?? 'UNKNOWN', message: lastErr?.message ?? null })
        } else {
          failureDetails.push({ provider: p, model: null, kind: 'UNKNOWN', message: '本轮尝试失败（详情见日志）' })
        }
      }
      const detailedErr = buildDetailedError({
        failures: failureDetails,
        excluded: lastAdmission?.excluded?.map((x) => ({ provider: x.provider, model: x.model, reason: x.reason ?? '未准入' })) ?? [],
        code: code === 'CHANNEL_BUSY' ? 'CHANNEL_BUSY' : (billingBlocked ? KIND.PERMISSION : (lastErr?.kind ?? 'UNKNOWN')),
      })
      // 保留原 code 语义（兼容现有调用方）
      detailedErr.code = code === 'CHANNEL_BUSY' ? 'CHANNEL_BUSY' : (billingBlocked ? KIND.PERMISSION : (lastErr?.kind ?? 'UNKNOWN'))
      const e = detailedErr

      // 🔴 全部渠道失败后链路休眠（用户需求）：全部候选失败且配置了 globalCooldownMs 时，
      //   休眠再重试，避免连续轰炸失效渠道。记录 global-cooldown 事件供 UI 展示。
      const gcMs = Number(routingEffective?.globalCooldownMs)
      if (Number.isFinite(gcMs) && gcMs > 0) {
        const snapshot = ladder ? ladder.snapshot() : {}
        const allChannelsTried = Array.isArray(snapshot?.channelsTried) ? [...snapshot.channelsTried] : []
        const totalMs = snapshot?.startedAt ? now() - snapshot.startedAt : 0
        onEvent({
          type: 'global-cooldown', provider: null, model: null,
          totalAttempts: snapshot?.attempts ?? 0,
          totalMs,
          lastKind: lastErr?.kind ?? null,
          allChannelsTried,
          waitMs: gcMs,
          at: now(),
        })
        await new Promise((r) => setTimeout(r, gcMs))
      }

      throw e
    },

    /** 自检：所有契约点是否合规 */
    selfCheck() {
      const problems = []
      const pi = this.providerInfo(providerId)
      const a = checkProviderInfo(pi, providerId)
      if (!a.ok) problems.push('providerInfo: ' + a.errors.join('; '))

      const models = this.listModels(providerId)
      if (models.length === 0) problems.push('listModels 为空（链里没有模型）')
      for (const m of models) {
        const b = checkModelInfo(m, providerId)
        if (!b.ok) problems.push(`listModels[${m?.id}]: ${b.errors.join('; ')}`)
      }
      for (const m of models) {
        const r = this.resolveModel(providerId, m.id)
        const c = checkModelInfo(r, providerId, m.id)
        if (!c.ok) problems.push(`resolveModel[${m.id}]: ${c.errors.join('; ')}`)
      }
      const rp = this.providerRetryPolicy(providerId)
      if (!rp) problems.push('providerRetryPolicy 为空')
      else if (rp.retryableCodes?.includes('RATE_LIMIT')) problems.push('retryableCodes 不得含 RATE_LIMIT')
      if (typeof rp?.backoff === 'object') problems.push('策略不得嵌套 backoff')

      return { ok: problems.length === 0, problems, modelCount: models.length }
    },
  }
}

/** 候选排序：同 model 优先，其次按 tier、再按原顺序 */
export function orderCandidates(chain = [], wantModel = null) {
  const list = chain.map((e, i) => ({ ...e, _i: i }))
  return list.sort((a, b) => {
    if (wantModel) {
      const am = a.model === wantModel ? 0 : 1
      const bm = b.model === wantModel ? 0 : 1
      if (am !== bm) return am - bm
    }
    return (a.tier - b.tier) || (a._i - b._i)
  })
}
