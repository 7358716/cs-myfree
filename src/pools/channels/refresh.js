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
