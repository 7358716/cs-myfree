/**
 * cs-myfree — OVHcloud 免费端点（免密，含视觉）
 *
 * 实测（2026-11-02）：
 *  · `/v1/chat/completions` + `Qwen3.5-9B` → **200 / 1.73s**
 *  · 8×8 纯红 PNG → `Qwen2.5-VL-72B-Instruct` 答 **"Red"（正确）**
 *  · **不带 Authorization → 200；带任意 key → 403**
 *
 * ⇒ 本链**必须自持 HTTP**（pi-ai 在 apiKey !== undefined 时强制塞 Bearer）
 *
 * @module cs-myfree/pools/keyless/ovh
 */

import { chatRequest, parseOpenAiSse, fromCompletionJson } from './base.js'

export const OVH_BASE = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1'
export const KEYLESS = true

/** 默认模型链（质量降序，实测均可用） */
/**
 * 可用模型（实测速度，2026-11-03）
 * ⚠️ 已移除 Qwen3.6-27B：实测 55 秒超时，不可用
 */
export const OVH_MODELS = Object.freeze([
  { id: 'Qwen3.5-397B-A17B', vision: true, ms: 1900, note: '实测最快（1.9s）' },
  { id: 'Qwen2.5-VL-72B-Instruct', vision: true, ms: 2900, note: '视觉实测答对（2.9s）' },
  { id: 'Qwen3.5-9B', vision: true, ms: 4200, note: '冷启动曾达 43s，慎用' },
])

export async function listModels({ fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${OVH_BASE}/models`, {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; cs-myfree)' },
      signal: ctrl.signal,
    })
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
    const body = await res.json()
    return (body?.data ?? body ?? []).map((m) => ({ id: m.id, name: m.id, free: true, inputModalities: ['text', 'image'] }))
  } finally { clearTimeout(timer) }
}

export async function chat({ model, messages, signal, stream = false, fetchImpl, timeoutMs = 120_000 } = {}) {
  return chatRequest({
    baseUrl: `${OVH_BASE}/chat/completions`,
    model: model ?? 'Qwen3.5-397B-A17B',
    messages,
    signal, stream, fetchImpl, timeoutMs,
    extra: { max_tokens: 8192 },
  })
}

export async function* stream(opts = {}) {
  const r = await chat({ stream: false, ...opts })
  if (r.stream) yield* parseOpenAiSse(r.body)
  else yield* fromCompletionJson(r.json)
}

/** 视觉：把图片转成 OpenAI 多模态格式 */
export function visionMessage(imageB64, mime = 'image/png', text = '描述这张图片') {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${imageB64}` } },
    ],
  }
}
