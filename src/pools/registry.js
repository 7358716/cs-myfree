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
  { id: 'qiniu', label: 'Qiniu（七牛）', kind: KIND.ACCOUNT, checkin: false },

  { id: 'deepseek-official', label: 'DeepSeek 官方', kind: KIND.SELFAPI, paid: true },
  { id: 'ark', label: '火山方舟', kind: KIND.SELFAPI, paid: true },
  { id: 'deepseek-web', label: 'DeepSeek 网页版', kind: KIND.SELFAPI, paid: false },
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
