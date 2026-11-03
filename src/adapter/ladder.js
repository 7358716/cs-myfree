/**
 * cs-myfree — 6 层降级链状态机（纯逻辑，无 I/O）
 *
 * 设计依据：v3 §3.3。核心是**提交点（commit point）**：
 *   候选 chunk 先缓冲，遇到第一个「有答案的增量」才向调用方放行。
 *   `reasoning-delta` 刻意不算提交 —— 「想了一分钟然后撞配额墙」
 *   是最值得切换的场景，且用户零感知。
 *
 * 六层（L0 是同渠道重试，不占 tier）：
 *   L0 同渠道重试（≤2 次 / 15s）  瞬态码
 *   L1 同渠道换号（号池）          429/401/402/QUOTA
 *   L2 换渠道（≤3 渠道 / 30s）     403 指纹/区域/渠道级 5xx
 *   L3 换模型（≤2 模型 / 60s）     404/MODEL_NOT_FOUND
 *   L4 降档（1 次）                付费档必须人工确认，绝不自动
 *   L5 失败上报（含完整证据）
 *
 * 共享回合预算：maxAttempts=18 · maxElapsed=120s
 *
 * @module cs-myfree/adapter/ladder
 */

import { KIND } from './failure-map.js'

export const DEFAULT_BUDGET = Object.freeze({
  maxAttempts: 18,
  maxElapsedMs: 120_000,
  retryPerRoute: 2,
  swapChannelMax: 3,
  swapModelMax: 2,
})

/** 该失败码应升到哪一层 */
export function nextLayerFor(kind) {
  switch (kind) {
    case KIND.TRANSPORT:
    case KIND.TIMEOUT:
    case KIND.SERVER:
    case KIND.EMPTY_RESPONSE:
      return 0            // 原地重试
    case KIND.QUOTA:
    case KIND.RATE_LIMIT:
    case KIND.AUTH:
      return 1            // 换号（同渠道换账号）
    case KIND.PERMISSION:
    case KIND.REGION_BLOCKED:
      return 2            // 换渠道
    case KIND.MODEL_NOT_FOUND:
    case KIND.NOT_FOUND:
      return 3            // 换模型
    case KIND.INVALID_REQUEST:
      return 3            // 同模型换个说法可能也过不了 ⇒ 换模型
    default:
      return 5            // 无法归类 ⇒ 直接上报
  }
}

/**
 * 提交点判定：这个 chunk 是否构成「已给出答案」。
 *
 * ⚠️ 刻意排除 reasoning：
 *  · 纯 reasoning 增量用户从未看见 ⇒ 丢它不会伤到用户
 *  · 一旦把 reasoning 算作提交，最值得 failover 的场景（想很久才撞墙）就失效了
 */
export function commitsAnswer(chunk) {
  if (!chunk || typeof chunk !== 'object') return false
  switch (chunk.type) {
    case 'text-delta': return String(chunk.text ?? '').length > 0
    case 'tool-call':
    case 'tool-call-delta': return true
    case 'block-end': {
      // 只有**有内容的**块才算提交；空的 reasoning 块不算
      const b = chunk.block
      if (!b) return false
      if (b.type === 'text') return String(b.text ?? '').length > 0
      if (b.type === 'tool-call') return true
      return false     // reasoning 块结束不算
    }
    case 'finish': return chunk.reason?.kind === 'stop' || chunk.reason?.kind === 'tool-calls'
    // reasoning-delta / block-start / usage 一律不算提交
    default: return false
  }
}

/** 缓存区：攒 chunk，直到提交点才放行 */
export function createHeld() {
  let buf = []
  let committed = false
  return {
    push(chunk) {
      if (committed) return { committed: true, chunk, released: [] }
      buf.push(chunk)
      if (!commitsAnswer(chunk)) return { committed: false, chunk: null, released: [] }
      committed = true
      const released = buf
      buf = []
      return { committed: true, chunk: null, released }
    },
    get isCommitted() { return committed },
    /** 尝试失败时整段丢弃 */
    discard() { buf = []; return { discarded: true, count: 0 } },
    get size() { return buf.length },
  }
}

/**
 * 回合状态机。
 *
 * 用法：
 *   const L = createLadder(budget)
 *   L.begin()
 *   for each attempt:
 *     L.countAttempt()
 *     const v = classify(err); const { layer, action } = L.onFailure(v)
 *     if (action === 'report') break
 */
export function createLadder(budget = {}) {
  const cfg = { ...DEFAULT_BUDGET, ...budget }
  const state = {
    startedAt: 0,
    begun: false,
    attempts: 0,
    layer: 0,
    routesTried: new Map(),   // key -> 次数
    channelsTried: new Set(),
    modelsTried: new Set(),
    history: [],
  }

  const now = () => Date.now()

  return {
    begin(at) { state.startedAt = at ?? now(); state.begun = true; state.attempts = 0; state.layer = 0; state.history = []; return this },

    /** 预算是否已耗尽 */
    exhausted(at) {
      const t = at ?? now()
      return state.attempts >= cfg.maxAttempts || (state.begun && t - state.startedAt >= cfg.maxElapsedMs)
    },

    countAttempt() { state.attempts += 1; return state.attempts },

    /**
     * 处理一次失败，决定下一动作。
     * @returns {{layer:number, action:'retry'|'swap-account'|'swap-channel'|'swap-model'|'downgrade'|'report', reason:string}}
     */
    onFailure(verdict, ctx = {}, at) {
      const t = at ?? now()
      const routeKey = `${ctx.provider ?? '?'}/${ctx.model ?? '?'}`
      const tried = (state.routesTried.get(routeKey) ?? 0) + 1
      state.routesTried.set(routeKey, tried)
      state.history.push({ at: t, kind: verdict?.kind, layer: nextLayerFor(verdict?.kind), route: routeKey })

      if (this.exhausted(t)) return { layer: 5, action: 'report', reason: '预算耗尽（尝试次数或时长）' }

      const want = nextLayerFor(verdict?.kind)
      if (want === 5) return { layer: 5, action: 'report', reason: `无法归类的失败（${verdict?.kind}）` }

      // L0：原地重试有上限
      if (want === 0) {
        if (tried > cfg.retryPerRoute) return { layer: 2, action: 'swap-channel', reason: `同路由已试 ${tried} 次` }
        return { layer: 0, action: 'retry', reason: `瞬态失败（${verdict?.kind}），原地重试 ${tried}/${cfg.retryPerRoute}` }
      }
      // L1：换号
      if (want === 1) return { layer: 1, action: 'swap-account', reason: `账号级失败（${verdict?.kind}）` }
      // L2：换渠道
      if (want === 2) {
        if (state.channelsTried.size >= cfg.swapChannelMax) {
          return { layer: 3, action: 'swap-model', reason: `已试 ${state.channelsTried.size} 个渠道` }
        }
        state.channelsTried.add(ctx.provider ?? '?')
        return { layer: 2, action: 'swap-channel', reason: `渠道级失败（${verdict?.kind}）` }
      }
      // L3：换模型
      if (want === 3) {
        if (state.modelsTried.size >= cfg.swapModelMax) {
          return { layer: 4, action: 'downgrade', reason: `已试 ${state.modelsTried.size} 个模型` }
        }
        state.modelsTried.add(ctx.model ?? '?')
        return { layer: 3, action: 'swap-model', reason: `模型级失败（${verdict?.kind}）` }
      }
      return { layer: 5, action: 'report', reason: 'unknown' }
    },

    /** L4 降档是否允许（付费档必须人工确认） */
    canDowngrade(ctx = {}) {
      return ctx.paid !== true
    },

    snapshot() { return { ...state, routesTried: Object.fromEntries(state.routesTried), channelsTried: [...state.channelsTried], modelsTried: [...state.modelsTried] } },
  }
}
