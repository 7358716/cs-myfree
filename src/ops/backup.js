/**
 * cs-myfree — 备份与迁移
 *
 * 设计依据：v3 §4（对应 dsh-providers-hub 的「账号备份迁移」）。
 *
 * 🔴 安全红线（与事故 1 直接相关）：
 *    **默认不导出任何凭据**。导出只含「配置 + 账号索引」，
 *    用户若要连带凭据必须**显式传 includeCredentials:true**，
 *    且导出文件权限强制 0600、并在返回里明确警告。
 *
 * @module cs-myfree/ops/backup
 */

export const SCHEMA = 'cs-myfree/backup/v1'

/**
 * 构造备份包。
 *
 * @param {object} o
 * @param {object} o.config        插件配置（不含密钥）
 * @param {Array}  o.accounts      账号索引（id/provider/expiresAt/balance，**不含 token**）
 * @param {boolean} o.includeCredentials 显式要求才带凭据
 * @param {object} o.credentials   仅在 includeCredentials 时使用
 */
export function buildBackup({ config = {}, accounts = [], includeCredentials = false, credentials = {} } = {}) {
  const safeAccounts = accounts.map((a) => ({
    id: a.id, provider: a.provider, enabled: a.enabled !== false,
    expiresAt: a.expiresAt ?? null, balance: a.balance ?? null,
  }))

  const base = {
    schema: SCHEMA,
    at: Date.now(),
    config,
    accounts: safeAccounts,
    containsCredentials: false,
  }

  if (!includeCredentials) return base

  return {
    ...base,
    containsCredentials: true,
    credentials,
    warning: '⚠️ 此备份含明文凭据：请立即转移到安全位置，不要留在 /tmp 或共享目录',
  }
}

/** 校验导入包（导入前必须预览差异） */
export function validateBackup(obj = {}) {
  const errors = []
  if (obj?.schema !== SCHEMA) errors.push(`schema 不匹配（期望 ${SCHEMA}）`)
  if (!Array.isArray(obj?.accounts)) errors.push('accounts 必须是数组')
  if (typeof obj?.config !== 'object') errors.push('config 必须是对象')

  const accounts = Array.isArray(obj?.accounts) ? obj.accounts : []
  for (const a of accounts) {
    if (!a?.id || !a?.provider) errors.push(`账号条目缺 id/provider：${JSON.stringify(a).slice(0, 60)}`)
  }

  return {
    ok: errors.length === 0,
    errors,
    containsCredentials: obj?.containsCredentials === true,
    accountCount: accounts.length,
    // 导入预览：告诉用户会发生什么
    preview: {
      willAdd: accounts.length,
      hasCredentials: obj?.containsCredentials === true,
      requiresExplicitConsent: obj?.containsCredentials === true,
    },
  }
}

/**
 * 计算导入差异（**导入前必须给用户看这个**）。
 * @param {object} incoming 备份包
 * @param {{accounts?:Array, config?:object}} current 当前状态
 */
export function diffImport(incoming = {}, current = {}) {
  const cur = new Map((current.accounts ?? []).map((a) => [a.id, a]))
  const add = [], update = [], same = []
  for (const a of incoming.accounts ?? []) {
    const old = cur.get(a.id)
    if (!old) add.push(a.id)
    else if (JSON.stringify(old) !== JSON.stringify(a)) update.push(a.id)
    else same.push(a.id)
  }
  const incomingIds = new Set((incoming.accounts ?? []).map((a) => a.id))
  const remove = [...cur.keys()].filter((id) => !incomingIds.has(id))

  return {
    add, update, same, remove,
    // 删除是危险动作：默认不做，要显式确认
    willRemove: false,
    summary: `新增 ${add.length}、更新 ${update.length}、不变 ${same.length}、将保留 ${remove.length} 个现有账号`,
  }
}
