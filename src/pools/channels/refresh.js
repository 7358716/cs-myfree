/**
 * cs-myfree — 凭据静默续期
 *
 * 设计依据：v3 §4.3 + Loomy 实测的硬事实：
 *  · 有 refresh 的渠道：到期前自动换（静默）
 *  · **Loomy 无续期端点**（`LOOMY_SESSION_TTL_SECONDS = 1,209,600` = 14 天，
 *    `refreshable` 恒 false，`scheduleRefresh()` 是**有意为之的空实现**）
 *    ⇒ 只能提前告警 + 人工重登
 *
 * @module cs-myfree/pools/channels/refresh
 */

import { REFRESH } from './protocols.js'

/** 提前多久提醒（24 小时） */
export const WARN_BEFORE_MS = 24 * 3600 * 1000

/**
 * 判定某账号需要做什么。
 *
 * @param {object} o
 * @param {object} o.ch       渠道协议
 * @param {number} o.expiresAt 到期时间戳（null=长期）
 * @param {number} o.now
 */
export function planRefresh({ ch, expiresAt, now = Date.now() } = {}) {
  if (expiresAt == null) return { action: 'none', reason: '长期有效' }

  const left = expiresAt - now
  if (left <= 0) {
    return ch?.refresh === REFRESH.AUTO
      ? { action: 'refresh-now', reason: '已过期，尝试静默续期' }
      : { action: 'relogin', reason: '已过期且该渠道无续期端点，必须人工重登' }
  }

  if (ch?.refresh === REFRESH.MANUAL) {
    return {
      action: left <= WARN_BEFORE_MS ? 'warn-relogin' : 'watch',
      hoursLeft: Math.round(left / 3600_000),
      reason: left <= WARN_BEFORE_MS
        ? `该渠道无续期端点，${Math.round(left / 3600_000)}h 后失效，请提前重登`
        : '尚在有效期内',
    }
  }

  if (ch?.refresh === REFRESH.AUTO && left <= WARN_BEFORE_MS) {
    return { action: 'refresh-soon', hoursLeft: Math.round(left / 3600_000), reason: '临近到期，安排静默续期' }
  }

  return { action: 'none', hoursLeft: Math.round(left / 3600_000), reason: '正常' }
}

/** 批量体检所有账号，返回需要处理的清单 */
export function auditCredentials({ channels = {}, accounts = [], now = Date.now() } = {}) {
  const out = []
  for (const a of accounts) {
    const ch = channels[a.provider]
    if (!ch) continue
    const p = planRefresh({ ch, expiresAt: a.expiresAt, now })
    if (p.action !== 'none' && p.action !== 'watch') {
      out.push({ accountId: a.id, provider: a.provider, ...p })
    }
  }
  return {
    at: now,
    needsAction: out,
    reloginRequired: out.filter((x) => x.action === 'relogin' || x.action === 'warn-relogin'),
    autoRefreshable: out.filter((x) => x.action === 'refresh-now' || x.action === 'refresh-soon'),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 真实接线（v1.9.0）：定时扫描 + 到期前静默续期（setTimeout 链 + unref）
// ─────────────────────────────────────────────────────────────────────────────

/** 默认：每 60 秒扫一次账号表；到期前 5 分钟尝试续期 */
export const DEFAULT_REFRESH_CONFIG = Object.freeze({
  enabled: false,       // 写操作默认关（用户明确打开才跑）
  tickMs: 60_000,
  leadMinutes: 5,
})

/**
 * 创建续期调度器。
 *
 * 🔴 不用 ctx.interval（recon2/20 §0-5：读未 inject 的 timer 会抛异常导致
 *    整插件不激活）。只依赖全局 setTimeout，句柄 unref()。
 *
 * @param {object} o
 * @param {() => object} o.config  → {enabled, tickMs, leadMinutes}
 * @param {object} o.accounts      accountStore
 * @param {(provider:string, account:object, opts:object) => Promise<object>} [o.refreshAccount]
 *        默认注入 login 组的 refreshLogin（可 mock）
 * @param {object} [o.channels]  渠道协议表（默认 protocols.CHANNELS）
 * @param {() => number} [o.now]
 * @param {Function} [o.setTimer] / [o.clearTimer] 测试注入
 */
export function createRefreshScheduler(o = {}) {
  const {
    config = () => ({}),
    accounts,
    refreshAccount = null,
    channels = null,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
    logger = { info() {}, warn() {}, debug() {} },
    saveCredential = null,     // async (account, credential, expiresAt) => bool
  } = o

  const CODES = null
  let timer = null
  let started = false
  let running = false
  let lastAt = 0
  let lastResult = null
  let lastError = null

  const cfg = () => {
    const c = config() ?? {}
    return {
      enabled: c.enabled === true,
      tickMs: Number.isFinite(c.tickMs) && c.tickMs >= 5_000 ? c.tickMs : DEFAULT_REFRESH_CONFIG.tickMs,
      leadMinutes: Number.isFinite(c.leadMinutes) ? c.leadMinutes : DEFAULT_REFRESH_CONFIG.leadMinutes,
    }
  }

  function clear() {
    if (timer !== null) {
      try { clearTimer(timer) } catch { /* ignore */ }
      timer = null
    }
  }

  function schedule() {
    clear()
    const c = cfg()
    if (!c.enabled) return
    timer = setTimer(() => { tick().catch(() => {}).finally(() => schedule()) }, c.tickMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  /** 扫一轮：只处理「临近到期 / 已过期」的账号 */
  async function tick() {
    const c = cfg()
    if (!c.enabled) return { skipped: true, reason: 'disabled' }
    if (running) return { skipped: true, reason: 'already-running' }
    running = true
    lastAt = now()
    try {
      let list = []
      try { list = await accounts.list() } catch { list = [] }
      const CH = channels ?? (await import('./protocols.js')).CHANNELS
      const actions = []
      for (const a of list) {
        const ch = CH[a.provider]
        if (!ch) continue
        const plan = planRefresh({ ch, expiresAt: a.expiresAt, now: now() })
        if (plan.action !== 'refresh-now' && plan.action !== 'refresh-soon') continue
        if (plan.action === 'refresh-soon') {
          const msLeft = (a.expiresAt ?? 0) - now()
          if (msLeft > c.leadMinutes * 60_000) continue
        }
        let outcome
        try {
          const raw = typeof accounts.get === 'function' ? await accounts.get(a.id) : null
          const r = refreshAccount
            ? await refreshAccount(a.provider, raw)
            : { ok: false, error: '未注入续期实现', reloginRequired: true }
          if (r?.ok && r.credential && saveCredential) {
            await saveCredential(raw ?? a, r.credential, r.expiresAt ?? null)
          }
          outcome = { provider: a.provider, accountId: a.id, ok: r?.ok === true, note: r?.note ?? null, error: r?.error ?? null, reloginRequired: r?.reloginRequired === true }
        } catch (err) {
          outcome = { provider: a.provider, accountId: a.id, ok: false, error: String(err?.message ?? err) }
        }
        actions.push(outcome)
      }
      lastResult = { at: now(), actions, count: actions.length }
      lastError = null
      if (actions.length > 0) logger.info?.(`续期扫描：${actions.length} 个账号需要处理`)
      return lastResult
    } catch (err) {
      lastError = String(err?.message ?? err)
      logger.warn?.(`续期扫描失败：${lastError}`)
      return { error: lastError }
    } finally {
      running = false
    }
  }

  return {
    start() { started = true; schedule(); return this },
    stop() { started = false; clear(); return this },
    setEnabled(enabled) { if (enabled) { started = true; schedule() } else { clear() } return this },
    reschedule() { if (started) schedule(); return this },
    /** 手动扫一轮（显式操作） */
    runNow() { return tick() },
    _tick: tick,
    status() {
      const c = cfg()
      return {
        enabled: c.enabled,
        alive: timer !== null,
        running,
        tickMs: c.tickMs,
        leadMinutes: c.leadMinutes,
        lastAt: lastAt || null,
        lastResult,
        lastError,
      }
    },
  }
}
