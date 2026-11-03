/**
 * cs-myfree — 识图流水线（仿社区做法：**专用视觉模型转述**）
 *
 * 设计依据：v3 §7 + 社区主流做法。
 *
 * 社区两种做法对比：
 *   A. 依赖主模型自己是多模态（provider 声明 inputModalities 含 image）
 *      → 问题：主流免费文本模型都不支持；即使"支持"也可能静默丢图/幻觉
 *   B. **专用视觉模型先转述成文字，再把文字注入主模型**  ← 本模块采用
 *      → 优点：主模型不需要多模态能力；可换最快/最省的视觉模型；可缓存
 *
 * 流程：
 *   消息含 image 块
 *     → 提取图片字节
 *     → 调视觉模型（默认 OVH Qwen2.5-VL-72B，实测答对）
 *     → 得到文字描述
 *     → 把 image 块**替换成** `[图片内容] ...` 文本块
 *     → 交给主模型
 *
 * 纪律：
 *   · 默认**不出网**（mode=off 时直接给占位符）
 *   · 同一张图**只转述一次**（按 sha256 缓存）
 *   · 审计只记元数据，不记图片字节/描述原文
 *
 * @module cs-myfree/vision/pipeline
 */

import { createHash } from 'node:crypto'
import { MODE, MODE_POLICY, shouldEgress, OVH_CHAIN } from './bridge.js'

/** 默认视觉后端（本机实测：8×8 红图 → "Red" 正确） */
export const DEFAULT_VISION_MODEL = 'Qwen2.5-VL-72B-Instruct'
export const OVH_VISION_URL = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions'

/** 图片引用 → 稳定的缓存键 */
export function imageKey(block) {
  try {
    if (block?.sha256) return String(block.sha256)
    const data = block?.data || block?.base64 || ''
    if (data) return createHash('sha256').update(data).digest('hex')
    const url = block?.url || block?.image_url?.url || ''
    if (url) return createHash('sha256').update(url).digest('hex')
  } catch { /* ignore */ }
  return null
}

/** 从各种图片块形状里取出 { data 或 url, mime } */
export function extractImage(block) {
  if (!block) return null
  // 宿主 ImageBlock：{ type:'image', attachment:{...} }
  if (block.type === 'image' && block.attachment) {
    const a = block.attachment
    return { data: a.data || a.base64 || null, url: a.url || null, mime: a.mime || a.mediaType || 'image/png' }
  }
  // OpenAI 形状
  if (block.type === 'image_url') {
    const u = block.image_url?.url || ''
    if (u.startsWith('data:')) {
      const m = /^data:([^;]+);base64,(.*)$/.exec(u)
      if (m) return { data: m[2], url: null, mime: m[1] }
    }
    return { data: null, url: u, mime: 'image/png' }
  }
  // 直接 data/url
  const data = block.data || block.base64 || null
  const url = block.url || null
  if (!data && !url) return null
  return { data, url, mime: block.mime || 'image/png' }
}

/**
 * 调视觉模型转述一张图。
 * @returns {Promise<{ok:boolean, text?:string, model?:string, ms?:number, error?:string}>}
 */
export async function describeImage(img, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    model = DEFAULT_VISION_MODEL,
    timeoutMs = 45_000,
    prompt = '请用中文客观描述这张图片的内容，包括主体、文字、布局与关键细节。不要猜测。',
  } = opts

  if (!img) return { ok: false, error: '无图片数据' }

  // 🔴 免密铁律：请求头**绝不带 Authorization**（带任意 key → 403）
  const headers = { 'content-type': 'application/json' }
  const imageUrl = img.data ? `data:${img.mime};base64,${img.data}` : img.url
  if (!imageUrl) return { ok: false, error: '无图片数据或 URL' }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetchImpl(OVH_VISION_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        }],
        max_tokens: 800,
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status} ${t.slice(0, 100)}`, ms: Date.now() - t0 }
    }
    const j = await res.json()
    const msg = j?.choices?.[0]?.message || {}
    const text = String(msg.content || msg.reasoning || '').trim()
    return text
      ? { ok: true, text, model, ms: Date.now() - t0 }
      : { ok: false, error: '视觉模型返回空内容', ms: Date.now() - t0 }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err).slice(0, 150), ms: Date.now() - t0 }
  } finally {
    clearTimeout(timer)
  }
}

/** 创建描述缓存（按图 sha256，避免重复出网） */
export function createDescribeCache(limit = 200) {
  const map = new Map()
  return {
    get(k) { return map.get(k) ?? null },
    set(k, v) {
      if (map.size >= limit) map.delete(map.keys().next().value)
      map.set(k, v)
      return v
    },
    size() { return map.size },
  }
}

/**
 * 预处理消息：把 image 块替换成视觉模型的文字转述。
 *
 * @param {Array} messages 宿主格式消息
 * @param {object} opts
 * @param {string} opts.mode 识图档位（默认 off）
 * @param {boolean} opts.consented 是否已同意出网
 * @param {Function} opts.onAudit 审计回调
 * @returns {Promise<{messages:Array, stats:object}>}
 */
export async function preprocessImages(messages, opts = {}) {
  const {
    mode = MODE.OFF,
    consented = false,
    fetchImpl,
    cache = createDescribeCache(),
    onAudit = () => {},
    model = DEFAULT_VISION_MODEL,
  } = opts

  const gate = shouldEgress(mode, { consented })
  const stats = { images: 0, described: 0, cached: 0, skipped: 0, failed: 0 }

  const out = []
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!Array.isArray(m?.content)) { out.push(m); continue }
    const content = []
    for (const block of m.content) {
      const isImage = block?.type === 'image' || block?.type === 'image_url'
      if (!isImage) { content.push(block); continue }
      stats.images++

      // 未开启出网 ⇒ 保留占位符（不让用户以为图被看了）
      if (!gate.allowed) {
        stats.skipped++
        content.push({ type: 'text', text: `[图片未处理：识图档位为 ${mode}，${gate.reason}]` })
        continue
      }

      const key = imageKey(block)
      const hit = key ? cache.get(key) : null
      if (hit) {
        stats.cached++
        stats.described++
        content.push({ type: 'text', text: `[图片内容] ${hit.text}` })
        continue
      }

      const img = extractImage(block)
      const r = await describeImage(img, { fetchImpl, model })
      onAudit({
        kind: 'vision',
        ok: r.ok,
        model: r.model ?? model,
        ms: r.ms ?? null,
        error: r.error ?? null,
        // ⚠️ 只记元数据，不记图片字节、不记描述原文
      })

      if (r.ok) {
        stats.described++
        if (key) cache.set(key, r)
        content.push({ type: 'text', text: `[图片内容] ${r.text}` })
      } else {
        stats.failed++
        content.push({ type: 'text', text: `[图片解析失败：${r.error}]` })
      }
    }
    out.push({ ...m, content })
  }

  return { messages: out, stats }
}
