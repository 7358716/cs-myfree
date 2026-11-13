/**
 * cs-myfree — 账本（**完全自有，不读任何外部插件**）
 *
 * 设计原则（主管明确要求「独立使用」）：
 *   · 只读写 **自己的** `~/.dsh/cs-myfree/ledger.jsonl`
 *   · **绝不**读 my-free-model / jet-hub / 任何其它插件的数据
 *   · 没装其它插件的新机器上，一切功能照常
 *
 * 记录格式（每行一条 JSON）：
 *   { at, day, provider, model, in, out, cost, paid, ok, code, ms, billingTier, billing }
 *
 * 分账口径（契约 §3）：
 *   · `billingTier`：这一笔发生在**什么授权**下（'free_only' | 'paid_allowed'）
 *   · `billing`：这个候选本身是**免费还是付费**（'free' | 'paid' | 'unknown'）
 *   · 历史行没有这两个字段 ⇒ 归 'unknown'，**不计入 paid 占比的分子/分母**（口径透明）
 *
 * @module cs-myfree/audit/sources
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { readFile, mkdir, appendFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function dshHomePath(dshHome) {
  return dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
}

import { fourDimFailureBreakdown } from './ledger.js'

/** 自己的账本目录 */
export function ledgerDir(dshHome) {
  return join(dshHomePath(dshHome), 'cs-myfree')
}

export function ledgerFile(dshHome) {
  return join(ledgerDir(dshHome), 'ledger.jsonl')
}

/** UTC+8 日界 */
export function dateKeyCN(at) {
  const t = new Date(Number(at) + 8 * 3600 * 1000)
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

/** 账本里的授权标签归一（非法/缺失 ⇒ 'unknown'，**不默认成 free_only**：那会把未知算成免费） */
export function normalizeLedgerTier(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return s === 'free_only' || s === 'paid_allowed' ? s : 'unknown'
}

/** 账本里的候选成本属性归一（非法/缺失 ⇒ 'unknown'） */
export function normalizeLedgerBilling(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return s === 'free' || s === 'paid' ? s : 'unknown'
}

/**
 * 记一条调用（追加写，失败不影响主流程）。
 * @param {object} rec
 */
export async function appendRecord(rec, { dshHome } = {}) {
  try {
    const dir = ledgerDir(dshHome)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const at = Number(rec.at) || Date.now()
    const line = JSON.stringify({
      at,
      day: rec.day || dateKeyCN(at),
      provider: rec.provider ?? null,
      // 🔴 账号级隔离（多账号并发统计）：记录 accountId，UI 可按「codearts#账号A」展示成功/失败率
      account: rec.account ?? null,
      model: rec.model ?? null,
      in: Number(rec.in) || 0,
      out: Number(rec.out) || 0,
      // 🔴 cost=null 表示「价格未知」——不能折成 0（把未知当免费是财务上最危险的错误）
      cost: Number.isFinite(rec.cost) ? rec.cost : null,
      paid: rec.paid === true,
      ok: rec.ok !== false,
      // 🔴 失败语义（kind）与原始码都记：UI 可按 kind 四维聚合（provider+model+kind+accountId）
      kind: rec.kind ?? null,
      code: rec.code ?? null,
      ms: Number(rec.ms) || null,
      // 分账字段：每条记录都带（上游没给 ⇒ 'unknown'，绝不猜）
      billingTier: normalizeLedgerTier(rec.billingTier),
      billing: normalizeLedgerBilling(rec.billing),
      // 🔴 切换口径（契约 A3）：这一笔是不是「切换后成功」+ 本轮第几次尝试才成功。
      //    历史行没有这两个键 ⇒ false / 1（老数据按"没切换、一次成功"读，口径透明）。
      switched: rec.switched === true,
      attempts: Number(rec.attempts) || 1,
    }) + '\n'
    await appendFile(ledgerFile(dshHome), line, { mode: 0o600 })
    return true
  } catch {
    return false   // 记账失败绝不影响对话
  }
}

/**
 * 读自己的账本并聚合。
 * @param {{dshHome?:string, limit?:number, fromMs?:number}} opts
 */
export async function readSpend({ dshHome, limit = 200000, fromMs = 0 } = {}) {
  const file = ledgerFile(dshHome)
  const byDay = new Map()
  const byProvider = new Map()
  // 🔴 失败/中断统计（用户要求页面可见）
  const byCode = new Map()
  const byFailProvider = new Map()
  // 🔴 分账聚合：三个桶**恒定存在**（页面/指标不用处理「字段缺失」）
  const byBillingTier = new Map([
    ['free_only', { billingTier: 'free_only', calls: 0, paidCalls: 0, failed: 0, costCNY: 0, costUnknown: 0 }],
    ['paid_allowed', { billingTier: 'paid_allowed', calls: 0, paidCalls: 0, failed: 0, costCNY: 0, costUnknown: 0 }],
    ['unknown', { billingTier: 'unknown', calls: 0, paidCalls: 0, failed: 0, costCNY: 0, costUnknown: 0 }],
  ])
  const recentFailures = []
  // 🔴 切换口径（契约 A3）：口径同 adapter.switchSnapshot()（**口径 A**）
  //    total     = 记了 switched=true 的条数（切换后成功）
  //    分母      = **成功**条数（每一次成功都是一次"切换机会"）
  //    为什么不用账本行数当分母：失败行也会写账本，它们不构成"切换机会"
  const bySwitchProvider = new Map()
  const bySwitchModel = new Map()
  let switchTotal = 0
  let successCalls = 0
  let total = 0, failed = 0, paidCount = 0, costTotal = 0, costUnknown = 0
  let lastAt = null
  // 🔴 四维失败聚合（用户需求）：累积精简字段，返回时算 fourDim
  const fourDimRecords = []

  try {
    const stream = createReadStream(file, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (typeof o.at !== 'number' || o.at < fromMs) continue
      total++
      if (lastAt === null || o.at > lastAt) lastAt = o.at
      // 🔴 四维精简字段（用户需求：按 provider+model+kind+accountId 聚合失败语义）
      fourDimRecords.push({
        provider: o.provider ?? null,
        model: o.model ?? null,
        kind: o.kind ?? o.code ?? null,
        account: o.account ?? null,
        ok: o.ok !== false,
      })
      if (o.ok === false) {
        failed++
        const code = o.code ?? 'UNKNOWN'
        byCode.set(code, (byCode.get(code) ?? 0) + 1)
        const pv = o.provider || '(unknown)'
        byFailProvider.set(pv, (byFailProvider.get(pv) ?? 0) + 1)
        if (recentFailures.length < 20) {
          recentFailures.push({ at: o.at, provider: pv, model: o.model ?? null, code, ms: o.ms ?? null })
        }
      }

      const day = o.day || dateKeyCN(o.at)
      if (!byDay.has(day)) byDay.set(day, { date: day, calls: 0, costCNY: 0, costUnknown: 0, in: 0, out: 0, paid: 0, providers: new Set() })
      const d = byDay.get(day)
      d.calls++
      d.in += Number(o.in) || 0
      d.out += Number(o.out) || 0
      if (o.paid === true) { d.paid++; paidCount++ }
      if (Number.isFinite(o.cost) && o.cost > 0) { d.costCNY += o.cost; costTotal += o.cost }
      else if (o.cost === null && o.paid === true) { d.costUnknown++; costUnknown++ }
      else if (o.paid === true && !Number.isFinite(o.cost)) { d.costUnknown++; costUnknown++ }
      if (o.provider) d.providers.add(o.provider)

      // 分账：历史行（没有 billingTier）归 'unknown'，不进 paid 占比分子/分母
      const bTier = normalizeLedgerTier(o.billingTier)
      const bt = byBillingTier.get(bTier)
      bt.calls++
      if (o.paid === true) bt.paidCalls++
      if (o.ok === false) bt.failed++
      if (Number.isFinite(o.cost) && o.cost > 0) bt.costCNY += o.cost
      else if (o.paid === true) bt.costUnknown++

      // ── 切换口径（契约 A3）──
      // ⚠️ 历史行没有 switched/attempts 字段 ⇒ switched=false，不进分子（口径透明）
      const switched = o.switched === true
      const isSuccess = o.ok !== false
      if (isSuccess) successCalls++
      if (switched) {
        switchTotal++
        const pv0 = o.provider || '(unknown)'
        bySwitchProvider.set(pv0, (bySwitchProvider.get(pv0) ?? 0) + 1)
        const mk = `${pv0}/${o.model ?? ''}`
        bySwitchModel.set(mk, (bySwitchModel.get(mk) ?? 0) + 1)
      }

      const p = o.provider || '(unknown)'
      if (!byProvider.has(p)) {
        byProvider.set(p, {
          provider: p, calls: 0, in: 0, out: 0, failed: 0, costCNY: 0, switched: 0,
          // per-model 子维度（契约 A3）：{ [model]: {calls, failed, in, out, switched} }
          models: new Map(),
        })
      }
      const bp = byProvider.get(p)
      bp.calls++
      bp.in += Number(o.in) || 0
      bp.out += Number(o.out) || 0
      if (o.ok === false) bp.failed++
      if (Number.isFinite(o.cost)) bp.costCNY += o.cost
      if (switched) bp.switched++

      const mName = o.model ?? '(unknown)'
      if (!bp.models.has(mName)) bp.models.set(mName, { model: mName, calls: 0, failed: 0, in: 0, out: 0, switched: 0 })
      const bm = bp.models.get(mName)
      bm.calls++
      bm.in += Number(o.in) || 0
      bm.out += Number(o.out) || 0
      if (o.ok === false) bm.failed++
      if (switched) bm.switched++

      if (total >= limit) break
    }
  } catch (err) {
    // 文件不存在 = 新装机器 = 正常情况，不是错误
    const emptySplit = {
      byBillingTier: {
        free_only: { billingTier: 'free_only', calls: 0, paidCalls: 0, failed: 0, costCNY: 0, costUnknown: 0 },
        paid_allowed: { billingTier: 'paid_allowed', calls: 0, paidCalls: 0, failed: 0, costCNY: 0, costUnknown: 0 },
        unknown: { billingTier: 'unknown', calls: 0, paidCalls: 0, failed: 0, costCNY: 0, costUnknown: 0 },
      },
      billingSplit: {
        knownCalls: 0, unknownCalls: 0, paidCallsOfKnown: 0, paidShareOfKnown: null,
        formula: 'paid 调用数 / (free_only + paid_allowed) 调用数；unknown 不计入分子/分母',
      },
    }
    const emptySwitches = { total: 0, switchSuccessRate: null, byProvider: {}, byModel: {} }
    if (err?.code !== 'ENOENT') {
      return { ok: false, reason: String(err?.message ?? err).slice(0, 120), file, days: [], providers: [], total: 0, switches: emptySwitches, ...emptySplit }
    }
    return { ok: true, empty: true, file, days: [], providers: [], total: 0, switches: emptySwitches, ...emptySplit }
  }

  return {
    ok: true,
    empty: total === 0,
    file,
    total,
    failed,
    paidCount,
    costTotalCNY: Number(costTotal.toFixed(6)),
    costUnknown,
    lastAt,
    failures: {
      failTotal: failed,
      callsTotal: total,
      failRate: total > 0 ? Number(((failed / total) * 100).toFixed(1)) : 0,
      byCode: Object.fromEntries([...byCode.entries()].sort((a, b) => b[1] - a[1])),
      byProvider: Object.fromEntries([...byFailProvider.entries()].sort((a, b) => b[1] - a[1])),
      recent: recentFailures.slice(0, 20),
    },
    byBillingTier: Object.fromEntries([...byBillingTier.entries()].map(([k, v]) => [k, {
      ...v, costCNY: Number(v.costCNY.toFixed(6)),
    }])),
    billingSplit: (() => {
      const tierOf = (k) => byBillingTier.get(k)
      const knownCalls = tierOf('free_only').calls + tierOf('paid_allowed').calls
      const knownPaid = tierOf('free_only').paidCalls + tierOf('paid_allowed').paidCalls
      return {
        knownCalls,
        unknownCalls: tierOf('unknown').calls,
        paidCallsOfKnown: knownPaid,
        // 口径：只算带授权标签的记录；历史行（unknown）不进分子/分母
        paidShareOfKnown: knownCalls > 0 ? Number((knownPaid / knownCalls).toFixed(4)) : null,
        formula: 'paid 调用数 / (free_only + paid_allowed) 调用数；unknown 不计入分子/分母',
      }
    })(),
    days: [...byDay.values()]
      .map((d) => ({ ...d, providers: [...d.providers], costCNY: Number(d.costCNY.toFixed(6)) }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 30),
    // 🔴 切换口径（契约 A3，与 adapter.switchSnapshot() 同口径）
    //    分母 = **成功调用数**（每一次成功都是一次"切换机会"；失败行不构成机会）
    switches: {
      total: switchTotal,
      switchSuccessRate: successCalls > 0 ? Number(((switchTotal / successCalls) * 100).toFixed(1)) : null,
      byProvider: Object.fromEntries([...bySwitchProvider.entries()].sort((a, b) => b[1] - a[1])),
      byModel: Object.fromEntries([...bySwitchModel.entries()].sort((a, b) => b[1] - a[1])),
      successCalls,
      formula: '切换成功条数 / 成功调用条数；历史行（无 switched 字段）视为未切换',
    },
    providers: [...byProvider.values()]
      .map((p) => ({
        ...p,
        costCNY: Number(p.costCNY.toFixed(6)),
        // per-model 子维度（Map ⇒ 普通对象；按 calls 降序，页面上头条目在最前）
        models: Object.fromEntries([...p.models.entries()]
          .map(([k, v]) => [k, { ...v }])
          .sort((a, b) => b[1].calls - a[1].calls)),
      }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 20),
    // 🔴 四维失败聚合（用户需求：按 provider+model+kind+accountId 聚合）
    fourDim: fourDimFailureBreakdown(fourDimRecords),
  }
}

/** 账本文件概况 */
export async function ledgerOverview({ dshHome } = {}) {
  const file = ledgerFile(dshHome)
  try {
    const st = (await import('node:fs/promises')).stat(file)
    const s = await st
    return { exists: true, file, bytes: s.size, at: s.mtimeMs }
  } catch {
    return { exists: false, file, bytes: 0, at: null }
  }
}

/** 合并给 /ledger 用（**只用自有数据**） */
export async function collectLedger({ dshHome, fromMs = 0 } = {}) {
  const spend = await readSpend({ dshHome, fromMs })
  const today = dateKeyCN(Date.now())
  const month = today.slice(0, 7)
  const dToday = spend.days?.find((d) => d.date === today)
  const dMonth = (spend.days ?? []).filter((d) => String(d.date).startsWith(month))

  return {
    ok: true,
    source: 'cs-myfree 自有账本（不依赖任何外部插件）',
    file: spend.file,
    available: spend.total > 0,
    note: spend.total === 0
      ? '还没有调用记录。用本插件跑一次对话后这里就会有数据。'
      : null,
    spend,
    token: { ok: true, days: [] },   // 不再读外部 token 账本
    summary: {
      todayCNY: Number((dToday?.costCNY ?? 0).toFixed(6)),
      monthCNY: Number(dMonth.reduce((s, d) => s + (d.costCNY || 0), 0).toFixed(6)),
      todayCalls: dToday?.calls ?? 0,
      totalCalls: spend.total ?? 0,
      failedCalls: spend.failed ?? 0,
      paidCalls: spend.paidCount ?? 0,
      costUnknown: spend.costUnknown ?? 0,
      lastAt: spend.lastAt ?? null,
    },
    // 🔴 中断/失败统计：直接用 readSpend 已聚合的结果（不要在这里重算）
    failures: spend.failures ?? {
      failTotal: spend.failed ?? 0,
      callsTotal: spend.total ?? 0,
      failRate: 0,
      byCode: {},
      byProvider: {},
      recent: [],
    },
  }
}

// 兼容旧导出名（避免别处 import 报错）
export const readTokenLedger = async () => ({ ok: true, days: [], note: '已移除对 jet-hub 的依赖' })
export { createWriteStream }
