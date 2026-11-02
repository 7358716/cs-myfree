/**
 * cs-myfree — 账号池（多账号选择 + 冷却 + 余额排序）
 *
 * 设计依据：v3 §4（对应 dsh-providers-hub 的「多账号池 + 静默续期」）。
 *
 * ⚠️ 凭据只在内存中流转，**本模块不落盘任何 token**
 *    （落盘由宿主凭据库负责，我们只存 accountId 索引）。
 *
 * @module cs-myfree/pools/channels/pool
 */

/** 账号状态 */
export const STATE = Object.freeze({ READY: 'ready', COOLING: 'cooling', EXPIRED: 'expired', DISABLED: 'disabled' })

/**
 * 创建一个账号池。
 * @param {{now?:()=>number}} opts
 */
export function createPool(opts = {}) {
  const now = opts.now ?? (() => Date.now())
  /** @type {Map<string, object>} accountId -> account */
  const accounts = new Map()

  return {
    /** 登记账号（不含 token，只有元数据） */
    upsert(acc) {
      const key = String(acc.id)
      const prev = accounts.get(key) ?? { id: key, addedAt: now() }
      accounts.set(key, {
        ...prev,
        provider: acc.provider,
        enabled: acc.enabled !== false,
        expiresAt: acc.expiresAt ?? null,
        balance: Number.isFinite(acc.balance) ? acc.balance : (prev.balance ?? null),
        cooldownUntil: acc.cooldownUntil ?? prev.cooldownUntil ?? 0,
        failCount: acc.failCount ?? prev.failCount ?? 0,
      })
      return accounts.get(key)
    },

    list(provider) {
      const all = [...accounts.values()]
      return provider ? all.filter((a) => a.provider === provider) : all
    },

    /** 可用账号（未过期、未冷却、已启用） */
    available(provider, at) {
      const t = at ?? now()
      return this.list(provider).filter((a) =>
        a.enabled
        && (a.expiresAt == null || a.expiresAt > t)
        && (a.cooldownUntil ?? 0) <= t)
    },

    /** 按余额降序挑一个（余额高的先烧，避免浪费） */
    pick(provider, at) {
      const cands = this.available(provider, at)
      if (cands.length === 0) return null
      return cands.sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0))[0]
    },

    /** 标记录失败 ⇒ 进入冷却 */
    markFailure(id, { ttlMs = 10 * 60 * 1000, at } = {}) {
      const a = accounts.get(String(id))
      if (!a) return null
      const t = at ?? now()
      a.failCount = (a.failCount ?? 0) + 1
      a.cooldownUntil = t + ttlMs
      return a
    },

    /** 标记成功 ⇒ 清冷却 */
    markSuccess(id) {
      const a = accounts.get(String(id))
      if (a) { a.cooldownUntil = 0; a.failCount = 0 }
      return a
    },

    /** 状态汇总（给 UI 用） */
    summary(at) {
      const t = at ?? now()
      const by = new Map()
      for (const a of accounts.values()) {
        if (!by.has(a.provider)) by.set(a.provider, { provider: a.provider, total: 0, ready: 0, cooling: 0, expired: 0, disabled: 0, balance: 0 })
        const s = by.get(a.provider)
        s.total++
        if (!a.enabled) s.disabled++
        else if (a.expiresAt != null && a.expiresAt <= t) s.expired++
        else if ((a.cooldownUntil ?? 0) > t) s.cooling++
        else s.ready++
        if (Number.isFinite(a.balance)) s.balance += a.balance
      }
      return [...by.values()]
    },

    /** 即将到期的账号（Loomy 14 天硬周期用） */
    expiringWithin(ms, at) {
      const t = at ?? now()
      return [...accounts.values()].filter((a) => a.expiresAt != null && a.expiresAt > t && a.expiresAt - t <= ms)
    },

    size() { return accounts.size },
  }
}
