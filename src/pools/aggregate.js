/**
 * cs-myfree — 聚合路由（长期稳定的核心机制）
 *
 * 设计依据：v3 §11.2 S1 + dsh-providers-hub 的实测语义：
 *  **按「最快作废的额度优先用」自动排序**，把临期积分先烧掉。
 *
 * 关键设计（对齐上游的两条教训）：
 *  1. 真正决定「某渠道在不在轮换里」的是一张**清单**，不是适配器里的常量数组
 *     （上游：只加 AGGREGATE_CHANNELS 是**无效接线**，且症状完全静默）
 *  2. 没有临期信息的渠道**默认不参与**，可逐条手工打开
 *     （配额未知时批量放行 = 把失败留给用户）
 *
 * @module cs-myfree/pools/aggregate
 */

import { WIRED_EXPIRY } from './channels/protocols.js'

/** 有可靠到期信息的渠道（这些人默认参与轮换） */
export const EXPIRY_CAPABLE = WIRED_EXPIRY

/**
 * 把多个渠道的同一规范模型归并成一个条目。
 * @param {Array<{channel:string, model:string, canonical?:string, expiresAt?:number, usable?:boolean}>} entries
 */
export function groupByCanonical(entries = []) {
  const byCanon = new Map()
  for (const e of entries) {
    const key = e.canonical ?? normalizeModelName(e.model)
    if (!byCanon.has(key)) byCanon.set(key, { canonical: key, candidates: [] })
    byCanon.get(key).candidates.push(e)
  }
  return [...byCanon.values()]
}

/** 模型名归一（小写、去分隔符差异） */
export function normalizeModelName(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/**
 * 给候选排序：**临期最早的先烧**。
 *
 * 排序规则（刻意简单，便于解释「为什么选了这个」）：
 *  1. 可用的排前面
 *  2. 有到期时间的排在没有的前面
 *  3. 到期早的排在到期晚的前面
 *  4. 都没有到期信息时，按渠道名稳定排序
 *
 * @param {Array} candidates
 * @param {{now?:number, allowNoExpiry?:Set<string>}} opts
 */
export function rankCandidates(candidates = [], opts = {}) {
  const now = opts.now ?? Date.now()
  const allowNoExpiry = opts.allowNoExpiry ?? new Set()

  const scored = candidates.map((c) => {
    const hasExpiry = Number.isFinite(c.expiresAt)
    const wired = EXPIRY_CAPABLE.includes(c.channel)
    const usable = c.usable !== false && (c.expiresAt == null || c.expiresAt > now)
    // 没有临期信息的：只有在显式放行名单里才参与
    const participates = hasExpiry ? wired || true : allowNoExpiry.has(c.channel)
    return { ...c, hasExpiry, usable, participates }
  })

  const active = scored.filter((c) => c.usable && c.participates)
  active.sort((a, b) => {
    if (a.hasExpiry !== b.hasExpiry) return a.hasExpiry ? -1 : 1
    if (a.hasExpiry && b.hasExpiry) return a.expiresAt - b.expiresAt
    return String(a.channel).localeCompare(String(b.channel))
  })

  const inactive = scored.filter((c) => !(c.usable && c.participates))
  return {
    active,
    inactive,
    // 直观解释：首选是谁、为什么
    preferred: active[0] ?? null,
    explain: active.length === 0
      ? '没有可用候选'
      : active[0].hasExpiry
        ? `首选 ${active[0].channel}（临期最早，${Math.round((active[0].expiresAt - now) / 3600000)}h 后作废）`
        : `首选 ${active[0].channel}（无临期信息，已手工放行）`,
  }
}

/**
 * 构造聚合面板数据（对齐上游语义：目录身份与开关无关）。
 * @param {Array} entries
 * @param {{now?:number, allowNoExpiry?:Set<string>}} opts
 */
export function buildAggregatePanel(entries = [], opts = {}) {
  const groups = groupByCanonical(entries)
  return groups.map((g) => {
    const r = rankCandidates(g.candidates, opts)
    return {
      canonical: g.canonical,
      total: g.candidates.length,
      active: r.active.length,
      preferred: r.preferred?.channel ?? null,
      explain: r.explain,
      candidates: [...r.active, ...r.inactive].map((c) => ({
        channel: c.channel,
        model: c.model,
        expiresAt: c.expiresAt ?? null,
        usable: c.usable,
        participates: c.participates,
        note: c.participates ? null : (c.hasExpiry ? '未接入轮换' : '无临期信息 · 未参与'),
      })),
    }
  })
}
