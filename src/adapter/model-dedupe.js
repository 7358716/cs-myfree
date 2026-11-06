/**
 * 模型去重与「一个模型 → 一个可用渠道」（用户口径）
 *
 * 用户原话（2026-11-06）：
 *   「每次选择模型的时候，除了 deepseek 的付费 api 和自行添加的模型，
 *     其他的模型只带出一个可用的渠道。」
 *
 * 为什么需要它：
 *   同一个模型名会出现在多个渠道里（实测 `deepseek-v4.1-flash` 同时挂在
 *   codearts / buddy / workbuddy / lobsterai / cline 五家）。旧实现给渠道模型加
 *   `<渠道>/<模型>` 前缀来避重名 ⇒ 选择器里同一模型出现多次，用户要自己判断该选哪个。
 *
 * 🔴 两条硬约束：
 *   1. **付费 API / 自加 API 不参与去重**：用户明确要把它们单独列出来
 *      （它们代表「我自己花钱/自己配的」，语义与渠道包不同）。
 *   2. **去重只影响「选择器展示」，不影响路由候选**：用户选了某模型后，
 *      该模型在**所有**渠道的候选仍然参与降级（一家挂了换下一家），
 *      否则等于把「备用渠道」也砍掉了 —— 那是功能退化，不是简化。
 *
 * @module cs-myfree/adapter/model-dedupe
 */

/** 不打散、单独列出的渠道族（付费 API / 用户自加 API） */
export const SELF_API_PROVIDERS = Object.freeze([
  'deepseek-official', 'deepseek', 'ark', 'volcengine-agent-plan', 'kimi-coding',
  'deepseek-web',
])

/**
 * 该渠道是否属于「自加/付费 API」（不参与去重）。
 * @param {string} provider
 */
export function isSelfApiProvider(provider) {
  const id = String(provider ?? '').replace(/-free$|-vision$/, '')
  return SELF_API_PROVIDERS.includes(id)
}

/**
 * 渠道优先级（用于「同一个模型有多家可用时，展示哪一家」）。
 * 数字越小越优先。原则：
 *   ① 免费 + 已实测可用（loginVerified / 有额度）优先
 *   ② 其次免费
 *   ③ 最后付费
 *   ④ 同级按内置表的原始顺序（稳定，不随机跳）
 *
 * @param {{provider:string, billing?:string|null, verified?:boolean, order?:number}} o
 */
export function channelRank({ provider, billing = null, verified = false, order = 0 } = {}) {
  let score = 0
  if (isSelfApiProvider(provider)) score += 1000        // 自加/付费永远排后（但通常不去重）
  if (billing === 'paid') score += 100
  if (!verified) score += 10                            // 未验证的靠后（如实反映不确定性）
  return score * 1000 + (Number(order) || 0)
}

/**
 * 把「模型条目」按模型名去重，每个模型留**一个**展示渠道。
 *
 * 输入条目形状（宽松，两种目录都吃）：
 *   { provider, model|id, name?, billing?, verified?, order?, selfApi? }
 *
 * @param {Array<object>} entries
 * @returns {{kept:Array<object>, dropped:Array<{model:string, provider:string, keptProvider:string}>}}
 */
export function dedupeByModel(entries) {
  const list = Array.isArray(entries) ? entries : []
  const byModel = new Map()
  const dropped = []

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const model = String(raw.model ?? raw.id ?? '')
    if (!model) continue
    const provider = String(raw.provider ?? raw.channelId ?? '')
    const selfApi = raw.selfApi === true || isSelfApiProvider(provider)

    // 🔴 自加/付费 API 一律不打散：同一个模型在自加 API 上要单独保留一行
    //    （用户就是要能明确地选「用我自己 key 的那个」）。
    const key = selfApi ? `${model}\u0000${provider}` : model

    const cand = {
      ...raw,
      model,
      provider,
      selfApi,
      _rank: channelRank({ provider, billing: raw.billing, verified: raw.verified, order: raw.order }),
    }
    const cur = byModel.get(key)
    if (!cur) { byModel.set(key, cand); continue }
    // 同一模型：留 rank 更小的那家；另一家记入 dropped（可核查）
    if (cand._rank < cur._rank) {
      byModel.set(key, cand)
      dropped.push({ model, provider: cur.provider, keptProvider: provider })
    } else {
      dropped.push({ model, provider, keptProvider: cur.provider })
    }
  }

  const kept = [...byModel.values()]
  for (const e of kept) delete e._rank
  return { kept, dropped }
}

/**
 * 给定某模型，返回它在**所有**渠道的候选（去重后仍要能全量路由）。
 *
 * 用途：用户在选择器里选了 `deepseek-v4.1-flash`（展示渠道 = codearts），
 * 真实路由时 buddy / workbuddy / lobsterai / cline 仍然是备选 —— 一家挂了自动换。
 *
 * @param {Array<object>} allEntries 未去重的全量条目
 * @param {string} model
 * @returns {Array<object>}
 */
export function candidatesOfModel(allEntries, model) {
  const want = String(model ?? '')
  if (!want) return []
  return (Array.isArray(allEntries) ? allEntries : []).filter((e) => {
    const m = String(e?.model ?? e?.id ?? '')
    return m === want
  })
}