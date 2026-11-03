/**
 * cs-myfree — Kilo 免费池（免密）
 *
 * 实测（2026-11-02）：`api.kilo.ai/api/gateway` → **200 / 1.37s**，
 * 382 个模型中 **11 个免费**（`:free` 后缀）。
 *
 * ⚠️ 旧插件的两个真 bug（本模块避开）：
 *   1. `kilo.js:59` 塞占位凭据 → `Bearer public` → **401**
 *      ⇒ 本模块只用 keylessHeaders()，绝不设 Authorization
 *   2. `kilo.js:52` 把 `input:['text']` **写死** ⇒ 即使模型支持视觉也被投影成占位符
 *      ⇒ 本模块按 `input_modalities` 字段如实透传
 *
 * @module cs-myfree/pools/keyless/kilo
 */

import { chatRequest, parseOpenAiSse, fromCompletionJson } from './base.js'

export const KILO_BASE = 'https://api.kilo.ai/api/gateway'

/** 免密可用（实测） */
export const KEYLESS = true

/** 拉模型清单（免密 GET） */
export async function listModels({ fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${KILO_BASE}/models`, {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; cs-myfree)' },
      signal: ctrl.signal,
    })
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
    const body = await res.json()
    const arr = body?.data ?? body ?? []
    return arr.map(normalizeModel).filter(Boolean)
  } finally { clearTimeout(timer) }
}

/**
 * 归一化模型。
 * ⚠️ 用 `input_modalities` 字段判断视觉能力（不是正则搜整个 JSON ——
 *    上一轮就是这么数错的：把 16 个免费模型的视觉能力数成 8 个，实际 5 个）。
 */
export function normalizeModel(m) {
  if (!m?.id) return null
  const mods = Array.isArray(m.input_modalities) ? m.input_modalities
    : Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities
    : ['text']
  return {
    id: m.id,
    name: m.name ?? m.id,
    free: /:free$/.test(m.id) || m.pricing?.prompt === '0',
    contextWindow: m.context_length ?? m.context_window ?? null,
    inputModalities: mods,
    supportsVision: mods.includes('image'),
    mayTrain: m.may_train_on_your_prompts === true || m.mayTrainOnYourPrompts === true,
  }
}

/** 只有免费模型才是「绝不花钱」的候选 */
export function freeModels(models = []) {
  return models.filter((m) => m.free)
}

/** 发起对话 */
export async function chat({ model, messages, signal, stream = true, fetchImpl, timeoutMs = 120_000 } = {}) {
  return chatRequest({
    baseUrl: `${KILO_BASE}/chat/completions`,
    model: model ?? 'kilo-auto/free',
    messages,
    signal, stream, fetchImpl, timeoutMs,
    // 🔑 必须显式设 max_tokens：不设时厂商默认值很小，会导致回答被截断
    extra: { max_tokens: 8192 },
  })
}

/** 统一入口：返回 chunk 迭代器 */
export async function* stream(opts = {}) {
  const r = await chat(opts)
  if (r.stream) {
    yield* parseOpenAiSse(r.body)
  } else {
    yield* fromCompletionJson(r.json)
  }
}
