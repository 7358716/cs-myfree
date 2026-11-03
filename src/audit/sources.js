/**
 * cs-myfree — 真实数据源读取（账本）
 *
 * 两个真实来源（本机实测存在）：
 *   ① `~/.dsh/my-free-model/spend.jsonl`     逐条调用（8809 条，含 cost/paid/in/out）
 *   ② `~/.dsh/jet-hub/token-ledger.json`     按天×渠道×账号×模型聚合
 *
 * 纪律：
 *  · 只读，绝不改写
 *  · 大文件按行流式处理，不整读进内存
 *  · 读不到就返回空 + 原因，不抛错
 *
 * @module cs-myfree/audit/sources
 */

import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function dshHomePath(dshHome) {
  return dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** UTC+8 日界 */
export function dateKeyCN(at) {
  const t = new Date(Number(at) + 8 * 3600 * 1000)
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

/**
 * 读 spend.jsonl（流式，只保留需要的聚合）。
 * @param {{dshHome?:string, limit?:number, fromMs?:number}} opts
 */
export async function readSpend({ dshHome, limit = 200000, fromMs = 0 } = {}) {
  const file = join(dshHomePath(dshHome), 'my-free-model', 'spend.jsonl')
  const byDay = new Map()
  const byProvider = new Map()
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
      if (!byProvider.has(p)) byProvider.set(p, { provider: p, calls: 0, in: 0, out: 0, costCNY: 0 })
      const bp = byProvider.get(p)
      bp.calls++
      bp.in += Number(o.in) || 0
      bp.out += Number(o.out) || 0
      if (Number.isFinite(o.cost)) bp.costCNY += o.cost

      if (total >= limit) break
    }
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err).slice(0, 120), file, days: [], providers: [], total: 0 }
  }

  return {
    ok: true,
    file,
    total,
    failed,
    paidCount,
    costTotalCNY: Number(costTotal.toFixed(6)),
    costUnknown,
    lastAt,
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

/**
 * 读 token-ledger（渠道包的按天聚合）。
 * @param {{dshHome?:string}} opts
 */
export async function readTokenLedger({ dshHome } = {}) {
  const file = join(dshHomePath(dshHome), 'jet-hub', 'token-ledger.json')
  try {
    const o = JSON.parse(await readFile(file, 'utf8'))
    const days = o.days ?? {}
    const out = []
    for (const [date, entries] of Object.entries(days)) {
      let requests = 0, inputTokens = 0, outputTokens = 0, cacheRead = 0, errors = 0
      const channels = new Set()
      for (const [key, v] of Object.entries(entries ?? {})) {
        // key 形如 "direct|codearts|account|model"
        const parts = String(key).split('|')
        if (parts[1]) channels.add(parts[1])
        requests += Number(v?.requests) || 0
        inputTokens += Number(v?.inputTokens) || 0
        outputTokens += Number(v?.outputTokens) || 0
        cacheRead += Number(v?.cacheReadTokens) || 0
        errors += Number(v?.errors) || 0
      }
      out.push({ date, requests, inputTokens, outputTokens, cacheReadTokens: cacheRead, errors, channels: [...channels] })
    }
    return {
      ok: true,
      file,
      schema: o.schema,
      days: out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30),
    }
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err).slice(0, 120), file, days: [] }
  }
}

/** 合并两个来源，给 /ledger 用 */
export async function collectLedger({ dshHome, fromMs = 0 } = {}) {
  const [spend, token] = await Promise.all([
    readSpend({ dshHome, fromMs }),
    readTokenLedger({ dshHome }),
  ])
  const today = dateKeyCN(Date.now())
  const month = today.slice(0, 7)
  const dToday = spend.days?.find((d) => d.date === today)
  const dMonth = (spend.days ?? []).filter((d) => String(d.date).startsWith(month))
  return {
    ok: spend.ok || token.ok,
    spend,
    token,
    summary: {
      todayCNY: Number((dToday?.costCNY ?? 0).toFixed(6)),
      monthCNY: Number(dMonth.reduce((s, d) => s + (d.costCNY || 0), 0).toFixed(6)),
      todayCalls: dToday?.calls ?? 0,
      totalCalls: spend.total ?? 0,
      paidCalls: spend.paidCount ?? 0,
      costUnknown: spend.costUnknown ?? 0,
      lastAt: spend.lastAt ?? null,
    },
  }
}
