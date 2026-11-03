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
  SIGNED_HUAWEI: 'signed-huawei', // 华为云 SDK-HMAC-SHA256（AK/SK/securityToken 签名）
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
    // 🔴 旧值 agentarts.cn-southwest-2 是 officeace（华为 MaaS）的网关 ⇒ codearts 用它必然 404
    baseUrl: 'https://snap-access.cn-north-4.myhuaweicloud.com',
    chatPath: '/api/v2/chat/completions',
    auth: AUTH.SIGNED_HUAWEI,               // SDK-HMAC-SHA256（AK/SK 签名，不是 Bearer）
    agentType: 'PromptCenter',              // 模型清单端点要求的头
    modelsExtraHeaders: { 'Agent-Type': 'PromptCenter', 'X-Language': 'zh-cn' }, // 只发送、不参与签名
    maxOutputTokens: 65_536,                // 实测 131072 会被上游拒/空流
    bodyExtra: { include: ['reasoning.encrypted_content'], reasoning_summary: 'auto', tool_stream: true },
    login: LOGIN.BROWSER_CALLBACK,
    refresh: REFRESH.AUTO,
    checkin: { supported: true, gain: '+1000/日' },
    credRef: 'CODEARTS_TOKEN',
    loginPage: 'https://devcloud.cn-north-4.huaweicloud.com/codearts/home',
  },
  buddy: {
    label: 'CodeBuddy（腾讯）',
    family: 'openai',
    // 🔴 真实端点：copilot.tencent.com/v2/chat/completions（不是 api.lkeap 那套产品）
    //    实测：用 lkeap + Bearer 会 401 not_authorized（用户真实报错）
    baseUrl: 'https://copilot.tencent.com',
    chatPath: '/v2/chat/completions',
    auth: AUTH.BEARER,
    // 准入必需头（缺则 401 not_authorized / 400 request illegal）
    staticHeaders: {
      'X-Domain': 'copilot.tencent.com',
      'X-Product-Code': 'codebuddy',
      'X-Product': 'SaaS',
      'X-Agent-Purpose': 'conversation',
      'X-IDE-Name': 'SaaS',
      'X-IDE-Type': 'SaaS',
      'X-IDE-Version': '1.106.1',
      'User-Agent': 'CodeBuddyIDE/1.106.1',
    },
    dynamicHeaders: 'conversation',
    login: LOGIN.BROWSER_CALLBACK,
    refresh: REFRESH.AUTO,
    checkin: { supported: true, gain: '+100/日' },
    credRef: 'BUDDY_TOKEN',
    loginPage: 'https://www.codebuddy.cn',
    maxOutputTokens: 32_000,
  },
  workbuddy: {
    label: 'WorkBuddy（国际）',
    family: 'openai',
    // 🔴 旧值 api.workbuddy.ai 是 NXDOMAIN（实测 getent hosts 为空），真实入口如下
    baseUrl: 'https://www.workbuddy.ai',
    chatPath: '/v2/chat/completions',
    auth: AUTH.BEARER,
    // 准入必需头（与 buddy 同族，产品码/版本不同）
    staticHeaders: {
      'X-Domain': 'www.workbuddy.ai',
      'X-Product-Code': 'workbuddy-ai',
      'X-Product': 'SaaS',
      'X-Agent-Purpose': 'conversation',
      'X-IDE-Name': 'SaaS',
      'X-IDE-Type': 'SaaS',
      'X-IDE-Version': '5.5.2',
      'User-Agent': 'CodeBuddyIDE/5.5.2',
    },
    dynamicHeaders: 'conversation',
    login: LOGIN.BROWSER_CALLBACK,
    refresh: REFRESH.AUTO,
    checkin: { supported: false },
    credRef: 'WORKBUDDY_TOKEN',
    loginPage: 'https://www.workbuddy.ai',
    maxOutputTokens: 32_000,
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
    loginPage: 'https://lobsterai.youdao.com',
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
    loginPage: 'https://qoder.sh',
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
    loginPage: 'https://qoder.sh',
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
    loginPage: 'https://www.trae.ai',
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
    loginPage: 'https://app.cline.bot',
  },
  loomy: {
    label: 'Loomy（讯飞）',
    family: 'openai',
    baseUrl: 'https://loomyad.xunfei.cn/api/v1',
    chatPath: '/chat/completions',           // baseUrl 已含 /api/v1（否则 /api/v1/v1 实测 404）
    // chat 端点只认 Bearer；HMAC-SHA1 的 `account ak:sig` 只用于积分/账号端点
    auth: AUTH.BEARER,
    login: LOGIN.QR_WECHAT,
    loginFallback: LOGIN.SMS,
    refresh: REFRESH.MANUAL,                // 无续期端点，14 天人工重登
    sessionTtlSeconds: 1_209_600,
    checkin: { supported: true, endpoint: 'POST /points/first-login', note: '每日池不结转、不回补' },
    credRef: 'LOOMY_ACCESS_TOKEN',
    loginPage: 'https://loomy.xunfei.cn',
    accountBase: 'https://account.xfinfr.com',
  },
  raccoon: {
    label: 'Raccoon（商汤）',
    family: 'openai',
    // 🔴 旧值 api.raccoon.sensetime.com 是 NXDOMAIN，真实入口如下
    baseUrl: 'https://xiaohuanxiong.com',
    chatPath: '/api/web/llm/v2/chat/completions',
    auth: AUTH.BEARER,
    login: LOGIN.QR_WECHAT,
    loginFallback: LOGIN.SMS,
    refresh: REFRESH.AUTO,
    checkin: { supported: false },
    credRef: 'RACCOON_TOKEN',
    loginPage: 'https://www.sensetime.com',
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
    loginPage: 'https://agent.minimax.cn',
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
    loginPage: 'https://agent.minimax.io',
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
    loginPage: 'https://z.ai',
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
    loginPage: 'https://opencode.ai',
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
    loginPage: 'https://aistudio.google.com/apikey',
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
    loginPage: 'https://auth.huaweicloud.com/authui/login',
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
    loginPage: 'https://accio.alibaba.com',
    note: '图片通路原生收图；multimodal:false 模型会静默忽略图片',
  },
  qiniu: {
    label: 'Qiniu（七牛）',
    family: 'openai',
    baseUrl: 'https://openai.qiniu.com/v1',
    chatPath: '/chat/completions',           // baseUrl 已含 /v1（否则 /v1/v1 实测 404）
    auth: AUTH.BEARER,
    login: LOGIN.PASTE_KEY,
    refresh: REFRESH.NONE,
    checkin: { supported: false },
    credRef: 'QINIU_API_KEY',
    loginPage: 'https://portal.qiniu.com/developer/user/key',
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
