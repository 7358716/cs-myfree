/**
 * cs-myfree — 用量账本（费用分析的数据基础）
 *
 * 设计依据：v3 §8 + 08 号报告的两层失效教训：
 *  第 1 层：`costOfCall` 缺 import 导致 `cost` 恒 0（已修）
 *  第 2 层（更隐蔽）：jsonl **从不重写**，历史 0 只被内存重算覆盖
 *    ⇒ 任何「直接读 jsonl」的消费者（看护/审计）都看不到修正值
 *
 * 本模块的应对：
 *  · `cost` 与 `free` **严格分开**（免费调用记 cost=0 但 free=true）
 *  · 价格未知记 `costUnknown=true`，**绝不当 0**
 *  · 提供按天聚合（UTC+8 日界），并保留原始明细
 *
 * @module cs-myfree/audit/ledger
 */

/** UTC+8 日界（与 dsh-providers-hub 的 token-ledger 一致） */
export function dateKeyCN(at = Date.now()) {
  const t = new Date(at + 8 * 3600 * 1000)
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

/**
 * 构造一条账本记录。
 * @param {object} o
 */
export function makeRecord(o = {}) {
  const {
    provider, model, at = Date.now(),
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    costCNY, paid = false, ok = true, code = null,
    channel = null, account = null, preset = null,
  } = o

  const costUnknown = paid === true && !Number.isFinite(costCNY)
  return {
    at,
    date: dateKeyCN(at),
    provider: provider ?? null,
    channel: channel ?? provider ?? null,
    account: account ?? null,
    model: model ?? null,
    preset: preset ?? null,
    paid: paid === true,
    free: paid !== true,
    // 严格区分：免费=0、未知=null
    costCNY: paid !== true ? 0 : (Number.isFinite(costCNY) ? costCNY : null),
    costUnknown,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
    cacheReadTokens: Number.isFinite(cacheReadTokens) ? cacheReadTokens : null,
    cacheWriteTokens: Number.isFinite(cacheWriteTokens) ? cacheWriteTokens : null,
    ok: ok === true,
    code: code ?? null,
  }
}

/** 按天 × 模型 × 渠道聚合 */
export function aggregate(records = []) {
  const byDay = new Map()
  for (const r of records) {
    const k = r.date
    if (!byDay.has(k)) byDay.set(k, { date: k, calls: 0, free: 0, paid: 0, fail: 0, costCNY: 0, costUnknown: 0, inputTokens: 0, outputTokens: 0, byModel: new Map(), byChannel: new Map() })
    const d = byDay.get(k)
    d.calls++
    if (r.free) d.free++
    if (r.paid) d.paid++
    if (!r.ok) d.fail++
    if (r.costUnknown) d.costUnknown++
    else if (Number.isFinite(r.costCNY)) d.costCNY += r.costCNY
    if (Number.isFinite(r.inputTokens)) d.inputTokens += r.inputTokens
    if (Number.isFinite(r.outputTokens)) d.outputTokens += r.outputTokens

    const mk = r.model ?? '(unknown)'
    d.byModel.set(mk, (d.byModel.get(mk) ?? 0) + 1)
    const ck = r.channel ?? '(unknown)'
    d.byChannel.set(ck, (d.byChannel.get(ck) ?? 0) + 1)
  }

  return [...byDay.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((d) => ({
      ...d,
      costCNY: Number(d.costCNY.toFixed(6)),
      byModel: Object.fromEntries([...d.byModel.entries()].sort((a, b) => b[1] - a[1])),
      byChannel: Object.fromEntries([...d.byChannel.entries()].sort((a, b) => b[1] - a[1])),
    }))
}

/** 今日花费（供付费闸门用） */
export function spentToday(records = [], at = Date.now()) {
  const k = dateKeyCN(at)
  return records
    .filter((r) => r.date === k && Number.isFinite(r.costCNY))
    .reduce((s, r) => s + r.costCNY, 0)
}

/** 本月花费 */
export function spentThisMonth(records = [], at = Date.now()) {
  const ym = dateKeyCN(at).slice(0, 7)
  return records
    .filter((r) => String(r.date).startsWith(ym) && Number.isFinite(r.costCNY))
    .reduce((s, r) => s + r.costCNY, 0)
}

/** 失败分布（故障追溯） */
export function failureBreakdown(records = []) {
  const byCode = new Map()
  for (const r of records) {
    if (r.ok) continue
    const k = r.code ?? 'UNKNOWN'
    byCode.set(k, (byCode.get(k) ?? 0) + 1)
  }
  const total = records.length || 1
  const failTotal = [...byCode.values()].reduce((a, b) => a + b, 0)
  return {
    failTotal,
    failRate: Number(((failTotal / total) * 100).toFixed(1)),
    byCode: Object.fromEntries([...byCode.entries()].sort((a, b) => b[1] - a[1])),
    // 失明率：UNKNOWN 占比（v3 V3 要求 < 5%）
    blindRate: Number((((byCode.get('UNKNOWN') ?? 0) / total) * 100).toFixed(1)),
  }
}
