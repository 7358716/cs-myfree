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
import { computeCost } from '../audit/pricing.js'
import { createConcurrencyGate } from './concurrency.js'

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
    onRecord = () => {},
    extraModels = () => [],        // 已登录渠道的模型（动态）
    directModel = null,            // (modelId) => 候选 | null：用户请求的模型不在链里时的直连解析
    now = () => Date.now(),
    providerId = PROVIDER_ID,
    displayName = 'Myfree（免费模型）',
    concurrency = null,            // 并发闸门（默认按渠道内置上限）
  } = opts

  if (typeof send !== 'function') throw new TypeError('createAdapter 需要 send 函数')

  // 🔴 并发闸门：渠道有会话数上限（codearts=3），超了上游直接拒绝
  const gate = concurrency ?? createConcurrencyGate()

  let currentBuiltin = Array.isArray(builtin) ? builtin : []
  let currentOverrides = Array.isArray(overrides) ? overrides : []
  let chain = mergeChain(currentBuiltin, currentOverrides)

  /**
   * 全部可选模型 = 链里的模型 + 已登录渠道的模型（去重）。
   * 宿主 listModels 要求 id 唯一，所以渠道模型带 `<channel>/<model>` 前缀。
   */
  function catalog() {
    const seen = new Map()
    for (const e of chain) {
      if (seen.has(e.model)) continue
      seen.set(e.model, e)
    }
    // 追加已登录渠道的模型（id 已带渠道前缀，天然不撞名）
    try {
      for (const m of extraModels() || []) {
        if (!m?.id || seen.has(m.id)) continue
        seen.set(m.id, {
          provider: m.channelId,
          model: m.id,
          name: m.name,
          tier: 9,                        // 渠道模型排在免密源之后，但可手动钉选
          inputModalities: m.inputModalities,
          channelModel: true,
        })
      }
    } catch { /* extraModels 出错不影响免密源 */ }
    return [...seen.values()]
  }

  /** 请求的模型对应的候选（链 → 渠道目录 → 直连解析）；找不到返回 null */
  function resolveRequested(wantModel) {
    if (typeof wantModel !== 'string' || wantModel === '') return null
    const inChain = chain.find((e) => e.model === wantModel)
    if (inChain) return inChain
    const inCatalog = catalog().find((e) => e.model === wantModel)
    if (inCatalog) return inCatalog
    if (typeof directModel === 'function') {
      try {
        const d = directModel(wantModel)
        if (d && typeof d.model === 'string' && d.model !== '') {
          return { tier: 0, channelModel: true, ...d, model: wantModel }
        }
      } catch { /* 直连解析失败 ⇒ 按原链降级 */ }
    }
    return null
  }

  /**
   * 候选顺序：**请求的模型优先直连**，失败后才按 tier 降级。
   *
   * 🔴 修的是「用户选了渠道模型，实际却调 kilo」：
   *    渠道模型不在 `chain` 里（它是 extraModels 动态追加的），
   *    旧实现只按 `chain` 排序 ⇒ 请求的 model 永远匹配不到 ⇒ 直接落到 tier 最小的免密源。
   */
  function candidatesFor(wantModel) {
    const rest = orderCandidates(chain, null)
    const hit = resolveRequested(wantModel)
    if (!hit) return rest
    const key = `${hit.provider}\u0000${hit.model}`
    return [hit, ...rest.filter((e) => `${e.provider}\u0000${e.model}` !== key)]
  }

  return {
    /** 更新链（配置变更后调用） */
    setChain(nextBuiltin, nextOverrides) {
      if (Array.isArray(nextBuiltin)) currentBuiltin = nextBuiltin
      if (Array.isArray(nextOverrides)) currentOverrides = nextOverrides
      chain = mergeChain(currentBuiltin, currentOverrides)
      return chain.length
    },

    /** 读取当前生效链的三件套（页面与选路共用同一份数据 —— 铁律2） */
    getChain() {
      return {
        builtin: currentBuiltin.map((e) => ({ ...e })),
        overrides: currentOverrides.map((e) => ({ ...e })),
        effective: chain.map((e) => ({ ...e })),
      }
    },

    /** 更新可用模型总数（含渠道模型），供 UI/诊断展示 */
    modelCount() {
      return catalog().length
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
      const hit = resolveRequested(model)
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
      const ordered = candidatesFor(options.model)
      let lastErr = null

      for (const cand of ordered) {
        if (ladder.exhausted(now())) {
          onEvent({ type: 'budget-exhausted', at: now() })
          break
        }
        ladder.countAttempt()
        const held = createHeld()

        let releaseSlot = () => {}
        try {
          onEvent({ type: 'attempt', provider: cand.provider, model: cand.model, layer: ladder.snapshot().layer })

          // 🔴 先拿并发名额（可能排队）——「中断停摆」的核心修复：
          //    上游会话数满了会直接拒绝，排队比硬发可靠得多
          const slot = await gate.acquire(cand.provider)
          releaseSlot = () => { try { slot.release() } catch { /* ignore */ } }

          // 渠道模型（id 形如 codearts/xxx）交给 send 自己判断分发
          const iter = await send({
            provider: cand.provider,
            model: cand.model,
            messages: options.messages,
            signal: options.signal,
            options,
            isChannelModel: cand.channelModel === true,
          })

          // 提交点：先在**简化增量**层缓冲，提交后才转成宿主的块事件流
          //
          // 🔴 血泪教训（「说到一半停/总截断」的真因）：
          //    createHeld().push 在**已提交后**返回 { committed:true, chunk, released:[] }。
          //    上一版只搬 `released`（空数组）⇒ 提交点之后的每个增量都被丢弃，
          //    用户只看到第一个 text-delta。必须两者都收。
          const buffered = []
          for await (const chunk of iter) {
            const r = held.push(chunk)
            if (r.released?.length) buffered.push(...r.released)
            if (r.chunk) buffered.push(r.chunk)
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

          // 记一笔（自有账本，失败不影响主流程）
          try {
            let inTok = 0, outTok = 0, cacheRead = 0
            for (const c of buffered) {
              // 独立 usage 增量（OpenAI 流末帧）与 finish.usage 两种形态都要认
              const u = c.type === 'usage' ? c.usage
                : (c.type === 'finish' && c.usage ? c.usage : null)
              if (!u) continue
              inTok = Number(u.inputTokens) || inTok
              outTok = Number(u.outputTokens) || outTok
              cacheRead = Number(u.cacheReadTokens) || cacheRead
            }
            // 🔴 真实计价（此前硬编码 cost:0 / paid:false ⇒ 付费调用永不计费）
            //    cost=null 表示「价格未知」，必须如实记，不能当 0
            const priced = computeCost({
              provider: cand.provider, model: cand.model,
              inTokens: inTok, outTokens: outTok, cacheReadTokens: cacheRead, at: now(),
            })
            onRecord({
              at: now(), provider: cand.provider, model: cand.model,
              in: inTok, out: outTok, cacheRead,
              cost: priced.costCNY, paid: priced.paid, ok: true,
              ms: now() - (ladder.snapshot().startedAt || now()),
            })
          } catch { /* ignore */ }
          return
        } catch (err) {
          lastErr = classify(err)
          onEvent({ type: 'failure', provider: cand.provider, model: cand.model, kind: lastErr.kind })
          try {
            const failedPriced = computeCost({ provider: cand.provider, model: cand.model, inTokens: 0, outTokens: 0, at: now() })
            onRecord({
              at: now(), provider: cand.provider, model: cand.model,
              in: 0, out: 0, cost: 0, paid: failedPriced.paid, ok: false, code: lastErr.kind,
            })
          } catch { /* ignore */ }
          const step = ladder.onFailure(lastErr, cand, now())
          onEvent({ type: 'ladder', layer: step.layer, action: step.action, reason: step.reason })
          if (step.action === 'report') break
        } finally {
          // 🔴 无论成功/失败/抛错，都必须释放名额（否则会话名额泄漏 ⇒ 后续全挂）
          releaseSlot()
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
