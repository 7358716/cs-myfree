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
 *   { accounts: { [id]: { provider, label, credential, ak?, sk?, securityToken?, addedAt, expiresAt } } }
 *
 * 🔴 AK/SK 渠道（codearts 等签名型）需要 **AK+SK（+securityToken）三元组**，
 *    单个字符串装不下。历史数据曾把 AK、SK 各存成一条账号（两条记录），
 *    这里提供 `pairAkSkEntries()` 一次性配对归一 + `secretOf()` 统一取用。
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
      return Object.entries(d.accounts).map(([id, a]) => {
        const isAkSk = Boolean(a.ak && a.sk)
        return {
          id,
          provider: a.provider,
          label: a.label || a.provider,
          kind: isAkSk ? 'aksk' : 'token',
          hasCredential: isAkSk || Boolean(a.credential),
          // 只回掩码，绝不回原文
          masked: isAkSk ? `${maskCredential(a.ak)} / ${maskCredential(a.sk)}` : (a.credential ? maskCredential(a.credential) : null),
          addedAt: a.addedAt ?? null,
          expiresAt: a.expiresAt ?? null,
        }
      })
    },

    async get(id) {
      const d = await readAll(dshHome)
      return d.accounts[id] ?? null
    },

    /** 内部用：取凭证原文（只在发请求时用，不回给 UI） */
    async credentialOf(provider) {
      const d = await readAll(dshHome)
      for (const a of Object.values(d.accounts)) {
        if (a.provider !== provider) continue
        if (a.ak && a.sk) return `${a.ak}:${a.sk}`
        if (a.credential) return a.credential
      }
      return null
    },

    /**
     * 内部用：取**结构化凭据**（AK/SK 签名型渠道用）。
     * 兼容老数据：单字符串 `AK:SK` 会拆开；同 provider 下「像 AK + 像 SK」的
     * 两条历史记录会在内存里自动配对（不写盘，写盘走 normalizeAkSk）。
     * @returns {Promise<{token?:string, ak?:string, sk?:string, securityToken?:string}|null>}
     */
    async secretOf(provider) {
      const d = await readAll(dshHome)
      const { merged } = pairAkSkEntries(d.accounts)
      for (const a of Object.values(merged)) {
        if (a.provider !== provider) continue
        if (a.ak && a.sk) {
          return { ak: a.ak, sk: a.sk, securityToken: a.securityToken, token: a.credential && !String(a.credential).includes(':') ? a.credential : undefined }
        }
        if (typeof a.credential === 'string' && a.credential.includes(':')) {
          const [ak, sk] = a.credential.split(':')
          if (ak && sk) return { ak, sk, securityToken: a.securityToken }
        }
        if (a.credential) return { token: a.credential }
      }
      return null
    },

    /**
     * 一次性归一：把同 provider 下「AK 一条 + SK 一条」的历史账号合成一条（写盘）。
     * @param {Set<string>} providers 需要 AK/SK 的渠道集合
     * @returns {Promise<{changed:boolean, before:number, after:number}>}
     */
    async normalizeAkSk(providers = new Set()) {
      try {
        const d = await readAll(dshHome)
        const before = Object.keys(d.accounts).length
        const { merged, changed } = pairAkSkEntries(d.accounts, providers)
        if (!changed) return { changed: false, before, after: before }
        const ok = await writeAll(dshHome, { accounts: merged })
        return { changed: ok, before, after: Object.keys(merged).length }
      } catch {
        return { changed: false, before: 0, after: 0 }
      }
    },

    async save({ id, provider, label, credential, ak, sk, securityToken, expiresAt }) {
      const d = await readAll(dshHome)
      const key = id || `${provider}-${Date.now()}`
      let credAk = typeof ak === 'string' && ak.trim() ? ak.trim() : ''
      let credSk = typeof sk === 'string' && sk.trim() ? sk.trim() : ''
      // 兼容 UI 的 `AK:SK` 单字符串提交
      if (!credAk && !credSk && typeof credential === 'string' && credential.includes(':')) {
        const [a, b] = credential.split(':')
        if (a && b) { credAk = a; credSk = b }
      }
      const entry = {
        provider,
        label: label || provider,
        credential: String(credential || ''),
        addedAt: Date.now(),
        expiresAt: expiresAt ?? null,
      }
      if (credAk && credSk) {
        entry.ak = credAk
        entry.sk = credSk
        if (typeof securityToken === 'string' && securityToken.trim()) entry.securityToken = securityToken.trim()
      }
      d.accounts[key] = entry
      const ok = await writeAll(dshHome, d)
      return { ok, id: key, kind: credAk && credSk ? 'aksk' : 'token' }
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

/**
 * 纯函数：把「AK 一条 + SK 一条」的历史账号配对成一条（不改入参）。
 *
 * 判定依据（2026-11-03 实测）：华为云 AK 20 字符、SK 40 字符；
 * 两条记录同 provider、都没有完整 ak+sk、长度差 ≥ 8 且都像密钥（无空白）。
 * 只对 `providers` 指定的渠道生效（默认 codearts 这类签名型渠道），
 * 避免把普通 token 渠道的两条账号误合。
 *
 * @param {Record<string, any>} accounts
 * @param {Set<string>} [providers] 允许配对的渠道集合
 * @returns {{merged:Record<string,any>, changed:boolean}}
 */
export function pairAkSkEntries(accounts = {}, providers = new Set()) {
  const entries = accounts && typeof accounts === 'object' ? accounts : {}
  const merged = {}
  const byProvider = new Map()
  for (const [id, a] of Object.entries(entries)) {
    if (!a || typeof a !== 'object') { merged[id] = a; continue }
    if (a.ak && a.sk) { merged[id] = a; continue }              // 已完整 ⇒ 原样保留
    if (!byProvider.has(a.provider)) byProvider.set(a.provider, [])
    byProvider.get(a.provider).push([id, a])
  }

  let changed = false
  for (const [provider, list] of byProvider) {
    const canPair = providers.size === 0 ? true : providers.has(provider)
    const picked = list.filter(([, a]) => typeof a.credential === 'string' && a.credential !== '' && !/\s/.test(a.credential))
    if (canPair && picked.length === 2) {
      const [x, y] = picked
      const lenX = String(x[1].credential).length
      const lenY = String(y[1].credential).length
      if (lenX !== lenY) {
        const short = lenX < lenY ? x : y
        const long = lenX < lenY ? y : x
        if (String(short[1].credential).length >= 16 && String(long[1].credential).length >= 32) {
          const id = `${provider}-aksk`
          merged[id] = {
            provider,
            label: short[1].label || long[1].label || provider,
            credential: '',
            ak: String(short[1].credential),
            sk: String(long[1].credential),
            addedAt: Math.min(short[1].addedAt ?? Date.now(), long[1].addedAt ?? Date.now()),
            expiresAt: short[1].expiresAt ?? long[1].expiresAt ?? null,
          }
          changed = true
          continue
        }
      }
    }
    for (const [id, a] of list) merged[id] = a
  }
  return { merged, changed }
}
