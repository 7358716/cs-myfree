/**
 * cs-myfree — 降级链 adapter（契约合规版）
 *
 * 设计依据：v3 §3。用 adapter 而非钩子（关键决策）。
 *
 * 🔴 v1.1.1 及之前**完全不可用**的原因（已修）：
 *    `registerAdapter('cs-myfree', adapter)` 传了字符串 —— 宿主签名是
 *    `registerAdapter(providers: string[], adapter)`，字符串会被当数组遍历；
 *    且 `providerInfo` 缺 `id`、`listModels` 缺 `provider`、`resolveModel` 缺
 *    `provider`、`context` 用了顶层字段 —— 每一处都会抛错，被静默吞掉。
 *
 * 现在全部按 `dsh-llm/lib/index.js` 的实测契约实现。
 *
 * @module cs-myfree/adapter
 */

import { classify, KIND } from './failure-map.js'
import { createLadder, createHeld, DEFAULT_BUDGET } from './ladder.js'
import { providerRetryPolicy } from './policy.js'
import { mergeChain } from './chain-overrides.js'
import { makeProviderInfo, makeModelInfo, checkProviderInfo, checkModelInfo } from './contract.js'
import { toHostChunks } from './chunks.js'

export { providerRetryPolicy }

export const PROVIDER_ID = 'cs-myfree'

/** 无账号时的安全兜底：只有免密源 */
export const DEFAULT_CANDIDATES = Object.freeze([
  { provider: 'kilo-free', model: 'kilo-auto/free', tier: 1, inputModalities: ['text'] },
])

/**
 * 创建 adapter。
 *
 * @param {object} opts
 * @param {Array}  opts.builtin     内置链
 * @param {Array}  opts.overrides   用户覆盖
 * @param {Function} opts.send      async ({provider, model, messages, signal, options}) => AsyncIterable<chunk>
 * @param {object} opts.budget      回合预算
 * @param {Function} opts.onEvent   审计回调
 */
export function createAdapter(opts = {}) {
  const {
    builtin = DEFAULT_CANDIDATES,
    overrides = [],
    send,
    budget = {},
    onEvent = () => {},
    now = () => Date.now(),
    providerId = PROVIDER_ID,
    displayName = 'Myfree（免费模型）',
  } = opts

  if (typeof send !== 'function') throw new TypeError('createAdapter 需要 send 函数')

  let chain = mergeChain(builtin, overrides)

  /** 链里的模型（去重），供 listModels 用 */
  function catalog() {
    const seen = new Map()
    for (const e of chain) {
      if (seen.has(e.model)) continue
      seen.set(e.model, e)
    }
    return [...seen.values()]
  }

  return {
    /** 更新链（配置变更后调用） */
    setChain(nextBuiltin, nextOverrides) {
      chain = mergeChain(nextBuiltin ?? builtin, nextOverrides ?? overrides)
      return chain.length
    },

    /** 供页面展示（与选路共用同一份数据） */
    describe() {
      return { providers: [providerId], chain: chain.map((e) => ({ ...e })) }
    },

    // ── 契约②：必须含 id 且等于 provider ──
    providerInfo(provider) {
      if (provider !== providerId) return undefined
      return makeProviderInfo(provider, { name: displayName })
    },

    // ── 契约⑤：返回扁平策略 ──
    providerRetryPolicy(provider) {
      if (provider !== providerId) return undefined
      return providerRetryPolicy()
    },

    // ── 契约③：每项必须有 provider ──
    listModels(provider) {
      if (provider !== providerId) return []
      return catalog().map((e) => makeModelInfo(provider, {
        id: e.model,
        name: e.name || e.model,
        contextWindow: e.contextWindow,
        inputModalities: e.inputModalities,
        supportsVision: e.supportsVision,
      }))
    },

    // ── 契约④：provider + id 都必须对 ──
    resolveModel(provider, model) {
      if (provider !== providerId) return undefined
      const hit = catalog().find((e) => e.model === model)
      if (!hit) return undefined
      return makeModelInfo(provider, {
        id: model,
        name: hit.name || model,
        contextWindow: hit.contextWindow,
        inputModalities: hit.inputModalities,
        supportsVision: hit.supportsVision,
      })
    },

    // ── 契约⑥：prepareCall 返回 { model, stream } ──
    async prepareCall(provider, model) {
      return {
        model: this.resolveModel(provider, model),
        stream: (options) => this.stream(options),
      }
    },

    /**
     * 主流程：按链逐层尝试，直到某个候选**产出可见答案**。
     * @param {{provider:string, model:string, messages:Array, signal?:AbortSignal}} options
     */
    async *stream(options = {}) {
      const ladder = createLadder(budget).begin(now())
      const ordered = orderCandidates(chain, options.model)
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
            messages: options.messages,
            signal: options.signal,
            options,
          })

          // 提交点：先在**简化增量**层缓冲，提交后才转成宿主的块事件流
          const buffered = []
          for await (const chunk of iter) {
            const r = held.push(chunk)
            if (r.committed) {
              for (const c of r.released) buffered.push(c)
            } else if (r.chunk) {
              buffered.push(r.chunk)
            }
          }

          if (!held.isCommitted) {
            lastErr = { kind: KIND.EMPTY_RESPONSE, message: 'no visible answer' }
            onEvent({ type: 'empty-response', provider: cand.provider })
            continue
          }

          // 把缓冲的简化增量翻译成符合宿主契约的 block 事件流
          async function* replay() { for (const c of buffered) yield c }
          yield* toHostChunks(replay())
          onEvent({ type: 'success', provider: cand.provider, model: cand.model })
          return

          if (!held.isCommitted) {
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
        }
      }

      const e = new Error(`cs-myfree: 全部候选失败（最后错误 ${lastErr?.kind ?? 'unknown'}）`)
      e.code = lastErr?.kind ?? 'UNKNOWN'
      throw e
    },

    /** 自检：所有契约点是否合规 */
    selfCheck() {
      const problems = []
      const pi = this.providerInfo(providerId)
      const a = checkProviderInfo(pi, providerId)
      if (!a.ok) problems.push('providerInfo: ' + a.errors.join('; '))

      const models = this.listModels(providerId)
      if (models.length === 0) problems.push('listModels 为空（链里没有模型）')
      for (const m of models) {
        const b = checkModelInfo(m, providerId)
        if (!b.ok) problems.push(`listModels[${m?.id}]: ${b.errors.join('; ')}`)
      }
      for (const m of models) {
        const r = this.resolveModel(providerId, m.id)
        const c = checkModelInfo(r, providerId, m.id)
        if (!c.ok) problems.push(`resolveModel[${m.id}]: ${c.errors.join('; ')}`)
      }
      const rp = this.providerRetryPolicy(providerId)
      if (!rp) problems.push('providerRetryPolicy 为空')
      else if (rp.retryableCodes?.includes('RATE_LIMIT')) problems.push('retryableCodes 不得含 RATE_LIMIT')
      if (typeof rp?.backoff === 'object') problems.push('策略不得嵌套 backoff')

      return { ok: problems.length === 0, problems, modelCount: models.length }
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
