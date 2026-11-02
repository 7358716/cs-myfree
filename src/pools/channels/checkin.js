/**
 * cs-myfree — 签到调度
 *
 * 设计依据：v3 §11.2 S3 + 06 号报告的「记账口径」教训。
 *
 * 🔴 关键坑（06 号报告实测，审查 PR !33）：
 *    **不能用 `claimed + alreadyClaimed` 记账**，必须用各渠道声明的
 *    `summary.coversToday`。原因：Qoder 活动每日 **10:00 (UTC+8)** 才刷新，
 *    上午那轮的 `CLAIMED` 属于**昨天**，拿它记账会让当天额度**整天漏领**。
 *
 * @module cs-myfree/pools/channels/checkin
 */

/** 默认签到时间（UTC+8 的 10:05，避开 Qoder 的 10:00 刷新边界） */
export const DEFAULT_CHECKIN_HOUR = 10
export const DEFAULT_CHECKIN_MINUTE = 5

/**
 * 判断「今天是否还需要跑签到」。
 *
 * @param {object} state 持久化状态 { lastDate, lastRunAt, channels }
 * @param {{now?:()=>number, hour?:number, minute?:number}} opts
 * @returns {{due:boolean, reason:string, dateKey:string}}
 */
export function isDue(state = {}, opts = {}) {
  const now = opts.now ?? (() => Date.now())
  const hour = opts.hour ?? DEFAULT_CHECKIN_HOUR
  const minute = opts.minute ?? DEFAULT_CHECKIN_MINUTE
  const t = new Date(now())
  const dateKey = toDateKey(t)
  const dueAt = new Date(t)
  dueAt.setHours(hour, minute, 0, 0)

  if (state?.lastDate === dateKey) return { due: false, reason: '今天已跑过', dateKey }
  if (t < dueAt) return { due: false, reason: `未到签到时间（${hour}:${String(minute).padStart(2, '0')}）`, dateKey }
  return { due: true, reason: '到点且今天未跑', dateKey }
}

/** YYYY-MM-DD（本地时区，不是 UTC —— 否则跨零点会算错天） */
export function toDateKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 汇总一轮签到结果。
 *
 * ⚠️ 记账口径：只认 coversToday=true 的渠道算「今天已覆盖」，
 *    其余一律记 pending（下次再试），**绝不因为 claimed>0 就认为今天完成**。
 *
 * @param {Array<{provider:string, claimed:number, alreadyClaimed:number, failed:number, coversToday:boolean, gain?:string}>} results
 */
export function summarize(results = []) {
  let covered = 0, pending = 0, failedChannels = 0
  const detail = []
  for (const r of results) {
    const isCovered = r.coversToday === true
    if (isCovered) covered++
    else if ((r.failed ?? 0) > 0) { failedChannels++; pending++ }
    else pending++
    detail.push({
      provider: r.provider,
      claimed: r.claimed ?? 0,
      alreadyClaimed: r.alreadyClaimed ?? 0,
      failed: r.failed ?? 0,
      coversToday: isCovered,
      gain: r.gain ?? null,
    })
  }
  return {
    covered,
    pending,
    failedChannels,
    detail,
    // 只有全部渠道都 coversToday 才算「今天完成」
    allCovered: pending === 0 && results.length > 0,
    text: `${covered} 家已覆盖今日，${pending} 家待补（${failedChannels} 家有失败）`,
  }
}

/**
 * 下一轮该在什么时候跑。
 * 若有 pending，则 2 小时后重试；否则等明天。
 */
export function nextRunAt(state = {}, opts = {}) {
  const now = opts.now ?? (() => Date.now())
  const h = opts.hour ?? DEFAULT_CHECKIN_HOUR
  const m = opts.minute ?? DEFAULT_CHECKIN_MINUTE
  const t = new Date(now())

  if (state?.pending > 0 && state?.lastDate === toDateKey(t)) {
    return now() + 2 * 3600 * 1000     // 有欠账 ⇒ 2 小时后重试
  }
  const next = new Date(t)
  next.setHours(h, m, 0, 0)
  if (next <= t) next.setDate(next.getDate() + 1)
  return next.getTime()
}
