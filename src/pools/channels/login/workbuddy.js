/**
 * cs-myfree — WorkBuddy（国际版）浏览器一键登录（真实实现）
 *
 * 与 buddy（腾讯 CodeBuddy 中国版）**同源同协议**，差异全部收敛在产品配置
 * （见 buddy.js 的 BUDDY_PRODUCTS.workbuddy，逐字对拍参考包 product.js）：
 *   · endpoint : https://www.workbuddy.ai（vs copilot.tencent.com）
 *   · platform : workbuddy-ai（vs ide）
 *   · productCode / User-Agent : workbuddy / WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2
 *   · 登录 URL 需追加 `version=5.5.2` 与 `loginSessionId=<uuid>`
 *     （只追加参数，不重建 URL —— platform/state/路径由服务端 authUrl 决定）
 *   · 无签到/成长中心（checkin 在协议表里已标 supported:false，与本模块无关）
 *
 * 流程、错误分类、定时与凭据解析全部复用 buddy.js；本文件只做产品绑定。
 *
 * 🔴 本渠道同样**没有** redirect_uri / 回调 / code 交换：state 由厂商
 *    `/v2/plugin/auth/state` 下发，poll 用该 state 轮询。不要塞 callbackUrl。
 *
 * @module cs-myfree/pools/channels/login/workbuddy
 */

import {
  BUDDY_PRODUCTS,
  startProductLogin,
  pollProductLogin,
  refreshProductToken,
  decorateLoginUrl,
  AUTH_REFRESH_SOURCE,
} from './buddy.js'

/** WorkBuddy 国际版的产品配置（来自 buddy.js 的同一份对拍数据）。 */
export const WORKBUDDY_PRODUCT = BUDDY_PRODUCTS.workbuddy

/** WorkBuddy 国际版 start（async：现场向 /v2/plugin/auth/state 换 authUrl）。 */
export function startWorkbuddy(provider, ch, opts = {}) {
  return startProductLogin(WORKBUDDY_PRODUCT, provider ?? 'workbuddy', ch, opts)
}

/** WorkBuddy 国际版 poll（轮询 token → account → credential）。 */
export function pollWorkbuddy(session, opts = {}) {
  return pollProductLogin(WORKBUDDY_PRODUCT, session, opts)
}

/** WorkBuddy 国际版静默续期（refresh_token 已由 routes/accounts 落盘）。 */
export function refreshWorkbuddyToken(credential, opts = {}) {
  return refreshProductToken(WORKBUDDY_PRODUCT, credential, opts)
}

export { decorateLoginUrl, AUTH_REFRESH_SOURCE }
