/**
 * cs-myfree — 渠道并发闸门（解决「中断停摆次数过多」）
 *
 * 🔴 真实根因（2026-11-03/04 实测）：
 *    codearts 上游有**并发会话上限（3 个）**，超了直接 400 TM.00001041。
 *    而 adapter 逐候选重试、失败切换时**不释放上一个流** ⇒ 会话名额被占满
 *    ⇒ 后续所有请求全部失败（用户看到的就是「连续中断停摆」）。
 *
 *    实测证据：探测脚本连发 4 个未消费的流后，第 2~4 个全部返回
 *    「并发会话已满」；等 30 秒（会话自然过期）后立刻恢复 200。
 *
 * 本模块提供**按渠道的并发闸门**：
 *   · 每个渠道有上限（默认 3，可按渠道覆盖）
 *   · 超限时**排队等待**（不直接失败），有超时兜底
 *   · 用完/异常都必须 `release()`，否则名额泄漏
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

/**
 * 创建并发闸门。
 * @param {object} o
 * @param {object} [o.limits] 渠道 → 上限
 * @param {number} [o.waitTimeoutMs] 排队最长等待（超时则抛错，不静默卡死）
 * @param {(provider:string)=>number} [o.now]
 */
export function createConcurrencyGate({ limits = DEFAULT_LIMITS, waitTimeoutMs = 30_000 } = {}) {
  /** provider -> { active:number, queue:Array<{resolve,reject,timer}> } */
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
   * 有排队者 ⇒ 名额**转交**（active 不变）；没排队者 ⇒ 名额归还（active--）。
   * ⚠️ 早先写成「总是 active++」⇒ 释放后 active 反而变大，名额永久泄漏。
   */
  const next = (provider) => {
    const s = slotOf(provider)
    const waiter = s.queue.shift()
    if (!waiter) {
      s.active = Math.max(0, s.active - 1)   // 归还
      return
    }
    clearTimeout(waiter.timer)
    // 名额直接转交给排队者：active 保持不变
    waiter.resolve()
  }

  return {
    /**
     * 获取一个名额（可能排队）。
     * @returns {Promise<{release:Function}>}
     */
    async acquire(provider) {
      const key = String(provider ?? 'default')
      const s = slotOf(key)
      /** 幂等释放：重复调用只生效一次（防 active 被减成负数） */
      const releaseOnce = () => {
        let done = false
        return () => { if (done) return; done = true; next(key) }
      }
      const lim = limitOf(key)
      if (s.active < lim) {
        s.active += 1
        return { release: releaseOnce() }
      }
      // 排队
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = s.queue.findIndex((q) => q.resolve === resolve)
          if (i >= 0) s.queue.splice(i, 1)
          reject(Object.assign(new Error(`渠道 ${key} 并发已满（上限 ${lim}），排队 ${waitTimeoutMs}ms 超时`), { code: 'RATE_LIMIT' }))
        }, waitTimeoutMs)
        // ⚠️ 不要 unref：排队超时是用户可感知的行为，必须保证定时器真实触发。
        //    （unref 后若事件循环无其它任务，进程会提前退出/测试挂起）
        s.queue.push({
          resolve: () => resolve({ release: releaseOnce() }),
          reject,
          timer,
        })
      })
    },

    /** 只读快照（诊断页用） */
    snapshot() {
      const out = {}
      for (const [k, s] of state) out[k] = { active: s.active, queued: s.queue.length, limit: limitOf(k) }
      return out
    },

    /** 重置（测试用） */
    reset() { state.clear() },
  }
}
