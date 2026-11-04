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

/** 各渠道默认并发上限（参考包实测值 + 保守取整） */
export const DEFAULT_LIMITS = Object.freeze({
  codearts: 3,        // 上游硬限制：并发会话 3 个（TM.00001041）
  buddy: 2,
  workbuddy: 2,
  qoder: 2,
  cline: 2,
  minimax: 2,
  loomy: 2,
  kilo: 4,            // 免密源按 IP 限流，不是会话数
  ovh: 2,             // 2 req/min/IP
  default: 2,
})

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
 * 创建并发闸门。
 *
 * @param {object} o
 * @param {object}  [o.limits]  渠道 → 上限
 * @param {'reject'|'queue'} [o.mode='reject'] 满了怎么办（默认直接拒绝 ⇒ 由上层降级）
 * @param {number}  [o.waitTimeoutMs] queue 模式下的排队上限
 */
export function createConcurrencyGate({
  limits = DEFAULT_LIMITS,
  mode = 'reject',
  waitTimeoutMs = 15_000,
} = {}) {
  /** provider -> { active, queue } */
  const state = new Map()

  const limitOf = (provider) => {
    const v = limits[provider]
    return Number.isFinite(v) && v > 0 ? v : limits.default
  }

  const slotOf = (provider) => {
    if (!state.has(provider)) state.set(provider, { active: 0, queue: [] })
    return state.get(provider)
  }

  /**
   * 归还一个名额：若 queue 模式有排队者 ⇒ 名额转交（active 不变）；
   * 否则 active--。
   */
  const releaseSlot = (provider) => {
    const s = slotOf(provider)
    if (mode === 'queue') {
      const waiter = s.queue.shift()
      if (waiter) {
        clearTimeout(waiter.timer)
        waiter.resolve()          // 名额转交，active 不变
        return
      }
    }
    s.active = Math.max(0, s.active - 1)
  }

  const makeTicket = (provider) => {
    let done = false
    return {
      ok: true,
      release: () => { if (done) return; done = true; releaseSlot(provider) },
    }
  }

  return {
    mode,
    limits,

    /**
     * 尝试获取名额。
     *
     * reject 模式（默认）：满了立即返回 `{ok:false, code:BUSY_CODE, ...}`——**不等待**。
     * queue 模式：等待直到有名额或超时。
     *
     * @returns {Promise<{ok:true, release:Function} | {ok:false, code:string, active:number, limit:number}>}
     */
    async acquire(provider) {
      const key = String(provider ?? 'default')
      const s = slotOf(key)
      const lim = limitOf(key)

      if (s.active < lim) {
        s.active += 1
        return makeTicket(key)
      }

      // 满了
      if (mode !== 'queue') {
        return {
          ok: false,
          code: BUSY_CODE,
          provider: key,
          active: s.active,
          limit: lim,
          reason: `渠道 ${key} 并发已满（${s.active}/${lim}）`,
        }
      }

      // queue 模式（保留，便于诊断/低并发场景）
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = s.queue.findIndex((q) => q.resolve === resolve)
          if (i >= 0) s.queue.splice(i, 1)
          reject(Object.assign(new Error(`渠道 ${key} 并发已满（上限 ${lim}），排队 ${waitTimeoutMs}ms 超时`), { code: BUSY_CODE }))
        }, waitTimeoutMs)
        // ⚠️ 不要 unref：排队超时必须真实触发
        s.queue.push({ resolve: () => resolve(makeTicket(key)), reject, timer })
      })
    },

    /** 只读快照（诊断页用） */
    snapshot() {
      const out = {}
      for (const [k, s] of state) out[k] = { active: s.active, queued: s.queue.length, limit: limitOf(k) }
      return out
    },

    /** 是否还有空位（供 UI 显示） */
    hasRoom(provider) {
      const s = state.get(String(provider ?? 'default'))
      const lim = limitOf(String(provider ?? 'default'))
      return (s?.active ?? 0) < lim
    },

    reset() { state.clear() },
  }
}