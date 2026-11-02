/**
 * cs-myfree — 搜索源解析器（纯解析逻辑，网络由调用方注入）
 *
 * 设计依据：v3 §5.3/5.4。所有端点与实测行为均来自本机探测：
 *  · bing-rss   count=10 / 108-270ms  → 最稳
 *  · bing-html  count=10 / 155-224ms  → <li class="b_algo">
 *  · sogou      count=5-7  / 682ms    → 选择器含业务号（脆弱）
 *  · mwmbl      count=17              → title/extract 是**富文本数组**
 *  · baidu 被封锁 / ddg DNS 投毒 / dblp Anubis 挑战 ⇒ 全部剔除
 *
 * @module cs-myfree/search/sources
 */

/** 已剔除的源及原因（写进文档，防后人再加回来） */
export const EXCLUDED = Object.freeze({
  baidu: '本机实测被封锁（返回 0 结果）',
  ddg: 'DNS 投毒（解析到 Meta IPv6 段 face:b00c）+ TCP 黑洞',
  'ddg-lite': '同上',
  dblp: 'Anubis JS 挑战，非浏览器拿不到结果',
})

/** 源定义：id → { url(q), parse(text) } */
export const PARSERS = Object.freeze({
  'bing-rss': {
    weight: 10,
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss&count=20`,
    parse: parseBingRss,
  },
  'bing-html': {
    weight: 9,
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=20`,
    parse: parseBingHtml,
  },
  sogou: {
    weight: 7,
    url: (q) => `https://www.sogou.com/web?query=${encodeURIComponent(q)}`,
    parse: parseSogou,
  },
  mwmbl: {
    weight: 5,
    url: (q) => `https://api.mwmbl.org/api/v1/search/?s=${encodeURIComponent(q)}`,
    parse: parseMwmbl,
  },
})

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function stripTags(s) {
  return decodeEntities(String(s ?? '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

/** Bing RSS：<item><title/><link/><description/> */
export function parseBingRss(xml) {
  const items = []
  const re = /<item>([\s\S]*?)<\/item>/gi
  let m
  while ((m = re.exec(String(xml ?? ''))) !== null) {
    const body = m[1]
    const title = stripTags(/<title>([\s\S]*?)<\/title>/i.exec(body)?.[1])
    const link = decodeEntities(/<link>([\s\S]*?)<\/link>/i.exec(body)?.[1] ?? '').trim()
    const desc = stripTags(/<description>([\s\S]*?)<\/description>/i.exec(body)?.[1])
    const pub = /<pubDate>([\s\S]*?)<\/pubDate>/i.exec(body)?.[1]?.trim()
    if (link) items.push({ url: link, title, snippet: desc, publishedAt: pub ?? null })
  }
  return items
}

/** Bing HTML：<li class="b_algo"> … <h2><a href=""> */
export function parseBingHtml(html) {
  const items = []
  const re = /<li class="b_algo"[\s\S]*?<\/li>/gi
  let m
  while ((m = re.exec(String(html ?? ''))) !== null) {
    const block = m[0]
    const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!a) continue
    const url = decodeEntities(a[1])
    const title = stripTags(a[2])
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    items.push({ url, title, snippet: stripTags(p?.[1]) })
  }
  return items
}

/** 搜狗：结果块。用「按标记切分」而非前瞻正则（前瞻在单结果页永不成立） */
export function parseSogou(html) {
  const src = String(html ?? '')
  const parts = src.split(/<div class="(?:vrwrap|rb)"/i).slice(1)
  const items = []
  for (const block of parts) {
    const a = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!a) continue
    let url = decodeEntities(a[1])
    if (url.startsWith('/link?url=')) url = `https://www.sogou.com${url}`
    const title = stripTags(a[2])
    if (!title || !url) continue
    items.push({ url, title, snippet: '' })
  }
  return items
}

/**
 * MWMBL：JSON 数组。
 * ⚠️ title / extract 是**富文本数组** [{value,is_bold}]，直接当字符串会得到 [object Object]
 */
export function parseMwmbl(jsonText) {
  let data
  try { data = JSON.parse(String(jsonText ?? '[]')) } catch { return [] }
  const list = Array.isArray(data) ? data : (data?.results ?? [])
  const rich = (v) => Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x?.value ?? '')).join('') : String(v ?? '')
  return list.map((it) => ({
    url: String(it?.url ?? '').trim(),
    title: rich(it?.title).trim(),
    snippet: rich(it?.extract).trim(),
  })).filter((x) => x.url)
}
