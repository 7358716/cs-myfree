/**
 * cs-myfree — 账本（**完全自有，不读任何外部插件**）
 *
 * 设计原则（主管明确要求「独立使用」）：
 *   · 只读写 **自己的** `~/.dsh/cs-myfree/ledger.jsonl`
 *   · **绝不**读 my-free-model / jet-hub / 任何其它插件的数据
 *   · 没装其它插件的新机器上，一切功能照常
 *
 * 记录格式（每行一条 JSON）：
 *   { at, day, provider, model, in, out, cost, paid, ok, code, ms }
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
      model: rec.model ?? null,
      in: Number(rec.in) || 0,
      out: Number(rec.out) || 0,
      cost: Number(rec.cost) || 0,
      paid: rec.paid === true,
      ok: rec.ok !== false,
      code: rec.code ?? null,
      ms: Number(rec.ms) || null,
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
  const recentFailures = []
  let total = 0, failed = 0, paidCount = 0, costTotal = 0, costUnknown = 0
  let lastAt = null

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
      else if (o.paid === true) { d.costUnknown++; costUnknown++ }
      if (o.provider) d.providers.add(o.provider)

      const p = o.provider || '(unknown)'
      if (!byProvider.has(p)) byProvider.set(p, { provider: p, calls: 0, in: 0, out: 0, failed: 0, costCNY: 0 })
      const bp = byProvider.get(p)
      bp.calls++
      bp.in += Number(o.in) || 0
      bp.out += Number(o.out) || 0
      if (o.ok === false) bp.failed++
      if (Number.isFinite(o.cost)) bp.costCNY += o.cost

      if (total >= limit) break
    }
  } catch (err) {
    // 文件不存在 = 新装机器 = 正常情况，不是错误
    if (err?.code !== 'ENOENT') {
      return { ok: false, reason: String(err?.message ?? err).slice(0, 120), file, days: [], providers: [], total: 0 }
    }
    return { ok: true, empty: true, file, days: [], providers: [], total: 0 }
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
    days: [...byDay.values()]
      .map((d) => ({ ...d, providers: [...d.providers], costCNY: Number(d.costCNY.toFixed(6)) }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 30),
    providers: [...byProvider.values()]
      .map((p) => ({ ...p, costCNY: Number(p.costCNY.toFixed(6)) }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 20),
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
