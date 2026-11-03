/**
 * cs-myfree — 积分/签到执行器（按渠道分发）
 *
 * 设计：能力表（capabilities.js）说能做的才做；不能做的返回
 * `{kind:'unsupported', reason}`，**绝不假装成功**。
 *
 * @module cs-myfree/pools/channels/credits
 */

import { claimDailyCheckin, fetchCredits as fetchCodeartsCredits, signedSnapRequest } from './codearts.js'
import { capabilityOf, autoCheckinProviders } from './capabilities.js'

export { CREDITS_CAPABILITIES, capabilityOf, autoCheckinProviders } from './capabilities.js'
export * as codearts from './codearts.js'

/**
 * 对单个渠道执行一次签到/领积分。
 *
 * @param {string} provider
 * @param {{secret?:object, fetchImpl?:Function, now?:()=>number}} o
 * @returns {Promise<{provider:string, kind:string, gain?:object, message:string}>}
 *   kind: claimed | already-claimed | inactive | unsupported | failed
 */
export async function runCheckin(provider, o = {}) {
  const cap = capabilityOf(provider)
  if (cap.checkin !== true || cap.verified !== true) {
    return {
      provider,
      kind: 'unsupported',
      message: cap.reason || '该渠道不支持自动签到',
    }
  }
  if (!o.secret) {
    return { provider, kind: 'failed', message: '该渠道尚未登录（缺少凭据）', code: 'AUTH' }
  }
  try {
    if (provider === 'codearts') {
      const r = await claimDailyCheckin({
        secret: o.secret,
        fetchImpl: o.fetchImpl,
        now: o.now,
      })
      return { provider, ...r }
    }
    return { provider, kind: 'unsupported', message: '未实现该渠道的签到流程' }
  } catch (err) {
    return { provider, kind: 'failed', message: String(err?.message ?? err) }
  }
}

/**
 * 查某渠道的余额/积分。
 * @returns {Promise<{provider:string, ok:boolean, total?:number|null, unit?:string, error?:string, note?:string}>}
 */
export async function fetchCredits(provider, o = {}) {
  const cap = capabilityOf(provider)
  if (cap.credits !== true) {
    return { provider, ok: false, error: cap.reason || '该渠道未实现余额/积分查询' }
  }
  if (!o.secret) {
    return { provider, ok: false, error: '该渠道尚未登录（缺少凭据）' }
  }
  try {
    if (provider === 'codearts') {
      const r = await fetchCodeartsCredits({ secret: o.secret, fetchImpl: o.fetchImpl })
      return { provider, ...r }
    }
    return { provider, ok: false, error: '未实现该渠道的余额查询' }
  } catch (err) {
    return { provider, ok: false, error: String(err?.message ?? err) }
  }
}

/**
 * 串行跑一批渠道的签到（反风控口径；一家失败不影响其他）。
 *
 * @param {string[]} providers
 * @param {(provider:string) => Promise<any>} runner 单渠道执行函数（可注入 mock）
 * @param {{now?:()=>number}} [o]
 */
export async function runProviders(providers, runner, o = {}) {
  const now = o.now ?? (() => Date.now())
  const results = []
  for (const provider of Array.isArray(providers) ? providers : []) {
    const t0 = now()
    try {
      const r = await runner(provider)
      results.push({ provider, ...(r ?? {}), ms: now() - t0 })
    } catch (err) {
      results.push({ provider, kind: 'failed', message: String(err?.message ?? err), ms: now() - t0 })
    }
  }
  return results
}

/** 供 /credits 端点：批量查（串行，避免并发风控） */
export async function fetchAllCredits(providers, secretsOf, o = {}) {
  const out = []
  for (const provider of Array.isArray(providers) ? providers : []) {
    try {
      const secret = secretsOf ? await secretsOf(provider) : null
      out.push(await fetchCredits(provider, { ...o, secret }))
    } catch (err) {
      out.push({ provider, ok: false, error: String(err?.message ?? err) })
    }
  }
  return out
}

/** 直接导出底层请求（测试/诊断用） */
export { signedSnapRequest }
