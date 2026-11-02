/**
 * cs-myfree — 渠道协议注册表（**声明式数据，不含凭据**）
 *
 * 设计依据：v3 §4。目标 = 「ourfree + dsh-providers-hub 的全部渠道能力」，
 * 但**不照搬 15MB 代码**，而是把每家协议提炼成声明式数据：
 *   · 端点、鉴权方式、请求形状、签到接口、续期能力
 *   · 通用驱动按 family 处理，新增渠道只需加一条数据
 *
 * 端点均来自本机已安装的渠道包对拍（dsh-codearts-auth@1.10.261021）。
 *
 * @module cs-myfree/pools/channels/protocols
 */

/** 鉴权方式 */
export const AUTH = Object.freeze({
  BEARER: 'bearer',            // Authorization: Bearer <token>
  CUSTOM_HEADER: 'custom',     // 自定义头（如 Authorization: account ak:sig）
  COOKIE: 'cookie',            // Cookie
  API_KEY: 'api-key',          // x-api-key 之类
  NONE: 'none',                // 免密
})

/** 登录方式 */
export const LOGIN = Object.freeze({
  BROWSER_CALLBACK: 'browser-callback',   // 浏览器授权后回调本地端口
  DEVICE_CODE: 'device-code',             // 设备码轮询
  SMS: 'sms',                             // 短信验证码
  QR_WECHAT: 'qr-wechat',                 // 微信扫码
  OAUTH_PKCE: 'oauth-pkce',                // OAuth 设备码 + PKCE
  PASTE_KEY: 'paste-key',                 // 粘贴 API Key
  NONE: 'none',
})

/** 续期能力 */
export const REFRESH = Object.freeze({
  AUTO: 'auto',        // 有 refresh token，可静默续期
  MANUAL: 'manual',    // 无续期端点，到期须人工重登
  NONE: 'none',
})

/**
 * 18 个渠道的协议描述。
 * ⚠️ 刻意不含任何 token/key —— 凭据一律运行时从宿主凭据库按 ref 取。
 */
export const CHANNELS = Object.freeze({
  codearts: {
    label: 'CodeArts（华为云）',
    family: 'openai',                       // 请求/响应形状
    baseUrl: 'https://agentarts.cn-southwest-2.myhuaweicloud.com',
    auth: AUTH.CUSTOM_HEADER,
    login: LOGIN.BROWSER_CALLBACK,
    refresh: REFRESH.AUTO,
    checkin: { supported: true, gain: '+1000/日' },
    credRef: 'CODEARTS_TOKEN',
  },
  buddy: {
    label: 'CodeBuddy（腾讯）',
    family: 'openai',
    baseUrl: 'https://api.lkeap.cloud.tencent.com/v1',
    auth: AUTH.BEARER,
    login: LOGIN.BROWSER_CALLBACK,
    refresh: REFRESH.AUTO,
    checkin: { supported: true, gain: '+100/日' },
    credRef: 'BUDDY_TOKEN',
  },
  workbuddy: {
    label: 'WorkBuddy（国际）',
    family: 'openai',
    baseUrl: 'https://api.workbuddy.ai/v1',
    auth: AUTH.BEARER,
    login: LOGIN.BROWSER_CALLBACK,
    refresh: REFRESH.AUTO,
    checkin: { supported: false },
    credRef: 'WORKBUDDY_TOKEN',
  },
  lobsterai: {
    label: 'LobsterAI（有道）',
    family: 'openai',
    baseUrl: 'https://api-overmind.youdao.com/openapi',
    auth: AUTH.BEARER,
    login: LOGIN.BROWSER_CALLBACK,
    refresh: REFRESH.AUTO,
    checkin: { supported: true },
    credRef: 'LOBSTERAI_TOKEN',
  },
  qoder: {
    label: 'Qoder',
    family: 'openai',
    baseUrl: 'https://api2.qoder.sh',
    auth: AUTH.BEARER,
    login: LOGIN.DEVICE_CODE,
    refresh: REFRESH.AUTO,
    checkin: { supported: true, note: '每日 10:00 (UTC+8) 刷新' },
    credRef: 'QODER_TOKEN',
  },
  qodercn: {
    label: 'Qoder 中国版',
    family: 'openai',
    baseUrl: 'https://api2-v2.qoder.sh',
    auth: AUTH.BEARER,
    login: LOGIN.DEVICE_CODE,
    refresh: REFRESH.AUTO,
    checkin: { supported: true, note: '每日 10:00 (UTC+8) 刷新' },
    credRef: 'QODERCN_TOKEN',
  },
  trae: {
    label: 'TRAE（字节）',
    family: 'openai',
    baseUrl: 'https://api.trae.cn',
    auth: AUTH.BEARER,
    login: LOGIN.BROWSER_CALLBACK,
    refresh: REFRESH.AUTO,
    checkin: { supported: true },
    credRef: 'TRAE_TOKEN',
    note: '单次输出上限默认 64000',
  },
  cline: {
    label: 'Cline',
    family: 'openai',
    baseUrl: 'https://api.cline.bot',
    auth: AUTH.BEARER,
    login: LOGIN.DEVICE_CODE,
    refresh: REFRESH.AUTO,
    checkin: { supported: false, note: '源码明确无签到接口' },
    credRef: 'CLINE_TOKEN',
  },
  loomy: {
    label: 'Loomy（讯飞）',
    family: 'openai',
    baseUrl: 'https://loomyad.xunfei.cn/api/v1',
    auth: AUTH.CUSTOM_HEADER,               // Authorization: account ak:sig (HMAC-SHA1)
    authHeaderFormat: 'account {ak}:{sig}',
    login: LOGIN.QR_WECHAT,
    loginFallback: LOGIN.SMS,
    refresh: REFRESH.MANUAL,                // 无续期端点，14 天人工重登
    sessionTtlSeconds: 1_209_600,
    checkin: { supported: true, endpoint: 'POST /points/first-login', note: '每日池不结转、不回补' },
    credRef: 'LOOMY_ACCESS_TOKEN',
    accountBase: 'https://account.xfinfr.com',
  },
  raccoon: {
    label: 'Raccoon（商汤）',
    family: 'openai',
    baseUrl: 'https://api.raccoon.sensetime.com/v1',
    auth: AUTH.BEARER,
    login: LOGIN.QR_WECHAT,
    loginFallback: LOGIN.SMS,
    refresh: REFRESH.AUTO,
    checkin: { supported: false },
    credRef: 'RACCOON_TOKEN',
  },
  minimax: {
    label: 'MiniMax Code',
    family: 'openai',
    baseUrl: 'https://agent.minimax.cn',
    auth: AUTH.BEARER,
    login: LOGIN.OAUTH_PKCE,
    refresh: REFRESH.AUTO,
    checkin: { supported: true },
    credRef: 'MINIMAX_TOKEN',
    accountBase: 'https://account.minimax.cn',
  },
  minimaxintl: {
    label: 'MiniMax 国际',
    family: 'openai',
    baseUrl: 'https://agent.minimax.io',
    auth: AUTH.BEARER,
    login: LOGIN.OAUTH_PKCE,
    refresh: REFRESH.AUTO,
    checkin: { supported: true },
    credRef: 'MINIMAXINTL_TOKEN',
    accountBase: 'https://account.minimax.io',
  },
  zcode: {
    label: 'ZCode（智谱）',
    family: 'openai',
    baseUrl: 'https://api.z.ai/api',
    auth: AUTH.BEARER,
    login: LOGIN.DEVICE_CODE,
    refresh: REFRESH.AUTO,
    checkin: { supported: true, note: '含营销活动投放；领取需一次性验证参数' },
    credRef: 'ZCODE_TOKEN',
    versionGate: { minAppVersion: '3.16.3' },
  },
  opencode: {
    label: 'OpenCode',
    family: 'openai',
    baseUrl: 'https://opencode.ai/api',
    auth: AUTH.BEARER,
    login: LOGIN.NONE,
    refresh: REFRESH.NONE,
    checkin: { supported: false },
    credRef: 'OPENCODE_API_KEY',
    note: '本机实测 403 FreeTierError（免费层被上游关闭）',
  },
  gemini: {
    label: 'Gemini Code Assist',
    family: 'openai',
    baseUrl: 'https://cloudcode-pa.googleapis.com',
    auth: AUTH.BEARER,
    login: LOGIN.BROWSER_CALLBACK,
    refresh: REFRESH.AUTO,
    checkin: { supported: false },
    credRef: 'GEMINI_ACCESS_TOKEN',
    note: '本机实测链路层封锁（TCP 不通）；需代理',
    proxyRequired: true,
  },
  officeace: {
    label: 'OfficeAce（华为 MaaS）',
    family: 'openai',
    baseUrl: 'https://api.modelarts-maas.com',
    auth: AUTH.BEARER,
    login: LOGIN.OAUTH_PKCE,
    refresh: REFRESH.AUTO,
    checkin: { supported: true, note: '无手动签到入口，自动领取' },
    credRef: 'OFFICEACE_TOKEN',
    accountBase: 'https://auth.huaweicloud.com/authui',
  },
  accio: {
    label: 'Accio（阿里）',
    family: 'openai',
    baseUrl: 'https://accio.alibaba.com/api',
    auth: AUTH.BEARER,
    login: LOGIN.BROWSER_CALLBACK,
    refresh: REFRESH.AUTO,
    checkin: { supported: false },
    credRef: 'ACCIO_TOKEN',
    note: '图片通路原生收图；multimodal:false 模型会静默忽略图片',
  },
  qiniu: {
    label: 'Qiniu（七牛）',
    family: 'openai',
    baseUrl: 'https://openai.qiniu.com/v1',
    auth: AUTH.BEARER,
    login: LOGIN.PASTE_KEY,
    refresh: REFRESH.NONE,
    checkin: { supported: false },
    credRef: 'QINIU_API_KEY',
  },
})

/** 参与聚合轮换的渠道（有可靠到期信息） */
export const WIRED_EXPIRY = Object.freeze([
  'buddy', 'workbuddy', 'loomy', 'codearts', 'zcode',
  'lobsterai', 'trae', 'accio', 'officeace',
])

export function channelById(id) { return CHANNELS[id] ?? null }
export function allChannelIds() { return Object.keys(CHANNELS) }
export function checkinChannels() { return Object.entries(CHANNELS).filter(([, c]) => c.checkin?.supported).map(([id]) => id) }
export function manualRefreshChannels() { return Object.entries(CHANNELS).filter(([, c]) => c.refresh === REFRESH.MANUAL).map(([id]) => id) }
export function proxyRequiredChannels() { return Object.entries(CHANNELS).filter(([, c]) => c.proxyRequired).map(([id]) => id) }
