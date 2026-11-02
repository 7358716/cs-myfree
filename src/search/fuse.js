/**
 * cs-myfree — 多源搜索结果融合（纯逻辑，无网络）
 *
 * 设计依据：v3 §5。三条硬约束（宿主实测）：
 *  1. 宿主 `maxResults` 是**总数上限**，不是每源上限 ⇒ 我们必须**自己先融合排序**
 *  2. `signal` 只是取消信号，**不是超时** ⇒ 超时自建
 *  3. 缺凭据/冷却中的源**不占并发名额**
 *
 * @module cs-myfree/search/fuse
 */

/** 需要剥掉的追踪参数（不剥会让同一页算两条） */
const TRACKING = /^(utm_|spm$|msclkid$|gclid$|fbclid$|ref$|ref_src$|from$|share_|_hs|vero_|wickedid$)/i

/** 归一化 URL：去追踪参数、去末尾斜杠、统一小写 host */
export function normalizeUrl(raw) {
  if (!raw) return ''
  let u
  try { u = new URL(String(raw).trim()) } catch { return String(raw).trim() }
  u.hash = ''
  u.host = u.host.toLowerCase()
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING.test(k)) u.searchParams.delete(k)
  }
  let s = u.toString()
  if (s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/** 源权重（越大越可信） */
export const SOURCE_WEIGHT = Object.freeze({
  'bing-rss': 10, 'bing-html': 9, 'sogou': 7, 'mwmbl': 5, 'so360': 4, 'ecosia': 3,
  'wikipedia': 10, 'github': 9, 'arxiv': 9, 'crossref': 8, 'pubmed': 8, 'openalex': 8,
})

/**
 * 融合多源结果。
 *
 * 排序 5 级信号（v3 §5.5）：
 *   源权重 → 原始位置 → 时效 → 域名轮转 → seenIn tiebreak
 *
 * @param {Array<{source:string, items:Array<{url:string,title:string,snippet?:string,publishedAt?:string}>}>} batches
 * @param {{max?:number}} opts
 */
export function fuseResults(batches = [], opts = {}) {
  const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : 20
  const map = new Map()

  for (const b of batches) {
    const src = b?.source ?? 'unknown'
    const w = SOURCE_WEIGHT[src] ?? 1
    ;(b.items ?? []).forEach((it, idx) => {
      const url = normalizeUrl(it?.url)
      if (!url) return
      const prev = map.get(url)
      if (prev) {
        prev.seenIn.add(src)
        prev.weight = Math.max(prev.weight, w)
        prev.bestPos = Math.min(prev.bestPos, idx)
        if (!prev.snippet && it.snippet) prev.snippet = it.snippet
        return
      }
      map.set(url, {
        url,
        title: String(it?.title ?? '').trim(),
        snippet: String(it?.snippet ?? '').trim(),
        publishedAt: it?.publishedAt ?? null,
        weight: w,
        bestPos: idx,
        seenIn: new Set([src]),
      })
    })
  }

  const all = [...map.values()]
  // 域名轮转：避免同一站点占满首页
  const byDomain = new Map()
  for (const r of all) {
    let host = ''
    try { host = new URL(r.url).host } catch {}
    if (!byDomain.has(host)) byDomain.set(host, [])
    byDomain.get(host).push(r)
  }

  const cmp = (a, b) =>
    (b.weight - a.weight) ||
    (a.bestPos - b.bestPos) ||
    (b.seenIn.size - a.seenIn.size) ||
    String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? ''))

  for (const list of byDomain.values()) list.sort(cmp)

  // ⚠️ 轮转前必须按「各域最佳条目的权重」排序，
  //    否则 Map 的插入顺序会让低权重域名排到前面（破坏源权重优先）
  const groups = [...byDomain.values()].sort((a, b) => cmp(a[0], b[0]))

  // 轮转取值
  const out = []
  let round = 0
  while (out.length < max) {
    let added = 0
    for (const list of groups) {
      if (out.length >= max) break
      if (list[round]) { out.push(list[round]); added++ }
    }
    if (added === 0) break
    round++
  }

  return out.map((r) => ({ ...r, seenIn: [...r.seenIn] }))
}

/** 把融合结果转成宿主 sources 形状（每项只有 url 必填） */
export function toHostSources(list = []) {
  return list.map((r) => ({
    url: r.url,
    title: r.title || undefined,
    toolTitle: r.title || undefined,
    snippet: r.snippet || undefined,
  }))
}
