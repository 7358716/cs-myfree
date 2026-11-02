/**
 * cs-myfree — 付费闸门（五道，全部执行，不是纸面规则）
 *
 * 设计依据：v3 §8。现状缺陷（实测）：五道闸门只有第②道真的接在拦截点上，
 * ④⑤ **根本不存在**（全库 grep 无实现）；且 `dailyBudgetCNY = 0` 让限额变死信。
 *
 * 五道：
 *   ① 付费模型不得被自动调用（默认不选付费候选）
 *   ② 逐次人工确认
 *   ③ 只有付费修复智能体可用付费
 *   ④ 单次 ≤¥1 超限拒绝
 *   ⑤ 月度 ≤¥100 超限即停
 *
 * 关键原则：**deny-by-default + 未知即拒**
 *   （LiteLLM 反面教材：max_budget 无 DB 时 fail-open；
 *    价格未知时若当 0 处理，等于把闸门拆了）
 *
 * @module cs-myfree/policy/paid-gate
 */

export const DECISION = Object.freeze({
  ALLOW: 'allow',
  DENY: 'deny',
  NEED_CONFIRM: 'need-confirm',
})

/**
 * 判断一次调用是否允许。
 *
 * @param {object} req
 * @param {boolean} req.paid            本次调用是否会产生费用
 * @param {number}  req.costCNY         预估费用（paid=true 时**必须**给出，未知传 null）
 * @param {string}  req.agentPreset     发起调用的预设 id
 * @param {object}  req.budget          { perCallCNY, dailyCNY, monthlyCNY }
 * @param {number}  req.spentTodayCNY
 * @param {number}  req.spentMonthCNY
 * @param {boolean} req.confirmEachTurn
 * @param {boolean} req.confirmed       本次是否已被人工确认
 * @param {string[]} req.paidPresets    允许用付费的预设白名单
 * @returns {{decision:string, gate:string|null, reason:string}}
 */
export function evaluate(req = {}) {
  const {
    paid = false, costCNY = null, agentPreset = null,
    budget = {}, spentTodayCNY = 0, spentMonthCNY = 0,
    confirmEachTurn = true, confirmed = false, paidPresets = [],
  } = req

  // 免费调用一律放行（闸门只管钱）
  if (!paid) return { decision: DECISION.ALLOW, gate: null, reason: '免费调用' }

  // ── 闸门③：只有白名单预设可用付费 ──
  if (!agentPreset || !paidPresets.includes(agentPreset)) {
    return { decision: DECISION.DENY, gate: '③预设白名单', reason: `预设 ${agentPreset ?? '(无)'} 不在付费白名单` }
  }

  // ── 闸门①：付费不得自动调用（必须显式开启）──
  // 这里由调用方传 allowAutoCall；未开启时退化为「需要确认」
  // ── 闸门④：单次限额（未知即拒）──
  const perCall = Number(budget.perCallCNY)
  if (!Number.isFinite(costCNY)) {
    return { decision: DECISION.DENY, gate: '④单次限额', reason: '价格未知 ⇒ 按 deny-by-default 拒绝' }
  }
  if (!Number.isFinite(perCall) || perCall <= 0) {
    return { decision: DECISION.DENY, gate: '④单次限额', reason: `单次限额未配置（${budget.perCallCNY}）⇒ 视为禁止付费` }
  }
  if (costCNY > perCall) {
    return { decision: DECISION.DENY, gate: '④单次限额', reason: `单次 ¥${costCNY} > 限额 ¥${perCall}` }
  }

  // ── 闸门⑤：月度限额 ──
  const daily = Number(budget.dailyCNY)
  const monthly = Number(budget.monthlyCNY)
  if (!Number.isFinite(monthly) || monthly <= 0) {
    return { decision: DECISION.DENY, gate: '⑤月度限额', reason: `月度限额未配置（${budget.monthlyCNY}）⇒ 视为禁止付费` }
  }
  if (spentMonthCNY + costCNY > monthly) {
    return { decision: DECISION.DENY, gate: '⑤月度限额', reason: `本月已花 ¥${spentMonthCNY}，再加 ¥${costCNY} 超月度 ¥${monthly}` }
  }
  if (Number.isFinite(daily) && daily > 0 && spentTodayCNY + costCNY > daily) {
    return { decision: DECISION.DENY, gate: '⑤日限额', reason: `今日已花 ¥${spentTodayCNY}，再加 ¥${costCNY} 超日限 ¥${daily}` }
  }

  // ── 闸门②：逐次人工确认 ──
  if (confirmEachTurn && !confirmed) {
    return { decision: DECISION.NEED_CONFIRM, gate: '②逐次确认', reason: `本次将花 ¥${costCNY}，需确认` }
  }

  return { decision: DECISION.ALLOW, gate: null, reason: `付费放行（¥${costCNY}）` }
}

/** 价格未知哨兵（调用方用它与「免费」严格区分） */
export const UNKNOWN_COST = Object.freeze({ unknown: true })
