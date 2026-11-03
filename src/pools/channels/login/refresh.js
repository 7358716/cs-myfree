/**
 * cs-myfree — 渠道登录续期端点（/cs-myfree/login/refresh 的后端实现）
 *
 * 设计依据（v3 §4.3 + Loomy 实测）：
 *  · 有 refresh_token 的渠道：静默续期
 *  · **Loomy 无续期端点**（LOOMY_SESSION_TTL_SECONDS = 1,209,600 = 14 天，
 *    refreshable 恒 false）⇒ 只能如实提示「需人工重登」
 *  · AK/SK 签名型渠道（codearts）：凭证长期有效，无需续期
 *
 * 🔴 铁律：本模块**绝不打印/不落盘**凭据；返回的 credential 仅由调用方
 *    （web/routes.js）用于更新本地 0600 文件，**不进 HTTP 响应**。
 *
 * @module cs-myfree/pools/channels/login/refresh
 */

import { CHANNELS, AUTH, REFRESH } from '../protocols.js'

/** 统一文案：该渠道没有可用的续期端点 */
export const NO_REFRESH_ERROR = '该渠道无续期端点'

/**
 * 续期一个账号的登录凭证。
 *
 * @param {string} provider 渠道 id
 * @param {object|null} account 账号记录（createAccountStore 的原始条目，含 credential/ak/sk）
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @returns {Promise<{
 *   ok: boolean,
 *   error?: string,
 *   note?: string,
 *   reloginRequired?: boolean,
 *   credential?: object,
 *   expiresAt?: number,
 * }>}
 */
export async function refreshLogin(provider, account, opts = {}) {
  const ch = CHANNELS[provider]
  if (!ch) return { ok: false, error: `未知渠道：${provider}` }

  // ① Loomy 明确提示需人工重登（无续期端点，14 天硬周期）
  if (provider === 'loomy') {
    return {
      ok: false,
      error: NO_REFRESH_ERROR,
      note: 'Loomy 讯飞无续期端点（会话 14 天），需人工重登',
      reloginRequired: true,
    }
  }

  // ② 协议层声明不支持续期
  if (ch.refresh !== REFRESH.AUTO) {
    return {
      ok: false,
      error: NO_REFRESH_ERROR,
      note: ch.refresh === REFRESH.MANUAL ? '该渠道无续期端点，需人工重登' : '该渠道不支持续期',
      reloginRequired: true,
    }
  }

  // ③ AK/SK 签名型（codearts）：凭证长期有效，无需续期
  if (ch.auth === AUTH.SIGNED_HUAWEI) {
    if (!account?.ak || !account?.sk) {
      return { ok: false, error: 'AK/SK 不完整，需重新登录', reloginRequired: true }
    }
    return {
      ok: true,
      note: 'AK/SK 签名凭证长期有效，无需续期',
      credential: { ak: account.ak, sk: account.sk, securityToken: account.securityToken },
    }
  }

  // ④ 其余渠道：本插件尚无各家 refresh_token 端点实现 ⇒ 如实返回
  return {
    ok: false,
    error: NO_REFRESH_ERROR,
    note: '该渠道需要重新登录换取新凭证',
    reloginRequired: true,
  }
}