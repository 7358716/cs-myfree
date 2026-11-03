/**
 * cs-myfree — 渠道登录 API
 *
 * 登录方式分两类：
 *   A. **粘贴式**（apiKey/qiniu 等）：前端直接提交凭证 → 存本地 0600 文件
 *   B. **跳转式**（浏览器回调/设备码/扫码/短信）：后端返回**登录指引**
 *      （打开哪个 URL、点哪里、拿到什么后填回来），凭证仍由用户在本地填回
 *
 * 🔴 安全红线：
 *   · 凭证**只写本地文件**，绝不外传、绝不打日志
 *   · 回给前端的永远是**掩码**，不是原文
 *   · 登录指引里的 URL 全部是**厂商官方域名**
 *
 * @module cs-myfree/web/channels
 */

import { CHANNELS, LOGIN } from '../pools/channels/protocols.js'

/** 各登录方式的执行指引 */
export const LOGIN_GUIDES = Object.freeze({
  [LOGIN.PASTE_KEY]: {
    kind: 'paste',
    title: '粘贴 API Key',
    steps: ['在厂商控制台创建 API Key', '把 Key 粘贴到下方输入框', '点保存'],
    field: 'API Key',
  },
  [LOGIN.BROWSER_CALLBACK]: {
    kind: 'browser',
    title: '浏览器授权登录',
    steps: [
      '点下面「打开登录页」按钮',
      '在打开的页面完成登录并授权',
      '授权完成后把浏览器地址栏的授权码（code）复制过来',
      '粘贴到下方输入框并点保存',
    ],
    field: '授权码 / code',
  },
  [LOGIN.DEVICE_CODE]: {
    kind: 'device',
    title: '设备码登录',
    steps: [
      '点「打开登录页」，页面会显示一个设备码',
      '用你的账号确认该设备码',
      '确认后把返回的 token 粘贴到下方输入框',
      '点保存',
    ],
    field: 'token',
  },
  [LOGIN.QR_WECHAT]: {
    kind: 'qr',
    title: '扫码 / 短信登录',
    steps: [
      '点「打开登录页」',
      '用手机扫码，或选择短信验证码登录',
      '登录成功后，把返回的 access_token 复制出来',
      '粘贴到下方输入框并点保存',
    ],
    field: 'access_token',
  },
  [LOGIN.SMS]: {
    kind: 'sms',
    title: '短信验证码登录',
    steps: ['点「打开登录页」', '输入手机号获取验证码', '完成后把 token 粘贴回来', '点保存'],
    field: 'token',
  },
  [LOGIN.OAUTH_PKCE]: {
    kind: 'oauth',
    title: 'OAuth 登录',
    steps: [
      '点「打开官网」→ 在页面里找到「登录」或「API Key / 访问密钥」入口',
      '完成登录后，进入「我的凭证 / 访问密钥」页面',
      '创建一个密钥，复制 AK/SK 或 access token',
      '粘贴到下方输入框并点保存',
    ],
    field: 'AK/SK 或 access token',
    warn: '这类渠道的登录入口在官网深处，插件无法代你跳转；请按上面步骤自己找',
  },
  [LOGIN.NONE]: {
    kind: 'none',
    title: '无需登录',
    steps: ['该渠道不需要账号', '填写 API Key 即可（若厂商要求）'],
    field: 'API Key（可选）',
  },
})

/**
 * 取某渠道的**登录入口页**。
 *
 * 🔴 教训：之前用「API 域名 + 根路径」当登录页，大部分打不开（404）。
 *    现在用协议表里手工确认的 `loginPage`，并且 UI 明确标注
 *    「在官网里自己找登录/API Key 入口」—— 不误导用户。
 */
export function loginUrlOf(id) {
  const ch = CHANNELS[id]
  if (!ch) return null
  if (ch.loginPage) return ch.loginPage
  // 兜底：没有登记 loginPage 的只给站点首页
  const base = ch.accountBase || ch.baseUrl
  try {
    const u = new URL(base)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

/**
 * 列出所有渠道 + 登录方式 + 是否已登录。
 * @param {object} store createAccountStore 的实例
 */
export async function listChannels(store) {
  const accounts = await store.list()
  const byProvider = new Map()
  for (const a of accounts) {
    if (!byProvider.has(a.provider)) byProvider.set(a.provider, [])
    byProvider.get(a.provider).push(a)
  }

  return Object.entries(CHANNELS).map(([id, ch]) => {
    const guide = LOGIN_GUIDES[ch.login] || LOGIN_GUIDES[LOGIN.NONE]
    const mine = byProvider.get(id) || []
    return {
      id,
      label: ch.label,
      login: ch.login,
      guideKind: guide.kind,
      guideTitle: guide.title,
      guideSteps: guide.steps,
      field: guide.field,
      loginUrl: loginUrlOf(id),
      loginWarn: guide.warn ?? null,
      checkin: ch.checkin?.supported === true,
      refresh: ch.refresh,
      note: ch.note ?? null,
      proxyRequired: ch.proxyRequired === true,
      // 已登录账号（掩码）
      accounts: mine.map((a) => ({ id: a.id, label: a.label, masked: a.masked, addedAt: a.addedAt, expiresAt: a.expiresAt })),
      loggedIn: mine.length > 0,
    }
  })
}
