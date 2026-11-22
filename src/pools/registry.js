/**
 * cs-myfree — 供应源注册表（**不含任何密钥**）
 *
 * 设计依据：v3 §4（渠道层 = dsh-providers-hub 的能力面）。
 * 本文件只描述「有哪些源、什么性质」，凭据一律在运行时从宿主凭据库取。
 *
 * @module cs-myfree/pools/registry
 */

export const KIND = Object.freeze({ KEYLESS: 'keyless', ACCOUNT: 'account', SELFAPI: 'selfapi' })

export const SOURCES = Object.freeze([
  { id: 'kilo-free', label: 'Kilo 免费池', kind: KIND.KEYLESS, note: '完全免密；prompt 可能被上游记录' },
  { id: 'ovh-vision', label: 'OVH 免费视觉', kind: KIND.KEYLESS, note: '识图专用；免密' },
  { id: 'pollinations', label: 'Pollinations', kind: KIND.KEYLESS, note: '免密；能力较弱' },
  // 自加免费 API（2026-11-16）：用户粘贴 OpenAI 兼容端点 + Key 即可用 ⇒ 归**免费池**
  //   ⚠️ 与 ark/deepseek-official（付费，kind=SELFAPI）分开：这是用户声明免费的端点
  { id: 'custom-free', label: '自加免费 API（OpenAI 兼容）', kind: KIND.ACCOUNT, note: '粘贴 Base URL + API Key；如 AMD 开发者云 / Groq / OpenRouter 免费模型 / 本地 Ollama' },

  { id: 'codearts', label: 'CodeArts（华为云）', kind: KIND.ACCOUNT, checkin: true },
  { id: 'buddy', label: 'CodeBuddy（腾讯）', kind: KIND.ACCOUNT, checkin: true },
  { id: 'workbuddy', label: 'WorkBuddy（国际）', kind: KIND.ACCOUNT, checkin: false },
  { id: 'lobsterai', label: 'LobsterAI（有道）', kind: KIND.ACCOUNT, checkin: true },
  { id: 'qoder', label: 'Qoder', kind: KIND.ACCOUNT, checkin: true },
  { id: 'qodercn', label: 'Qoder 中国版', kind: KIND.ACCOUNT, checkin: true },
  { id: 'trae', label: 'TRAE（字节）', kind: KIND.ACCOUNT, checkin: true },
  { id: 'cline', label: 'Cline', kind: KIND.ACCOUNT, checkin: false },
  { id: 'loomy', label: 'Loomy（讯飞）', kind: KIND.ACCOUNT, checkin: true, note: '14 天人工重登' },
  { id: 'raccoon', label: 'Raccoon（商汤）', kind: KIND.ACCOUNT, checkin: false },
  { id: 'minimax', label: 'MiniMax Code', kind: KIND.ACCOUNT, checkin: true },
  { id: 'minimaxintl', label: 'MiniMax 国际', kind: KIND.ACCOUNT, checkin: true },
  { id: 'zcode', label: 'ZCode（智谱）', kind: KIND.ACCOUNT, checkin: true },
  { id: 'opencode', label: 'OpenCode', kind: KIND.ACCOUNT, checkin: false },
  { id: 'gemini', label: 'Gemini Code Assist', kind: KIND.ACCOUNT, checkin: false, note: '当前网络不可达' },
  { id: 'officeace', label: 'OfficeAce（华为 MaaS）', kind: KIND.ACCOUNT, checkin: true },
  { id: 'accio', label: 'Accio（阿里）', kind: KIND.ACCOUNT, checkin: false },

  // ── 付费池（2026-11-23 改造）────────────────────────────────────────
  //
  // 🔴 这里只放「**不是账号登录**、而是 API / 计划型付费源」。
  //    此前 deepseek-official / ark / deepseek-web 三条混在渠道包里，与
  //    「登录账号用积分」的语义不符 ⇒ 已移出渠道包：
  //      · `ark`（火山方舟）改由**付费池**承接（见下方 agentPlan 标记）；
  //      · `deepseek-official` / `deepseek-web` 由宿主自带适配器 / 模型链承担，
  //        不再由本插件声明（宿主对 deepseek-official 有自己的 adapter，
  //        这里再声明一遍会重复）。
  { id: 'custom-paid', label: '自加付费 API（OpenAI 兼容）', kind: KIND.SELFAPI, paid: true, note: '你自己粘贴的付费端点' },
  // 火山方舟：保留为付费源，但标记 **agentPlan** 模式
  //   （模型清单来自 `plan-models-user.json`，不是普通 API 的 /models 探测）
  { id: 'ark', label: '火山方舟（Agent Plan）', kind: KIND.SELFAPI, paid: true, agentPlan: true,
    note: '计划型付费源：模型清单读 plan-models-user.json' },
  // 阿里云百炼 Token Plan（2026-11-23 新增）
  //   🔴 key 一律从**宿主凭据库 / 环境变量**读，绝不硬编码（本文件不含任何密钥）。
  { id: 'qwen-token-plan-cn', label: '阿里云百炼 Token Plan（国内）', kind: KIND.SELFAPI, paid: true,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    credentialEnv: 'QWEN_TOKEN_PLAN_CN_API_KEY',
    note: 'OpenAI 兼容端点；Key 来自宿主凭据 QWEN_TOKEN_PLAN_CN_API_KEY' },
])

export function sourceById(id) { return SOURCES.find((s) => s.id === id) ?? null }
export function keylessSources() { return SOURCES.filter((s) => s.kind === KIND.KEYLESS) }
export function paidSources() { return SOURCES.filter((s) => s.paid === true) }
export function checkinSources() { return SOURCES.filter((s) => s.checkin === true) }

/**
 * 构建候选顺序：免密池 → 账号渠道 → （付费仅当显式允许）
 * @param {{allowPaid?:boolean, enabled?:Set<string>, disabled?:Set<string>}} opts
 */
export function buildOrder(opts = {}) {
  const { allowPaid = false, enabled, disabled } = opts
  const ok = (s) => {
    if (disabled?.has(s.id)) return false
    if (enabled && enabled.size > 0 && !enabled.has(s.id)) return false
    if (s.paid === true && !allowPaid) return false
    return true
  }
  const rank = { [KIND.KEYLESS]: 0, [KIND.ACCOUNT]: 1, [KIND.SELFAPI]: 2 }
  return SOURCES.filter(ok).sort((a, b) => rank[a.kind] - rank[b.kind])
}
