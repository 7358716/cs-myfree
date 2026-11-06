/**
 * cs-myfree — 计价表（付费渠道 token → 人民币）
 *
 * 🔴 真实缺陷（2026-11-04 用户反馈「昨天有花费付款 api，你没统计到」）：
 *    adapter 把 `cost: 0, paid: false` **硬编码**在两条 onRecord 上 ⇒
 *    无论走哪个渠道、用了多少 token，账本永远是「免费」。
 *    旧插件账本里有 240 条 `paid:true` 但 `cost` 全 0 —— 同样是缺价格表。
 *
 * 设计原则（与 paid-gate 的 deny-by-default 一致）：
 *  · **价格未知 ⇒ cost 记 null（未知），绝不记 0**
 *    （把未知当免费是财务上最危险的错误：花了钱却以为没花）
 *  · 价格按「每百万 token」配置，支持峰谷价
 *  · 免费渠道（免密源 / 渠道自带额度）显式标 paid:false + cost:0
 *
 * @module cs-myfree/audit/pricing
 */

/** 各模型的单价（CNY / 每百万 token）。free=true 表示不计费。 */
export const PRICING = Object.freeze({
  // ── DeepSeek 官方（付费，用户自己的 API Key）──
  'deepseek-v4-flash': {
    label: 'DeepSeek V4.1 Flash',
    unit: 'per_million_tokens',
    peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
    offPeak: { inputMiss: 1, inputHit: 0.02, output: 4 },
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  },
  // codearts 实际在用的模型名（带版本后缀，也登记一份避免「价格未知」）
  'deepseek-v4.1-flash': {
    label: 'DeepSeek V4.1 Flash (CodeArts)',
    unit: 'per_million_tokens',
    peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
    offPeak: { inputMiss: 1, inputHit: 0.02, output: 4 },
    source: '按 DeepSeek 官方价目表映射',
  },
  'deepseek-v4-pro': {
    label: 'DeepSeek V4 Pro',
    unit: 'per_million_tokens',
    peak: { inputMiss: 4, inputHit: 0.08, output: 16 },
    offPeak: { inputMiss: 2, inputHit: 0.04, output: 8 },
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  },
})

/** 免密源：永远免费（不发 Authorization，上游按 IP 限额） */
export const FREE_PROVIDERS = Object.freeze(['kilo', 'ovh', 'pollinations', 'opencode-text'])

/** 渠道自带额度（登录即用，不额外扣费）——这些也记 free */
export const CHANNEL_FREE = Object.freeze([
  'codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn',
  'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'minimaxintl',
  'zcode', 'officeace', 'accio', 'gemini', 'qiniu',
  // DeepSeek 网页版（用户自带账号）：不消耗 API token ⇒ 对用户是 0 元。
  // ⚠️ 它的成本不是钱，而是**平台风控风险**（见 protocols.js 的 note），
  //    所以「记 free」是财务口径，不代表可以无节制使用。
  'deepseek-web',
])

/**
 * DeepSeek 峰谷时段（北京时间）。
 * 谷时：00:30–08:30；其余为峰时。
 */
export function isOffPeak(atMs = Date.now()) {
  const d = new Date(atMs + 8 * 3600 * 1000) // 转 UTC+8
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes()
  return minutes >= 30 && minutes < 8 * 60 + 30
}

/**
 * 规整模型名（去掉渠道前缀、版本后缀，用于查表）。
 * 例：`codearts/deepseek-v4.1-flash` → `deepseek-v4.1-flash`
 */
export function normalizeModel(model) {
  const s = String(model ?? '').trim()
  if (!s) return ''
  const slash = s.indexOf('/')
  return slash >= 0 ? s.slice(slash + 1) : s
}

/** 查单价表；找不到返回 null（表示「未知」，不是 0） */
export function priceOf(model, atMs = Date.now()) {
  const key = normalizeModel(model)
  const hit = PRICING[key]
  if (!hit) return null
  return isOffPeak(atMs) ? hit.offPeak : hit.peak
}

/**
 * 算一次调用的费用。
 *
 * @param {object} o
 * @param {string} o.provider 渠道 id
 * @param {string} o.model 模型名（可带渠道前缀）
 * @param {number} o.inTokens 输入 token（未命中缓存）
 * @param {number} o.outTokens 输出 token
 * @param {number} [o.cacheReadTokens] 缓存命中 token（按 inputHit 计价）
 * @param {boolean} [o.paid] 渠道是否付费源
 * @param {number} [o.at] 时间戳（判峰谷）
 * @returns {{costCNY:number|null, paid:boolean, known:boolean, note?:string}}
 *   costCNY=null 表示**价格未知**（调用方必须如实记账，不能当 0）
 */
export function computeCost(o = {}) {
  const { provider = '', model = '', inTokens = 0, outTokens = 0, cacheReadTokens = 0, at = Date.now() } = o

  // 免密源 / 渠道自带额度 ⇒ 确定性免费
  const prov = String(provider).replace(/^.*\//, '')
  if (FREE_PROVIDERS.includes(prov) || CHANNEL_FREE.includes(prov)) {
    return { costCNY: 0, paid: false, known: true, note: '免费源/渠道额度' }
  }

  // 付费源：必须有价格才能算
  const price = priceOf(model, at)
  if (!price) {
    return { costCNY: null, paid: true, known: false, note: `价格未知：${model}（请在 pricing.js 补充单价）` }
  }

  const missIn = Math.max(0, Number(inTokens) || 0)
  const hitIn = Math.max(0, Number(cacheReadTokens) || 0)
  const out = Math.max(0, Number(outTokens) || 0)
  const cost = (missIn * price.inputMiss + hitIn * price.inputHit + out * price.output) / 1_000_000
  return {
    costCNY: Number(cost.toFixed(6)),
    paid: true,
    known: true,
    note: isOffPeak(at) ? '谷时价' : '峰时价',
  }
}
