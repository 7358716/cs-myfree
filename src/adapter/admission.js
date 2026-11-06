/**
 * cs-myfree — 候选**准入流水线**（并发 + 成本感知的排序）
 *
 * 设计依据：`design/17-并发感知路由层-接口契约-v1.md` §2（冻结）。
 *
 * 目标：**不动物理降级链**（ladder/failure-map/chunks/contract 一行不改），
 * 只把「候选顺序」从一个静态排序（tier 升序 + 插入序）升级为
 *
 *     全量候选 → ① 付费授权过滤 → ①.5 黑名单过滤 → ② 冷却过滤 → ③ 并发过滤 → ④ 排序
 *
 * ①.5 黑名单（终态失败拉黑，见 `blacklist.js`）：**过滤层，不改排序**；
 * 位置在 billing 之后（"不许花钱"比"渠道坏了"更根本），且**不参与空集回退**
 * （否则全黑时会退回去撞死渠道，等于没做）。
 *
 * 为什么只做「排序 + 过滤」而不是「排队」：
 *   · 主智能体 + 多个子智能体会并发打同一渠道，排队会让整队串行化；
 *   · 换一个更空闲 / 更便宜的候选，比等一个满名额的候选更快也更省钱。
 *
 * 三条硬纪律：
 *   1. **授权 fail-closed**：`free_only` 下付费候选在流水线里就被剔除，
 *      下游一次都不会尝试。绝不因为「别的候选都不行」而放宽授权。
 *   2. **空集兜底只兜冷却/并发**：它们是「省一次无效往返」，不是授权；
 *      最后由 `gate.acquire()`（最后防线）兜底，失败语义原样保留。
 *   3. **纯函数、零 I/O**：不 import 任何宿主包、不读文件、不联网、不 console，
 *      便于表驱动单测与离线仿真（verifier 直接调用本模块）。
 *
 * @module cs-myfree/adapter/admission
 */

import { PHASE4_POLICY, usesFailRateFirst, usesBlendedScore } from './policy-switch.js'

/** 候选成本属性 */
export const BILLING = Object.freeze({ FREE: 'free', PAID: 'paid', UNKNOWN: 'unknown' })

/** 授权标签（会话级） */
export const BILLING_TIER = Object.freeze({ FREE_ONLY: 'free_only', PAID_ALLOWED: 'paid_allowed' })

/** 排除原因（诊断用，逐条可审计） */
export const ADMISSION_REASON = Object.freeze({
  BILLING: 'billing',
  BLACKLIST: 'blacklist',
  COOLDOWN: 'cooldown',
  CONCURRENCY: 'concurrency',
})

const VALID_BILLING = new Set([BILLING.FREE, BILLING.PAID, BILLING.UNKNOWN])

/**
 * 归一化 billing 取值；非法/缺失返回 null（表示「上游没声明」）。
 * @param {unknown} v
 * @returns {'free'|'paid'|'unknown'|null}
 */
function normalizeBillingValue(v) {
  if (typeof v === 'boolean') return v ? BILLING.PAID : BILLING.FREE
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  return VALID_BILLING.has(s) ? s : null
}

/**
 * 归一化授权标签：**除 'paid_allowed' 外一律 'free_only'**（fail-closed）。
 *
 * 任何拼写错误 / 缺省 / 非字符串都落到 `free_only` —— 宁可少花钱，
 * 不可把未授权会话悄悄升级成付费。
 *
 * @param {unknown} v
 * @returns {'paid_allowed'|'free_only'}
 */
export function normalizeBillingTier(v) {
  if (typeof v === 'string' && v.trim().toLowerCase() === BILLING_TIER.PAID_ALLOWED) {
    return BILLING_TIER.PAID_ALLOWED
  }
  return BILLING_TIER.FREE_ONLY
}

/**
 * 解析单个候选的 billing 属性（纯函数）。
 *
 * 优先级（契约 §2，严格按序）：
 *   1. `entry.billing`（渠道/链路条目显式声明）
 *   2. `entry.paid === true`（链路条目只标了 paid）
 *   3. `channelBilling`（渠道协议元数据 `CHANNELS[id].billing`）
 *   4. `priced`（`audit/pricing.js` 的判定：true/正数 ⇒ 付费，false/0 ⇒ 免费）
 *   5. 都推不出 ⇒ `unknown`（**排序时按 free 处理，成本保守**）
 *
 * @param {object} entry 候选
 * @param {{channelBilling?:string|null, priced?:boolean|number|null}} [o]
 * @returns {{billing:'free'|'paid'|'unknown', source:'entry'|'entry-paid'|'channel'|'pricing'|'default'}}
 */
export function resolveBilling(entry, { channelBilling = null, priced = null } = {}) {
  const declared = normalizeBillingValue(entry?.billing)
  if (declared) return { billing: declared, source: 'entry' }

  if (entry?.paid === true) return { billing: BILLING.PAID, source: 'entry-paid' }
  if (entry?.paid === false) return { billing: BILLING.FREE, source: 'entry-paid' }

  const fromChannel = normalizeBillingValue(channelBilling)
  if (fromChannel) return { billing: fromChannel, source: 'channel' }

  if (typeof priced === 'boolean') {
    return priced ? { billing: BILLING.PAID, source: 'pricing' } : { billing: BILLING.FREE, source: 'pricing' }
  }
  if (typeof priced === 'number' && Number.isFinite(priced)) {
    return priced > 0
      ? { billing: BILLING.PAID, source: 'pricing' }
      : { billing: BILLING.FREE, source: 'pricing' }
  }

  return { billing: BILLING.UNKNOWN, source: 'default' }
}

/**
 * 准入合成分权重（契约 v1.3 定稿，**写死**，不做运行时配置）。
 *
 *   score = W_LOAD × loadRatio + W_FAIL × failRate     （两者都归一到 0..1，越小越优先）
 *
 * 为什么各取 1：
 *   · `loadRatio = active / max(1, limit)` 表示「这条渠道现在有多挤」；
 *   · `failRate` 是闸门的失败率 EWMA（429 权重 1.0、其它 0.6、成功衰减），
 *     表示「这条渠道近期有多不可靠」；
 *   · 两者都直接换算成「这一次发送有多大概率白打」的等价量纲，所以**同权相加**：
 *     一个满载渠道（loadRatio=1）与一个刚连挂两次的渠道（failRate≈1）同样该让位。
 *   · 权重写死而不是可调：可调权重会让「为什么这条排前面」无法审计（本条是 Lead 的明确要求）。
 */
export const ADMISSION_WEIGHTS = Object.freeze({ load: 1, failRate: 1 })

/**
 * **纯函数**：候选的准入合成分（越小越先上）。供排序与单测共用，禁止在别处重算。
 *
 * @param {{loadRatio?:number, failRate?:number}} o
 * @returns {number} 0..2（越接近 0 越健康：空且可靠）
 */
export function candidateScore({ loadRatio = 0, failRate = 0 } = {}) {
  const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0)
  return ADMISSION_WEIGHTS.load * clamp01(loadRatio) + ADMISSION_WEIGHTS.failRate * clamp01(failRate)
}

/** 付费候选排在免费候选之后（unknown 与 free 同档：成本保守） */
function billingRank(billing) {
  return billing === BILLING.PAID ? 1 : 0
}

/** 安全调用外部只读探针（探针抛错绝不影响选路） */
function safeCall(fn, arg, fallback) {
  if (typeof fn !== 'function') return fallback
  try {
    const v = fn(arg)
    return v === undefined || v === null ? fallback : v
  } catch {
    return fallback
  }
}

/**
 * 候选准入。
 *
 * @param {object} input
 * @param {Array} input.candidates 候选（可含 `billing`/`billingSource`/`paid`/`pinned`/`_i`）
 * @param {'free_only'|'paid_allowed'} input.billingTier 会话授权标签
 * @param {(p:string)=>boolean} [input.isCooling] 渠道是否在冷却期（闸门提供）
 * @param {(p:string)=>({active:number,limit:number}|null)} [input.loadOf] 渠道负载（闸门提供）
 * @param {(p:string)=>number} [input.last429At] 该渠道最近一次 429 时间戳（0=从未）
 * @param {(p:string)=>number} [input.failRateOf] 该渠道失败率 EWMA（契约 v1.1 §11；0=无样本）
 * @param {(p:string)=>boolean} [input.isBlacklisted] 该 **provider** 是否被拉黑（终态失败；粒度=provider）
 * @param {('failrate-first'|'blended'|'contract-v1.1'|null)} [input.sortPolicy]
 *        排序策略覆盖（**可选**，供 `routing.priority` 的对照选项使用）：
 *        不传/非法 ⇒ 走 `policy-switch.PHASE4_POLICY`（默认 blended）⇒ 行为与冻结版一致。
 *        ⚠️ 它只换「可靠性 vs 负载」谁先谁后；billing 硬过滤 / 黑名单 / pinned /
 *        空集兜底 全部不变（这几条是红线，任何策略都不许动）。
 * @returns {{
 *   eligible: Array,
 *   excluded: Array<{candidate:object, reason:'billing'|'cooldown'|'concurrency'}>,
 *   stats: {total:number, kept:number, droppedBilling:number, droppedCooldown:number,
 *           droppedConcurrency:number, relaxed:string|null, billingTier:string}
 * }}
 */
export function admitCandidates({
  candidates = [],
  billingTier = BILLING_TIER.FREE_ONLY,
  isCooling = () => false,
  loadOf = () => null,
  last429At = () => 0,
  failRateOf = () => 0,
  isBlacklisted = () => false,
  sortPolicy = null,
} = {}) {
  const tierTag = normalizeBillingTier(billingTier)
  const list = (Array.isArray(candidates) ? candidates : []).map((entry, i) => {
    const rb = resolveBilling(entry, {
      channelBilling: entry?.channelBilling ?? null,
      priced: entry?.priced ?? null,
    })
    return {
      entry,
      billing: rb.billing,
      // 链路条目已带 billingSource 时尊重之（诊断更精确），否则用解析来源
      billingSource: typeof entry?.billingSource === 'string' && entry.billingSource !== ''
        ? entry.billingSource
        : rb.source,
      i: Number.isFinite(entry?._i) ? entry._i : i,
    }
  })

  // ── ① 付费授权过滤（fail-closed：这里剔除的候选，下游一次都不会尝试）──
  const billingExcluded = []
  const afterBilling = []
  for (const it of list) {
    const isPaid = it.billing === BILLING.PAID
    if (isPaid && tierTag === BILLING_TIER.FREE_ONLY) {
      billingExcluded.push({ candidate: it.entry, reason: ADMISSION_REASON.BILLING })
      continue
    }
    afterBilling.push(it)
  }

  // ── ①.5 黑名单过滤（终态失败拉黑；**过滤层，不改排序**）──
  //    ⚠️ 与 billing 一样属于「不许再试」，因此**不参与**后面的空集回退。
  const blacklistExcluded = []
  const afterBlacklist = []
  for (const it of afterBilling) {
    // provider 级探针（黑名单粒度 = provider，见 blacklist.js 原则 6）
    const blocked = safeCall(isBlacklisted, it.entry?.provider, false) === true
    if (blocked) { blacklistExcluded.push({ candidate: it.entry, reason: ADMISSION_REASON.BLACKLIST }); continue }
    afterBlacklist.push(it)
  }

  // ── ② 冷却过滤（省一次注定失败的往返）──
  const afterCooldown = []
  let droppedCooldown = 0
  for (const it of afterBlacklist) {
    const cooling = safeCall(isCooling, it.entry?.provider, false) === true
    if (cooling) { droppedCooldown += 1; continue }
    afterCooldown.push(it)
  }

  // ── ③ 并发过滤（active >= limit 的候选先跳过；limit=0/未知按「无负载信息」处理）──
  const afterLoad = []
  let droppedConcurrency = 0
  for (const it of afterCooldown) {
    const load = safeCall(loadOf, it.entry?.provider, null)
    const limit = Number(load?.limit)
    const active = Number(load?.active)
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(active) && active >= limit) {
      droppedConcurrency += 1
      continue
    }
    afterLoad.push(it)
  }

  // ── 空集兜底：只回退到「步骤 ① 的输出」（绝不回退 billing 过滤）──
  let pool = afterLoad
  let relaxed = null
  let droppedCooldownFinal = droppedCooldown
  let droppedConcurrencyFinal = droppedConcurrency
  if (pool.length === 0 && afterBlacklist.length > 0) {
    pool = afterBlacklist
    relaxed = afterCooldown.length === 0 ? ADMISSION_REASON.COOLDOWN : ADMISSION_REASON.CONCURRENCY
    // 被回退重新纳入的候选不算「被剔除」：诊断口径必须与最终 eligible 一致
    droppedCooldownFinal = 0
    droppedConcurrencyFinal = 0
  }

  // ── ④ 排序：tier → billing → loadRatio → last429At → failRate → _i（全部升序）──
  const loadRatioOf = (provider) => {
    const load = safeCall(loadOf, provider, null)
    const limit = Math.max(1, Number(load?.limit) || 0)
    const active = Number(load?.active) || 0
    return active / limit
  }
  const last429Of = (provider) => Number(safeCall(last429At, provider, 0)) || 0
  // 失败率 EWMA（契约 v1.1 §11 修订 1）：有探针用探针，否则退回候选自带的 failRate
  const failRateOfProvider = (provider) => {
    const probed = safeCall(failRateOf, provider, null)
    if (typeof probed === 'number' && Number.isFinite(probed)) return probed
    return 0
  }
  const failRateOfItem = (it) => {
    const probed = failRateOfProvider(it.entry?.provider)
    if (probed !== 0) return probed
    const own = Number(it.entry?.failRate)
    return Number.isFinite(own) ? own : 0
  }

  /*
   * 排序策略（Phase 4 方案对照；默认 = 契约 v1.1 §11 的顺序）
   *
   *   contract-v1.1 : tier ↑ → billing ↑ → loadRatio ↑ → last429At ↑ → failRate ↑ → _i ↑
   *   failrate-first: tier ↑ → billing ↑ → **failRate ↑** → loadRatio ↑ → last429At ↑ → _i ↑
   *   blended       : tier ↑ → billing ↑ → **(loadRatio + failRate) ↑** → last429At ↑ → _i ↑
   *
   * 三者的差别只在「可靠性 vs 负载」谁先谁后；billing 硬过滤、pinned、空集兜底完全相同。
   */
  // 策略选择：显式覆盖（`routing.priority`）优先，否则按 Phase 4 的定稿常量
  const POLICY_NAMES = ['failrate-first', 'blended', 'contract-v1.1']
  const policy = POLICY_NAMES.includes(sortPolicy)
    ? sortPolicy
    : (usesFailRateFirst() ? 'failrate-first' : (usesBlendedScore() ? 'blended' : 'contract-v1.1'))
  const cmp = (policyName) => (a, b) => {
    const policy = policyName
    const tierD = Number(a.entry?.tier ?? 0) - Number(b.entry?.tier ?? 0)
    if (tierD) return tierD
    const billD = billingRank(a.billing) - billingRank(b.billing)
    if (billD) return billD
    if (policy === 'failrate-first') {
      const frD = failRateOfItem(a) - failRateOfItem(b)
      if (frD) return frD
      const loadD = loadRatioOf(a.entry?.provider) - loadRatioOf(b.entry?.provider)
      if (loadD) return loadD
    } else if (policy === 'blended') {
      // v1.3 默认策略：负载-可靠性合成分（纯函数，见 candidateScore / ADMISSION_WEIGHTS）
      const scoreA = candidateScore({ loadRatio: loadRatioOf(a.entry?.provider), failRate: failRateOfItem(a) })
      const scoreB = candidateScore({ loadRatio: loadRatioOf(b.entry?.provider), failRate: failRateOfItem(b) })
      if (scoreA !== scoreB) return scoreA - scoreB
    } else {
      const loadD = loadRatioOf(a.entry?.provider) - loadRatioOf(b.entry?.provider)
      if (loadD) return loadD
    }
    const l429D = last429Of(a.entry?.provider) - last429Of(b.entry?.provider)
    if (l429D) return l429D
    const frD2 = failRateOfItem(a) - failRateOfItem(b)
    if (frD2) return frD2
    return a.i - b.i
  }

  const sorted = pool.slice().sort(cmp(policy))

  // pinned（用户显式请求的模型）若仍存活 ⇒ 固定排第一（保留既有行为）
  const pinned = sorted.filter((it) => it.entry?.pinned === true)
  const rest = sorted.filter((it) => it.entry?.pinned !== true)
  const finalOrder = pinned.length > 0 ? [...pinned, ...rest] : sorted

  const eligible = finalOrder.map((it) => it.entry)

  return {
    eligible,
    excluded: [...billingExcluded, ...blacklistExcluded],
    stats: {
      total: list.length,
      kept: eligible.length,
      droppedBilling: billingExcluded.length,
      droppedBlacklist: blacklistExcluded.length,
      droppedCooldown: droppedCooldownFinal,
      droppedConcurrency: droppedConcurrencyFinal,
      relaxed,
      billingTier: tierTag,
    },
  }
}
