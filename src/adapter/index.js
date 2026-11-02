/**
 * cs-myfree — 降级链 adapter（组合根）
 *
 * 设计依据：v3 §3。**用 adapter 而非钩子**（最关键的架构决策）：
 *  · 钩子是 waterfall+prepend，只有一个插件能赢；且已被 myfree + 官方重试占满
 *  · adapter 是路由级注册，各自独立，不依赖配置开关
 *  · 现状证据：`cordis.patch.yml:40` 的 `request: false` 让现有降级链完全失效
 *    （spend.jsonl 中 kilo-free 派发 0 次）
 *
 * 本模块只做**编排**：候选排序 → 逐层尝试 → 提交点控制 → 失败归档。
 * 真正的 HTTP 调用由 `send` 注入（便于测试，不绑死传输实现）。
 *
 * @module cs-myfree/adapter
 */

import { classify, KIND } from './failure-map.js'
import { createLadder, createHeld, DEFAULT_BUDGET } from './ladder.js'
import { providerRetryPolicy } from './policy.js'
import { mergeChain } from './chain-overrides.js'

export { providerRetryPolicy }

/** 默认候选（无账号时的安全兜底：只有免密源） */
export const DEFAULT_CANDIDATES = Object.freeze([
  { provider: 'kilo-free', model: 'kilo-auto/free', tier: 1 },
])

/**
 * 创建 adapter 实例。
 *
 * @param {object} opts
 * @param {Array}  opts.builtin       内置链
 * @param {Array}  opts.overrides     用户覆盖
 * @param {Function} opts.send        async ({provider, model, signal, body}) => AsyncIterable<chunk>
 * @param {object} opts.budget        回合预算
 * @param {Function} opts.onEvent     审计回调
 */
export function createAdapter(opts = {}) {
  const {
    builtin = DEFAULT_CANDIDATES,
    overrides = [],
    send,
    budget = {},
    onEvent = () => {},
    now = () => Date.now(),
  } = opts

  if (typeof send !== 'function') throw new TypeError('createAdapter 需要 send 函数')

  const chain = mergeChain(builtin, overrides)

  return {
    /** 供页面展示（与选路共用同一份数据 —— 铁律2） */
    describe() {
      return { providers: ['cs-myfree'], chain: chain.map((e) => ({ ...e })) }
    },

    providerInfo(provider) {
      if (provider !== 'cs-myfree') return undefined
      return { name: 'cs-myfree', label: '免费模型（cs-myfree）', kind: 'custom' }
    },

    providerRetryPolicy,

    listModels() {
      const seen = new Set()
      const models = []
      for (const e of chain) {
        if (seen.has(e.model)) continue
        seen.add(e.model)
        models.push({ id: e.model, name: e.model, contextWindow: null, inputModalities: ['text'] })
      }
      return models
    },

    resolveModel(provider, model) {
      if (provider !== 'cs-myfree') return undefined
      const hit = chain.find((e) => e.model === model)
      if (!hit) return undefined
      return { id: model, name: model, contextWindow: null, inputModalities: ['text'] }
    },

    /**
     * 主流程：按链逐层尝试，直到某个候选**产出可见答案**。
     *
     * @param {{model:string, messages:Array, signal?:AbortSignal}} req
     * @yields 流式 chunk
     */
    async *stream(req = {}) {
      const ladder = createLadder(budget).begin(now())
      const ordered = orderCandidates(chain, req.model)
      let lastErr = null

      for (const cand of ordered) {
        if (ladder.exhausted(now())) {
          onEvent({ type: 'budget-exhausted', at: now() })
          break
        }
        ladder.countAttempt()
        const held = createHeld()

        try {
          onEvent({ type: 'attempt', provider: cand.provider, model: cand.model, layer: ladder.snapshot().layer })

          const iter = await send({
            provider: cand.provider,
            model: cand.model,
            messages: req.messages,
            signal: req.signal,
          })

          for await (const chunk of iter) {
            const r = held.push(chunk)
            if (r.committed) {
              for (const c of r.released) yield c
            } else if (r.chunk) {
              yield r.chunk
            }
          }

          if (!held.isCommitted) {
            // 整轮没有任何可见答案 ⇒ 视为 EMPTY_RESPONSE，换下一个候选
            lastErr = { kind: KIND.EMPTY_RESPONSE, message: 'no visible answer' }
            onEvent({ type: 'empty-response', provider: cand.provider })
            continue
          }

          onEvent({ type: 'success', provider: cand.provider, model: cand.model })
          return
        } catch (err) {
          lastErr = classify(err)
          onEvent({ type: 'failure', provider: cand.provider, model: cand.model, kind: lastErr.kind })

          const step = ladder.onFailure(lastErr, cand, now())
          onEvent({ type: 'ladder', layer: step.layer, action: step.action, reason: step.reason })

          if (step.action === 'report') break
          // 未提交的候选输出已自动丢弃（held 未 flush）⇒ 用户零感知
        }
      }

      const e = new Error(`cs-myfree: 全部候选失败（最后错误 ${lastErr?.kind ?? 'unknown'}）`)
      e.code = lastErr?.kind ?? 'UNKNOWN'
      throw e
    },
  }
}

/** 候选排序：同 model 优先，其次按 tier、再按原顺序 */
export function orderCandidates(chain = [], wantModel = null) {
  const list = chain.map((e, i) => ({ ...e, _i: i }))
  return list.sort((a, b) => {
    if (wantModel) {
      const am = a.model === wantModel ? 0 : 1
      const bm = b.model === wantModel ? 0 : 1
      if (am !== bm) return am - bm
    }
    return (a.tier - b.tier) || (a._i - b._i)
  })
}
