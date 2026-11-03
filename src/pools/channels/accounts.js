/**
 * cs-myfree — 渠道账号存储（本地，加密不外传）
 *
 * 🔴 安全设计（回应「会不会暴露我的凭证」）：
 *   · 凭证**只存在你自己的机器**：`~/.dsh/cs-myfree/accounts.json`（权限 0600）
 *   · **不经任何服务器中转**，不上传、不遥测
 *   · 插件代码里**没有任何人的凭证**（开源代码不含密钥）
 *   · 每个人登录的是**自己的**账号；别人的插件实例拿不到你的
 *
 * 存储结构（只存登录态，不存账号密码）：
 *   { accounts: { [id]: { provider, label, credential, addedAt, expiresAt } } }
 *
 * @module cs-myfree/pools/channels/accounts
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const ACCOUNTS_FILE = 'accounts.json'

function dirOf(dshHome) {
  return join(dshHome || process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh'), 'cs-myfree')
}

async function readAll(dshHome) {
  try {
    const o = JSON.parse(await readFile(join(dirOf(dshHome), ACCOUNTS_FILE), 'utf8'))
    return o && typeof o === 'object' && o.accounts ? o : { accounts: {} }
  } catch {
    return { accounts: {} }
  }
}

async function writeAll(dshHome, data) {
  const dir = dirOf(dshHome)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, ACCOUNTS_FILE)
  const tmp = `${dir}/.${Date.now()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, file)
    return true
  } catch {
    await unlink(tmp).catch(() => {})
    return false
  }
}

/**
 * 创建账号存储。
 * ⚠️ 返回给 UI 的数据**永远不含 credential 原文**（只含是否已登录 + 掩码）。
 */
export function createAccountStore(dshHome) {
  return {
    async list() {
      const d = await readAll(dshHome)
      return Object.entries(d.accounts).map(([id, a]) => ({
        id,
        provider: a.provider,
        label: a.label || a.provider,
        hasCredential: Boolean(a.credential),
        // 只回掩码，绝不回原文
        masked: a.credential ? maskCredential(a.credential) : null,
        addedAt: a.addedAt ?? null,
        expiresAt: a.expiresAt ?? null,
      }))
    },

    async get(id) {
      const d = await readAll(dshHome)
      return d.accounts[id] ?? null
    },

    /** 内部用：取凭证原文（只在发请求时用，不回给 UI） */
    async credentialOf(provider) {
      const d = await readAll(dshHome)
      for (const a of Object.values(d.accounts)) {
        if (a.provider === provider && a.credential) return a.credential
      }
      return null
    },

    async save({ id, provider, label, credential, expiresAt }) {
      const d = await readAll(dshHome)
      const key = id || `${provider}-${Date.now()}`
      d.accounts[key] = {
        provider,
        label: label || provider,
        credential: String(credential || ''),
        addedAt: Date.now(),
        expiresAt: expiresAt ?? null,
      }
      const ok = await writeAll(dshHome, d)
      return { ok, id: key }
    },

    async remove(id) {
      const d = await readAll(dshHome)
      if (!d.accounts[id]) return { ok: false, error: '账号不存在' }
      delete d.accounts[id]
      return { ok: await writeAll(dshHome, d), id }
    },

    async count() {
      const d = await readAll(dshHome)
      return Object.keys(d.accounts).length
    },
  }
}

/** 掩码：只露前 4 后 4 */
export function maskCredential(s) {
  const v = String(s || '')
  if (v.length <= 10) return v ? '****' : ''
  return `${v.slice(0, 4)}…${v.slice(-4)}`
}
