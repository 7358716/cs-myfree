/**
 * cs-myfree — 免密池总入口（**这是「免费模型一定可用」的保证**）
 *
 * 三个独立免密源（实测 2026-11-02 全部可用）：
 *   kilo        200 / 1.37s / 11 免费模型
 *   ovh         200 / 1.73s / 4 模型（含视觉）
 *   pollinations 200 / 2.14s / 纯文本
 *
 * 设计要点：
 *  · **任一源可用即整体可用**（三源互不依赖）
 *  · 不依赖任何账号/登录/签到 ⇒ 新机器装完就能用
 *  · 全部不发 Authorization（见 base.js 的铁律）
 *
 * @module cs-myfree/pools/keyless
 */

import * as kilo from './kilo.js'
import * as ovh from './ovh.js'
import * as pollinations from './pollinations.js'

export const ADAPTERS = Object.freeze({ kilo, ovh, pollinations })

/** 各源的默认模型 */
export const DEFAULT_MODEL = Object.freeze({
  kilo: 'kilo-auto/free',
  ovh: 'Qwen3.5-397B-A17B',   // 实测最快（1.9s）；Qwen3.5-9B 冷启动曾 43s
  pollinations: 'openai',
})

/**
 * 默认参与轮换的源（**按 2026-11-03 实测可用性排序**）
 *
 * ⚠️ pollinations 已移出：
 *    `Free limit reached: 1 reply every 45 seconds per IP`
 *    ⇒ 每 45 秒仅 1 次，连续对话必然 402。代码保留，用户可手动加回。
 *
 * OVH 保留但排在 kilo 之后：它冷启动可达 43s，容易触发宿主超时截断。
 */
export const PRIORITY = Object.freeze(['kilo', 'ovh'])
// ⚠️ ovh 实测：简单问答 1.9s，但**长回答 60s 超时**（2026-11-03）
//    故它只是「kilo 挂了才用」的最后备用

/** 可选但**默认禁用**的源（代码保留，用户可在配置里显式启用） */
export const OPTIONAL = Object.freeze(['pollinations'])

/**
 * provider 别名 → 真实源 id。
 *
 * 🔴 为什么需要：用户可能在「降级链」页面手填 `kilo-free`（旧插件时代的名字），
 *    或历史配置里有别名。若不做映射，发送时会报「未知供应源」。
 */
export const PROVIDER_ALIASES = Object.freeze({
  'kilo-free': 'kilo',
  'kilo-free-pool': 'kilo',
  'ovh-vision': 'ovh',
  'ovh-cloud': 'ovh',
  'pollinations-free': 'pollinations',
  'polli': 'pollinations',
})

/** 把各种写法归一成真实源 id（认不出就原样返回） */
export function resolveSourceId(provider) {
  const p = String(provider ?? '').trim().toLowerCase()
  if (ADAPTERS[p]) return p
  return PROVIDER_ALIASES[p] ?? p
}

/**
 * 探测单个源是否可用（真实请求，不是 TCP 探测）。
 * ⚠️ 用真实推理而不是 TCP：本机实测过「TCP 通但推理 401」的情况。
 */
export async function probeOne(id, { fetchImpl = globalThis.fetch, timeoutMs = 25_000 } = {}) {
  const a = ADAPTERS[id]
  if (!a) return { id, ok: false, error: 'unknown-source' }
  const t0 = Date.now()
  try {
    let got = ''
    for await (const c of a.stream({
      model: DEFAULT_MODEL[id],
      messages: [{ role: 'user', content: 'ping' }],
      fetchImpl, timeoutMs,
    })) {
      if (c.type === 'text-delta') got += c.text
      if (c.type === 'reasoning-delta') got += c.text
      if (got.length > 20) break
    }
    return { id, ok: got.length > 0, ms: Date.now() - t0, sample: got.slice(0, 40) }
  } catch (err) {
    return { id, ok: false, ms: Date.now() - t0, error: String(err?.message ?? err).slice(0, 120) }
  }
}

/** 探测全部免密源（并发） */
export async function probeAll(opts = {}) {
  const results = await Promise.all(PRIORITY.map((id) => probeOne(id, opts)))
  return {
    at: Date.now(),
    results,
    anyOk: results.some((r) => r.ok),
    okCount: results.filter((r) => r.ok).length,
  }
}

/** 取第一个可用源的流（自动 fallback） */
export async function* streamWithFallback({ provider, model, messages, signal, fetchImpl, timeoutMs } = {}) {
  let lastErr = null
  // 给了 provider 就只走它（归一别名），否则按优先级全部试
  const order = provider ? [resolveSourceId(provider)] : PRIORITY
  for (const id of order) {
    const a = ADAPTERS[id]
    if (!a) { lastErr = new Error('未知供应源：' + provider); continue }
    try {
      const useModel = model && model.startsWith(id) ? model.split(':')[1] : DEFAULT_MODEL[id]
      yield* a.stream({ model: useModel, messages, signal, fetchImpl, timeoutMs })
      return
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new Error('全部免密源不可用')
}
