/**
 * cs-myfree — 渠道并发闸门（「不排队、不超并发、直接降级」）
 *
 * 🔴 真实根因（2026-11-03/04 实测）：
 *    codearts 上游有**并发会话硬上限（3 个）**，超了直接 400 TM.00001041。
 *    adapter 逐候选重试时不释放上一个流 ⇒ 名额被占满 ⇒ 后续全部失败，
 *    用户看到的就是「连续中断停摆」。
 *
 *    实测证据：连发 4 个未消费的流，第 2~4 个全部「并发会话已满」；
 *    等 30 秒（会话自然过期）后立刻恢复 200。
 *
 * ## 设计决策（依主管要求，2026-11-04）
 *
 * 主管明确要求：**「设置成请求异步不排队，不超并发，考虑主体、子智能
 * 并发使用同一模型的情况，可以根据情况降级使用范本」**。
 *
 * ⇒ 默认 **reject 模式**：名额满了**不排队等待**，立即返回 `{ok:false}`，
 *    由 adapter **跳到下一个候选（降级）**。
 *
 * 为什么不是排队：
 *  · 主智能体 + 多个子智能体（teammate）会**并发**打同一个渠道；
 *  · 排队会让所有请求串行化、整体延迟爆炸，且一个卡住全队等；
 *  · 降级到链上别的候选（换个渠道/模型）是**更快且更可用**的选择。
 *
 * @module cs-myfree/adapter/concurrency
 */

import { CHANNELS } from '../pools/channels/protocols.js'

/**
 * 免密源并发上限（这些**不在** CHANNELS 里：它们不是"渠道账号"，是免密源）。
 * 实测值原样保留：kilo 按 IP 限流（不是会话数）；ovh 2 req/min/IP。
 */
const KEYLESS_LIMITS = Object.freeze({
  kilo: 4,            // 免密源按 IP 限流，不是会话数
  ovh: 2,             // 2 req/min/IP
  pollinations: 2,
})

/**
 * 各渠道默认并发上限 —— **从 CHANNELS 派生**（契约 §5）。
 *
 * 依据：`src/pools/channels/protocols.js` 每家的 `concurrencyLimit`
 * （`limitSource: 'measured'` = 实测过；`'default'` = 未知，保守取 1）。
 * 这样「渠道元数据」只有一个事实来源，加渠道不用改两处。
 *
 * 🔴 codearts 实测（2026-11-04）：上游按会话计数，且**连接断开后名额不会
 *    立刻归还**（同一 Session-Id 串行第二次就报「并发已满」，等 ~10s 才恢复）。
 *    即：一个请求就占掉一个名额并保持约 10 秒 ⇒ 本地上限压到 **1**（严格串行），
 *    避免自己把自己打满。
 */
export const DEFAULT_LIMITS = Object.freeze({
  ...Object.fromEntries(Object.entries(CHANNELS).map(([id, ch]) => [
    id,
    Number.isFinite(ch?.concurrencyLimit) && ch.concurrencyLimit > 0 ? ch.concurrencyLimit : 1,
  ])),
  ...KEYLESS_LIMITS,
  // 未登记的 provider（测试/第三方）用 2（保持既有行为）
  default: 2,
})

/**
 * 失败率 EWMA（契约 v1.1 §11 修订 2）
 *   α = 0.2：新样本权重 20%，历史权重 80%（≈ 最近 5 次行为的滑动平均）
 *   样本权重：RATE_LIMIT（429）= 1.0（一次白打的尝试最贵）；其它失败 = 0.6；成功 = 0
 */
export const FAIL_EWMA_ALPHA = 0.2
export const FAIL_WEIGHT_RATE_LIMIT = 1.0
export const FAIL_WEIGHT_OTHER = 0.6

/** 失败语义 → EWMA 样本权重 */
export function failSampleWeight(kind) {
  return String(kind ?? '') === 'RATE_LIMIT' ? FAIL_WEIGHT_RATE_LIMIT : FAIL_WEIGHT_OTHER
}

/**
 * 429 限流冷却的**基础值**（与 busy 冷却分开）。
 *
 * 为什么不是 15s（契约 §4 的并发冷却值）：15s 是「上游会话未归还」的实测窗口（并发语义），
 * 而 429 是**请求级限流窗口**。合成验证实测：15s 会把免费池整段踢出 ⇒ 成功率 84%、
 * paid 6.5%→16.9%；4s 是最优折中（成功率 98.4%、paid 3.0%、尝试 −11.1%）。
 * 退避曲线仍是 4/8/16/…→ 120s 封顶（契约 v1.4 的 rateCoolUntil，重试永不放宽）。
 */
export const RATE_LIMIT_COOLDOWN_MS = 4_000

/** 冷却指数退避：基础值 15s，逐次翻倍，封顶 120s */
export const COOLDOWN_BASE_MS = 15_000
export const COOLDOWN_MAX_MS = 120_000

/** 拿不到名额时的错误码（adapter 据此判定「换下一个候选」，不算真正的失败） */
export const BUSY_CODE = 'CHANNEL_BUSY'

/**
 * **进程级共享闸门**。
 *
 * 🔴 真实缺陷（2026-11-04 实测）：adapter 内部 new 了自己的闸门，
 *    而 `/login/test`（连通性测试）**直接调 driver.chat**，完全绕过闸门 ⇒
 *    5 个并发测试请求全部撞上「并发会话已满」，闸门形同虚设。
 *
 *    真实对话走 adapter、连通性测试走 driver —— 两条路径必须**共用同一份
 *    名额**，否则上游会话数照样被打满。
 */
let sharedGate = null
export function getSharedGate(opts) {
  if (!sharedGate) sharedGate = createConcurrencyGate(opts)
  return sharedGate
}
export function resetSharedGate() { sharedGate = null }

/**
 * 闸门的**诊断快照**（契约 §3 的 gateSnapshot / Lead 验证指标口径）。
 *
 * 每家：`{active, limit, ratio, coolingMs, streak429, last429At, lastSuccessAt, queued}`
 * —— 字段与 `gate.stats(provider)` 完全一致，避免「页面口径 ≠ 准入口径」。
 *
 * @param {object} [gate] 缺省用进程级共享闸门
 * @returns {Record<string, object>}
 */
export function snapshotStats(gate = getSharedGate()) {
  const out = {}
  try {
    const snap = typeof gate?.snapshot === 'function' ? gate.snapshot() : {}
    for (const [provider, v] of Object.entries(snap ?? {})) {
      const st = typeof gate?.stats === 'function' ? gate.stats(provider) : null
      out[provider] = {
        active: st?.active ?? v.active ?? 0,
        limit: st?.limit ?? v.limit ?? 0,
        ratio: st?.ratio ?? ((v.active ?? 0) / Math.max(1, v.limit ?? 0)),
        coolingMs: st?.coolingMs ?? v.coolingMs ?? 0,
        busyCoolingMs: st?.busyCoolingMs ?? v.busyCoolingMs ?? 0,
        rateCoolingMs: st?.rateCoolingMs ?? v.rateCoolingMs ?? 0,
        rateCooling: st?.rateCooling ?? v.rateCooling ?? false,
        streak429: st?.streak429 ?? v.streak429 ?? 0,
        last429At: st?.last429At ?? v.last429At ?? 0,
        lastSuccessAt: st?.lastSuccessAt ?? v.lastSuccessAt ?? 0,
        // 行为反馈校准（契约 v1.1 §11）：/state.routing.gate.failRate
        failRate: st?.failRate ?? v.failRate ?? 0,
        failSamples: st?.failSamples ?? v.failSamples ?? 0,
        queued: v.queued ?? 0,
      }
    }
  } catch { /* 诊断失败绝不影响主流程 */ }
  return out
}

/**
 * 数字归一（严格）：只认「真数字」或「非空数字字符串」。
 * ⚠️ 不能直接用 `Number(v)` 判：`Number(null) === 0`、`Number('') === 0`，
 *    配置里缺失/清空的字段会被悄悄当成 0（冷却变成不冷却、上限变成 0）。
 *
 * @param {unknown} v
 * @param {number} fallback 非法时的回退值
 * @returns {number}
 */
function numOr(v, fallback) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  return fallback
}

/**
 * 创建并发闸门。
 *
 * @param {object} o
 * @param {object}  [o.limits]  渠道 → 上限
 * @param {'reject'|'queue'} [o.mode='reject'] 满了怎么办（默认直接拒绝 ⇒ 由上层降级）
 * @param {number}  [o.waitTimeoutMs] queue 模式下的排队上限
 * @param {number}  [o.busyCooldownMs] 冷却**基础值**（指数退避的起点，默认 15s）
 * @param {number}  [o.maxCooldownMs]  冷却**封顶值**（默认 120s）
 */
export function createConcurrencyGate({
  limits = DEFAULT_LIMITS,
  mode = 'reject',
  waitTimeoutMs = 15_000,
  busyCooldownMs = COOLDOWN_BASE_MS,     // 上游会话释放窗口（实测约 10s，留余量）
  maxCooldownMs = COOLDOWN_MAX_MS,       // 指数退避封顶
  rateLimitCooldownMs = RATE_LIMIT_COOLDOWN_MS,
} = {}) {
  /**
   * 🔴 生效参数放进**可变对象**（契约 B 的 `rules.configurable` 硬要求）。
   *
   * 此前这些是解构出来的 const ⇒ 页面把「失败冷却多久」改成 5s 也**不会生效**
   * （只能重启进程），正是「页面能改但后端不读」的假开关。
   * 现在 `configure()` 是唯一写入口，读侧一律走 conf ⇒ 改了立刻生效。
   *
   * ⚠️ **默认值一字不改**（15s / 120s / 4s / DEFAULT_LIMITS）：不配置 ⇒ 行为与冻结版完全一致。
   */
  const conf = {
    limits: { ...(limits ?? {}) },
    busyCooldownMs: numOr(busyCooldownMs, COOLDOWN_BASE_MS),
    maxCooldownMs: numOr(maxCooldownMs, COOLDOWN_MAX_MS),
    rateLimitCooldownMs: numOr(rateLimitCooldownMs, RATE_LIMIT_COOLDOWN_MS),
  }

  /** provider -> { active, queue, busyCoolUntil, rateCoolUntil, streak429, last429At, lastSuccessAt, failRate } */
  const state = new Map()

  /**
   * 🔴 账号级并发计数（2026-11-06 改造，用户要求「自动切换区分每个账号的并发」）。
   *
   * 上游并发会话数是**按账号**计的（codearts 硬上限 3 / buddy 实测 2），不是按 provider。
   * 两个 codearts 账号共享 1 个名额时，A 占满后 B 永远被拒 ⇒ 「多账号摊薄」形同虚设。
   * 改为 `provider#accountId` 独立计数：每个账号各占自己的名额（并集 ≤ 上游总上限时互不干扰）。
   *
   * provider 级 `active` 保留为**展示聚合值**（该 provider 下所有账号 active 之和），
   * 准入判据必须是账号级 ⇒ 单独用 `activeByAccount` 计数。
   *
   * 无 accountId 时退化为 `provider#default` —— 与改造前行为完全一致（零回归）。
   */
  const activeByAccount = new Map()

  /** 账号键（provider + accountId 归一） */
  const accountKey = (provider, accountId) => {
    const acc = String(accountId ?? '').trim()
    return `${String(provider ?? 'default')}#${acc || 'default'}`
  }

  /** 从任意键（provider 或 accountKey）取 provider 部分 */
  const providerOf = (key) => String(key ?? '').split('#')[0] || 'default'

  /** 是否**真的**带了账号（空串/null/undefined 一律视为「没带」⇒ 走 `provider#default`） */
  const hasAccount = (accountId) => accountId !== undefined && accountId !== null && String(accountId).trim() !== ''

  /** 该 provider 下所有账号的 active 之和（展示/诊断用） */
  const providerActive = (provider) => {
    const prefix = providerOf(provider) + '#'
    let n = 0
    for (const [k, v] of activeByAccount) if (k.startsWith(prefix)) n += v
    return n
  }

  /** 空槽（每家的字段一次给全，避免「有的渠道没这个字段」的半状态） */
  const emptySlot = () => ({
    active: 0,
    queue: [],
    // 🔴 两种冷却**分开记账**（契约 v1.4 / task-11）：
    //    busyCoolUntil —— 并发满（上游会话未归还，15s 实测窗口）⇒ 重试**可以**放宽
    //    rateCoolUntil —— 429 请求级限流（指数退避 15/30/60/120s）⇒ 重试**永不放宽**
    //    混用一个 coolUntil 会导致「重试把 429 冷却也放宽」⇒ 在限流窗口里重打（白打）。
    busyCoolUntil: 0,
    rateCoolUntil: 0,
    streak429: 0,
    last429At: 0,
    lastSuccessAt: 0,
    // 行为反馈校准（契约 v1.1 §11）：失败率 EWMA + 样本数 + 最近失败时间
    failRate: 0,
    failSamples: 0,
    lastFailureAt: 0,
  })

  const limitOf = (provider) => {
    const v = conf.limits[provider]
    return Number.isFinite(v) && v > 0 ? v : conf.limits.default
  }

  /** 生效冷却截止时间（两种取最大） */
  const coolUntilOf = (s) => Math.max(Number(s?.busyCoolUntil) || 0, Number(s?.rateCoolUntil) || 0)
  const busyCoolLeft = (s) => Math.max(0, (Number(s?.busyCoolUntil) || 0) - Date.now())
  const rateCoolLeft = (s) => Math.max(0, (Number(s?.rateCoolUntil) || 0) - Date.now())

  /**
   * 按 accountKey 取槽（账号级）。无 accountId ⇒ `provider#default`，
   * 与改造前的单槽行为完全一致。
   */
  const slotOf = (provider, accountId) => {
    const key = accountKey(provider, accountId)
    if (!state.has(key)) state.set(key, emptySlot())
    return state.get(key)
  }

  /**
   * 归还一个名额：若 queue 模式有排队者 ⇒ 名额转交（active 不变）；
   * 否则该账号 active-- + activeByAccount--。
   */
  const releaseSlot = (key) => {
    const s = state.get(key)
    if (!s) return
    if (mode === 'queue') {
      const waiter = s.queue.shift()
      if (waiter) {
        clearTimeout(waiter.timer)
        waiter.resolve()          // 名额转交，active 不变
        return
      }
    }
    s.active = Math.max(0, s.active - 1)
    activeByAccount.set(key, Math.max(0, (activeByAccount.get(key) ?? 1) - 1))
  }

  const makeTicket = (key) => {
    let done = false
    return {
      ok: true,
      release: () => { if (done) return; done = true; releaseSlot(key) },
    }
  }

  /** 该 provider 下所有账号槽 */
  const slotsOfProvider = (provider) => {
    const prefix = providerOf(provider) + '#'
    const out = []
    for (const [k, v] of state) if (k.startsWith(prefix)) out.push({ key: k, s: v })
    return out
  }

  /**
   * ⚠️ **只读**取槽：不创建（诊断/探针路径用）。
   * `slotOf()` 会顺手建槽 —— 探针乱建槽会让 `snapshot()` 把"只看过一眼"的
   * provider 也列出来（`test/fail-rate` 明确要求「没访问过的渠道不进快照」）。
   */
  const peekSlots = (provider, accountId) => {
    if (accountId !== undefined && accountId !== null && String(accountId).trim() !== '') {
      const s = state.get(accountKey(provider, accountId))
      return s ? [{ key: accountKey(provider, accountId), s }] : []
    }
    return slotsOfProvider(provider)
  }

  /**
   * provider 级聚合统计 = `stats(provider)` 与 `snapshot()[provider]` 的**同一份口径**
   * （铁律：「显示 == 判定」，两处不得各算一套）。
   *
   * 🔴 账号级改造（2026-11-06）后两种冷却必须**分开**聚合：
   *    busyCoolingMs（并发满）/ rateCoolingMs（429 限流）各自取最大，
   *    `rateCooling` 只由 rateCoolingMs 决定 —— 混成一个值会让
   *    「并发忙冷却」被重试路径误判成「429 限流冷却」⇒ 兜底重试永远不放宽（可用性回归）。
   */
  const providerStats = (provider) => {
    const p = providerOf(provider)
    const limit = limitOf(p)
    const slots = slotsOfProvider(p)
    const accounts = slots.length || 1
    const active = slots.reduce((n, { s }) => n + (s.active ?? 0), 0)
    const busyCoolingMs = slots.reduce((m, { s }) => Math.max(m, busyCoolLeft(s)), 0)
    const rateCoolingMs = slots.reduce((m, { s }) => Math.max(m, rateCoolLeft(s)), 0)
    const maxOf = (f) => slots.reduce((m, { s }) => Math.max(m, Number(s[f]) || 0), 0)
    return {
      active,
      limit,
      // 负载比：active / (limit × 账号数)。单账号 ⇒ 与改造前一致（active/limit）
      ratio: active / Math.max(1, (Number(limit) || 0) * accounts),
      accounts,
      queued: slots.reduce((n, { s }) => n + (s.queue?.length ?? 0), 0),
      coolingMs: Math.max(busyCoolingMs, rateCoolingMs),
      busyCoolingMs,
      rateCoolingMs,
      rateCooling: rateCoolingMs > 0,
      busyCooling: busyCoolingMs > 0,
      streak429: maxOf('streak429'),
      last429At: maxOf('last429At'),
      lastSuccessAt: maxOf('lastSuccessAt'),
      // 行为反馈校准：失败率 EWMA（无样本 ⇒ 0，表示"没证据说它不可靠"）
      failRate: maxOf('failRate'),
      failSamples: slots.reduce((n, { s }) => n + (s.failSamples ?? 0), 0),
      lastFailureAt: maxOf('lastFailureAt'),
    }
  }

  return {
    mode,
    // 只读视图：反映 conf 的**当前**值（改配置走 configure()，默认值不变）
    get limits() { return conf.limits },
    get busyCooldownMs() { return conf.busyCooldownMs },
    get maxCooldownMs() { return conf.maxCooldownMs },
    get rateLimitCooldownMs() { return conf.rateLimitCooldownMs },

    /**
     * 尝试获取名额（**账号级**）。
     *
     * reject 模式（默认）：满了立即返回 `{ok:false, code:BUSY_CODE, ...}`——**不等待**。
     * queue 模式：等待直到有名额或超时。
     *
     * @param {string} provider 渠道 id
     * @param {string} [accountId] 账号 id（账号级并发；缺省 = 该渠道默认槽，与改造前一致）
     * @returns {Promise<{ok:true, release:Function, provider:string, accountId:string|null} |
     *                   {ok:false, code:string, provider:string, active:number, limit:number}>}
     */
    async acquire(provider, accountId) {
      const acc = String(accountId ?? '').trim() || null
      const key = accountKey(provider, acc)
      const s = slotOf(provider, acc)
      const lim = limitOf(providerOf(key))

      // 冷却期内直接判忙（不浪费一次往返）
      //   · rateCoolUntil（429 限流）：**任何重试都不得放宽**，只能等它自然到期
      //   · busyCoolUntil（并发满）：重试路径可用 relaxCooldown() 临时放行
      const rateLeft = rateCoolLeft(s)
      if (rateLeft > 0) {
        return {
          ok: false,
          code: BUSY_CODE,
          provider: providerOf(key),
          accountId: acc,
          active: s.active,
          limit: lim,
          cooling: true,
          rateCooling: true,
          busyCooling: busyCoolLeft(s) > 0,
          reason: `渠道 ${providerOf(key)}${acc ? '（' + acc + '）' : ''} 429 限流冷却中（剩 ${Math.ceil(rateLeft / 1000)}s，重试不放宽）`,
        }
      }
      const busyLeft = busyCoolLeft(s)
      if (busyLeft > 0) {
        return {
          ok: false,
          code: BUSY_CODE,
          provider: providerOf(key),
          accountId: acc,
          active: s.active,
          limit: lim,
          cooling: true,
          rateCooling: false,
          busyCooling: true,
          reason: `渠道 ${providerOf(key)}${acc ? '（' + acc + '）' : ''} 冷却中（上游会话未释放，剩 ${Math.ceil(busyLeft / 1000)}s）`,
        }
      }

      if (s.active < lim) {
        s.active += 1
        activeByAccount.set(key, (activeByAccount.get(key) ?? 0) + 1)
        return Object.assign(makeTicket(key), { provider: providerOf(key), accountId: acc })
      }

      // 满了
      if (mode !== 'queue') {
        return {
          ok: false,
          code: BUSY_CODE,
          provider: providerOf(key),
          accountId: acc,
          active: s.active,
          limit: lim,
          reason: `渠道 ${providerOf(key)}${acc ? '（' + acc + '）' : ''} 并发已满（${s.active}/${lim}）`,
        }
      }

      // queue 模式（保留，便于诊断/低并发场景）
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = s.queue.findIndex((q) => q.resolve === resolve)
          if (i >= 0) s.queue.splice(i, 1)
          reject(Object.assign(new Error(`渠道 ${providerOf(key)} 并发已满（上限 ${lim}），排队 ${waitTimeoutMs}ms 超时`), { code: BUSY_CODE }))
        }, waitTimeoutMs)
        // ⚠️ 不要 unref：排队超时必须真实触发
        s.queue.push({ resolve: () => resolve(Object.assign(makeTicket(key), { provider: providerOf(key), accountId: acc })), reject, timer })
      })
    },

    /**
     * **运行时重配置**（契约 B `rules.configurable` 的真实生效点）。
     *
     * 只改「传了且合法」的字段；非法/缺失一律忽略 ⇒ **默认值不被污染**
     * （零回归的关键：不配置时行为与冻结版完全一致）。
     * 已分配的名额不受影响，只影响后续 acquire / markBusy / markRateLimited 的判定。
     *
     * @param {{limits?:object, busyCooldownMs?:number, rateCooldownMs?:number,
     *          rateLimitCooldownMs?:number, maxCooldownMs?:number}} [patch]
     * @returns {object} 生效后的配置快照（见 `config()`）
     */
    configure(patch = {}) {
      const p = patch ?? {}
      // 冷却：允许 0（= 不冷却），只拒绝负数/非法值
      const busy = numOr(p.busyCooldownMs, NaN)
      if (Number.isFinite(busy) && busy >= 0) conf.busyCooldownMs = busy
      // 两个名字都认（配置里叫 rateCooldownMs，闸门内部叫 rateLimitCooldownMs）
      const rate = numOr(p.rateCooldownMs ?? p.rateLimitCooldownMs, NaN)
      if (Number.isFinite(rate) && rate >= 0) conf.rateLimitCooldownMs = rate
      const max = numOr(p.maxCooldownMs, NaN)
      if (Number.isFinite(max) && max > 0) conf.maxCooldownMs = max
      // 渠道并发上限：逐家覆盖（未列出的渠道仍走原值/default）
      const lim = p.limits
      if (lim && typeof lim === 'object' && !Array.isArray(lim)) {
        const next = { ...conf.limits }
        let changed = false
        for (const [k, v] of Object.entries(lim)) {
          const n = numOr(v, NaN)
          if (!Number.isFinite(n) || n <= 0) continue
          next[k] = n
          changed = true
        }
        if (changed) conf.limits = next
      }
      return this.config()
    },

    /** 生效配置快照（诊断页 / `rules.configurable` 的 value 同一口径） */
    config() {
      return {
        mode,
        limits: { ...conf.limits },
        busyCooldownMs: conf.busyCooldownMs,
        maxCooldownMs: conf.maxCooldownMs,
        rateLimitCooldownMs: conf.rateLimitCooldownMs,
      }
    },

    /**
     * 只读快照（诊断页用）。
     *
     * 🔴 形状是**契约**（`test/concurrency` / `test/cooldown-backoff` / `test/fail-rate`
     *    都按扁平 `snap[provider].active` 断言）：每家一个**扁平**对象，
     *    既有关键字一个都不能少 ——
     *    `active / limit / ratio / queued / coolingMs / busyCoolingMs / rateCoolingMs /
     *     rateCooling / streak429 / last429At / lastSuccessAt / failRate / failSamples`。
     *
     * 账号级明细只作为**新增**字段 `accounts` 附加（键 = `provider#accountId`；
     * 未传账号时就是 `provider#default`），**不改动**上面任何既有语义：
     *     `accounts[key] = { active, limit, queued, coolingMs, busyCoolingMs, rateCoolingMs,
     *                         rateCooling, streak429, last429At, lastSuccessAt,
     *                         failRate, failSamples }`
     *
     * provider 级数字 = 该 provider 下**所有账号**的聚合（`providerStats`，与 `stats()` 同口径）。
     * 只有被访问过（有槽）的 provider 进快照 —— 没访问过的照旧不出现。
     */
    snapshot() {
      const out = {}
      const providers = new Set()
      for (const k of state.keys()) providers.add(providerOf(k))
      for (const p of providers) {
        const st = providerStats(p)
        const accounts = {}
        for (const { key, s } of slotsOfProvider(p)) {
          accounts[key] = {
            active: s.active ?? 0,
            limit: st.limit,
            queued: s.queue?.length ?? 0,
            coolingMs: Math.max(0, coolUntilOf(s) - Date.now()),
            busyCoolingMs: busyCoolLeft(s),
            rateCoolingMs: rateCoolLeft(s),
            rateCooling: rateCoolLeft(s) > 0,
            streak429: s.streak429 ?? 0,
            last429At: s.last429At ?? 0,
            lastSuccessAt: s.lastSuccessAt ?? 0,
            failRate: Number(s.failRate) || 0,
            failSamples: s.failSamples ?? 0,
          }
        }
        out[p] = { ...st, accounts }
      }
      return out
    },

    /** 是否还有空位（供 UI 显示；任一账号有空位即 true） */
    hasRoom(provider) {
      const slots = slotsOfProvider(provider)
      const limit = limitOf(providerOf(provider))
      if (slots.length === 0) return true
      return slots.some(({ s }) => (s.active ?? 0) < limit)
    },

    /**
     * 标记「上游报并发已满」⇒ 该账号进入冷却期。
     *
     * 🔴 实测（2026-11-04）：codearts 上游名额在连接断开后**不会立刻归还**
     *    （同一 Session-Id 串行第二次就报满，约 10 秒后才恢复）。
     *    若冷却期内仍去重试，只是白白多花一次 2.7 秒往返，且**每次失败
     *    本身可能又占一个名额** ⇒ 自我恶化。
     *    ⇒ 报满后直接跳过该账号，让降级链上的其它候选顶上。
     *
     * **指数退避**（契约 §4）：连续第 n 次 429 ⇒ 冷却 = min(base·2^(n-1), max)
     *   n=1 → 15s，2 → 30s，3 → 60s，4 → 120s，5+ → 120s（封顶）
     * 理由：上游名额没释放时反复重试只会「自己打自己」；退避让冲突自然错开。
     * `markSuccess()` 会把 streak429 归零 ⇒ 下次冲突重新从 15s 起算。
     *
     * ⚠️ 显式传 `cooldownMs` 时**以显式值为准**（兼容既有测试/调用方）。
     *
     * @param {string} provider 渠道 id
     * @param {number} [cooldownMs] 显式冷却毫秒
     * @param {string} [accountId] 账号 id（缺省 = provider#default 槽）
     */
    markBusy(provider, cooldownMs, accountId) {
      const key = accountKey(provider, accountId)
      const s = slotOf(provider, accountId)
      const nowMs = Date.now()
      s.streak429 = (s.streak429 ?? 0) + 1
      s.last429At = nowMs
      const explicit = Number.isFinite(cooldownMs) && cooldownMs >= 0
      const backoff = Math.min(
        conf.busyCooldownMs * (2 ** (s.streak429 - 1)),
        conf.maxCooldownMs,
      )
      s.busyCoolUntil = nowMs + (explicit ? cooldownMs : backoff)
      return s.busyCoolUntil - nowMs
    },

    /**
     * 标记「该账号刚刚成功」⇒ 清冷却 + **重置连续 429 计数**。
     *
     * 为什么必须重置：退避曲线是「冲突密度」的度量；成功后密度归零，
     * 若继续从 120s 起算，会让一个已经恢复的账号长时间被跳过（可用性下降）。
     *
     * @param {string} provider 渠道 id
     * @param {string} [accountId] 账号 id
     */
    markSuccess(provider, accountId) {
      const key = accountKey(provider, accountId)
      const s = slotOf(provider, accountId)
      s.streak429 = 0
      s.busyCoolUntil = 0
      s.rateCoolUntil = 0
      s.lastSuccessAt = Date.now()
      // 成功 = 权重 0 的样本 ⇒ EWMA 按 α 衰减（不是清零：一次成功不足以洗白弱源）
      s.failRate = (1 - FAIL_EWMA_ALPHA) * (Number(s.failRate) || 0)
      s.failSamples = (s.failSamples ?? 0) + 1
      return true
    },

    /**
     * 记录一次**失败**，更新该账号的失败率 EWMA（契约 v1.1 §11 修订 2）。
     *
     * 为什么需要：准入排序只看 last429At 时，弱源只要"刚被 429 过"就会被跳过一阵，
     * 冷却一过又被均匀摊回去 ⇒ 一次 429 就是一次白打的尝试（多种子仿真里
     * seed 1234 反而恶化 +18%）。失败率是**跨请求的记忆**，能让弱源长期靠后。
     *
     * @param {string} provider 渠道 id
     * @param {string} [kind] 失败语义（'RATE_LIMIT' 权重 1.0，其它 0.6）
     * @param {string} [accountId] 账号 id
     * @returns {number} 更新后的 failRate（0..1）
     */
    markFailure(provider, kind = null, accountId) {
      const key = accountKey(provider, accountId)
      const s = slotOf(provider, accountId)
      const sample = failSampleWeight(kind)
      s.failRate = (s.failSamples ?? 0) === 0
        ? sample                                     // 首个样本直接定值（1.0 / 0.6）
        : FAIL_EWMA_ALPHA * sample + (1 - FAIL_EWMA_ALPHA) * (Number(s.failRate) || 0)
      s.failSamples = (s.failSamples ?? 0) + 1
      s.lastFailureAt = Date.now()
      return s.failRate
    },

    /**
     * 单个渠道的**统计快照**（准入器用；契约 §4）。
     *
     * 🔴 账号级改造（2026-11-06）：`active` = 该 provider 下**所有账号**的并发之和；
     * `accounts` = 账号槽数；`ratio` = active / (limit × accounts) ⇒ 多账号时
     * 每家各占满仍报 1.0（不是单账号的 2.0），准入排序不被多账号误判为过载。
     *
     * 🔴 两种冷却**分开**给出：`busyCoolingMs`（并发满）/ `rateCoolingMs`（429 限流），
     * `rateCooling` 只由后者决定 —— 混在一起会让重试路径把 busy 冷却当成 429 限流
     * （⇒ 兜底重试永不放宽，`test/rate-cooldown` ②③ 明确要求分开）。
     *
     * @returns {{active:number, limit:number, ratio:number, accounts:number, queued:number,
     *            coolingMs:number, busyCoolingMs:number, rateCoolingMs:number,
     *            rateCooling:boolean, busyCooling:boolean, streak429:number,
     *            last429At:number, lastSuccessAt:number}}
     */
    stats(provider) {
      return providerStats(provider)
    },

    /**
     * **临时放行**一个正在冷却的渠道（只清冷却窗口，**不动 streak429**）。
     *
     * 用途：整轮候选都被冷却/忙挡住时，adapter 做一次**有界兜底重试**（每次请求至多一次）。
     * 为什么允许：冷却只是「省一次注定失败的往返」的优化，**不是授权**；
     * 若把它当硬闸，短时限流会把整轮请求打成失败（可用性回归）。
     * 失败会重新 markBusy ⇒ streak429 继续累加、冷却按指数退避变长（不会越放越松）。
     *
     * @param {string} provider 渠道 id
     * @param {string} [accountId] 账号 id（缺省 = 该 provider 下**全部**账号槽）
     * @returns {boolean} 之前是否真的在冷却
     */
    relaxCooldown(provider, accountId) {
      const slots = accountId ? slotsOfProvider(provider).filter((x) => x.key === accountKey(provider, accountId)) : slotsOfProvider(provider)
      let was = false
      for (const { s } of slots) {
        was = was || busyCoolLeft(s) > 0
        s.busyCoolUntil = 0
      }
      // ⚠️ rateCoolUntil **绝不**在这里清零：429 限流窗口内重打只是白打（verifier 实测 54/110）
      return was
    },

    /**
     * 标记 429（**请求级限流**）⇒ 写 `rateCoolUntil`（指数退避 15/30/60/120s）。
     *
     * 🔴 与 `busyCoolUntil` 分开（契约 v1.4）：**重试路径永不放宽 rate 冷却**——
     *    在限流窗口里重打只是白打（verifier 实测 110 次 429 里 54 次是这种重打）。
     *
     * 与 `markBusy`（并发满，15s 起 = 上游会话未归还的实测窗口）分开：拿 15s 当限流冷却
     * 会把整个免费池踢出一段时间，把 paid_allowed 会话直接推向付费源（契约 v1.2 · P3）。
     * `streak429 / last429At / failRate` 语义不变。
     *
     * @param {string} provider 渠道 id
     * @param {string} [accountId] 账号 id
     * @returns {number} 本次冷却毫秒
     */
    markRateLimited(provider, accountId) {
      const s = slotOf(provider, accountId)
      const nowMs = Date.now()
      s.streak429 = (s.streak429 ?? 0) + 1
      s.last429At = nowMs
      const backoff = Math.min(
        conf.rateLimitCooldownMs * (2 ** (s.streak429 - 1)),
        conf.maxCooldownMs,
      )
      s.rateCoolUntil = nowMs + backoff
      return backoff
    },

    /** 该渠道是否在冷却期（任一账号在冷却 ⇒ true） */
    isCooling(provider, accountId) {
      const slots = peekSlots(provider, accountId)
      if (slots.length === 0) {
        // 无账号槽（还没 acquire 过 / 该账号没槽）：按默认槽判定，兼容改造前的单槽语义
        if (hasAccount(accountId)) return false
        return coolUntilOf(slotOf(provider, null)) > Date.now()
      }
      return slots.some(({ s }) => coolUntilOf(s) > Date.now())
    },

    /** 是否处于 **429 限流**冷却（重试路径必须跳过） */
    isRateCooling(provider, accountId) {
      const slots = peekSlots(provider, accountId)
      if (slots.length === 0) {
        if (hasAccount(accountId)) return false
        return rateCoolLeft(slotOf(provider, null)) > 0
      }
      return slots.some(({ s }) => rateCoolLeft(s) > 0)
    },

    /** 是否处于 **并发满** 冷却（重试路径可放宽） */
    isBusyCooling(provider, accountId) {
      const slots = peekSlots(provider, accountId)
      if (slots.length === 0) {
        if (hasAccount(accountId)) return false
        return busyCoolLeft(slotOf(provider, null)) > 0
      }
      return slots.some(({ s }) => busyCoolLeft(s) > 0)
    },

    /** 冷却剩余毫秒（0 表示不在冷却；取该 provider 下所有账号的最大值） */
    cooldownLeft(provider, accountId) {
      const slots = peekSlots(provider, accountId)
      if (slots.length === 0) {
        if (hasAccount(accountId)) return 0
        return Math.max(0, coolUntilOf(slotOf(provider, null)) - Date.now())
      }
      return slots.reduce((m, { s }) => Math.max(m, Math.max(0, coolUntilOf(s) - Date.now())), 0)
    },

    reset() { state.clear(); activeByAccount.clear() },
  }
}