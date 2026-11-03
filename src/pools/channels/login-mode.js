/**
 * cs-myfree — 每家渠道的**推荐登录方式**（傻瓜式路由）
 *
 * 目的：用户不用懂这些厂商的区别，直接告诉他「这家这样登最简单」。
 *
 * 三种：
 *   aksk    AK/SK 永久授权 —— 真正一步，配一次永不重登（**优先推荐**）
 *   token   粘贴访问令牌 —— 一步（粘贴即保存）
 *   oauth   浏览器授权后粘贴回调链接 —— 两步
 *
 * @module cs-myfree/pools/channels/login-mode
 */

import { LOGIN } from './protocols.js'

/** 推荐方式 + 人话说明 */
export const LOGIN_MODE = Object.freeze({
  aksk: {
    id: 'aksk',
    label: 'AK/SK 永久授权',
    steps: 1,
    badge: '最简单',
    how: '去官网控制台的「访问密钥 / API 密钥」创建一对 AK/SK，粘贴进来。配一次以后永远不用再登。',
  },
  token: {
    id: 'token',
    label: '粘贴令牌',
    steps: 1,
    badge: '一步',
    how: '在官网拿到访问令牌，复制粘贴进来即可自动保存。',
  },
  oauth: {
    id: 'oauth',
    label: '浏览器登录后自动识别',
    steps: 2,
    badge: '两步',
    how: '点「去官网登录」完成授权 → 登录后把地址栏那一整串链接复制回来粘贴（粘贴瞬间自动保存，不用点按钮）。',
  },
})

/**
 * 给每家渠道决定推荐哪种方式。
 * 依据：厂商是否支持 AK/SK（国内云厂商基本都支持，且是永久凭证）
 */
const AK_SK_SUPPORTED = new Set([
  'qiniu',        // 七牛：控制台 → 密钥管理
  'officeace',    // 华为云 MaaS：我的凭证 → 访问密钥
  'codearts',     // 华为云：我的凭证 → 访问密钥
  'zcode',        // 智谱：API Key
  'minimax',      // MiniMax：API Key
  'minimaxintl',
  'accio',        // 阿里系：AK/SK
  'qoder',
  'qodercn',
])

export function recommendMode(channelId, ch) {
  if (AK_SK_SUPPORTED.has(channelId)) return LOGIN_MODE.aksk
  if (ch?.login === LOGIN.PASTE_KEY) return LOGIN_MODE.token
  if (ch?.login === LOGIN.NONE) return LOGIN_MODE.token
  // 剩下的是浏览器/扫码/设备码类 ⇒ 走「登录后自动识别」
  return LOGIN_MODE.oauth
}

/** 该渠道支持的所有方式（按步骤数从少到多） */
export function supportedModes(channelId, ch) {
  const modes = []
  if (AK_SK_SUPPORTED.has(channelId) || ch?.login === LOGIN.PASTE_KEY) modes.push(LOGIN_MODE.aksk)
  modes.push(LOGIN_MODE.token)
  if (ch?.login !== LOGIN.PASTE_KEY && ch?.login !== LOGIN.NONE) modes.push(LOGIN_MODE.oauth)
  // 去重 + 按 steps 排序
  const seen = new Set()
  return modes.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    .sort((a, b) => a.steps - b.steps)
}
