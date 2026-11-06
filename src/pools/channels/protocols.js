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
 * 渠道元数据（并发上限 + 成本属性）—— 契约 §5。
 *
 * `billing` 的**唯一事实来源**是 `audit/pricing.js`：
 *   · `CHANNEL_FREE` / `FREE_PROVIDERS` 命中的渠道 ⇒ free（登录即用，不额外扣费）
 *   · 推不出的 ⇒ free + billingSource:'default'（保守：不把未知当付费，也不猜厂商计价）
 * `billingSource`：measured（实测过并发/计费）/ declared（pricing.js 已声明）/ default（未知）。
 * `concurrencyLimit`：默认 1（保守串行）——直连同一上游的多个请求很容易互相打满。
 */

/**
 * 18 个渠道的协议描述。
 * ⚠️ 刻意不含任何 token/key —— 凭据一律运行时从宿主凭据库按 ref 取。
 */
export const CHANNELS = Object.freeze({
  codearts: {
    // 并发上限：上游按会话计数且断开后名额不立刻归还（实测 ~10s），本地严格串行
    concurrencyLimit: 1, limitSource: 'measured',
    billing: 'free', billingSource: 'declared',
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
    // 并发上限：实测可用并发 2
    concurrencyLimit: 2, limitSource: 'measured',
    billing: 'free', billingSource: 'declared',
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
    // 并发上限：与 buddy 同族，实测可用并发 2
    concurrencyLimit: 2, limitSource: 'measured',
    billing: 'free', billingSource: 'declared',
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
    // 并发上限：未实测 ⇒ 保守取 1
    concurrencyLimit: 1, limitSource: 'default',
    billing: 'free', billingSource: 'declared',
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
    // 并发上限：实测可用并发 2
    concurrencyLimit: 2, limitSource: 'measured',
    billing: 'free', billingSource: 'declared',
    label: 'Qoder',
    family: 'openai',
    // 🔴 真实端点：qoder.com/model/v1/chat/completions（实测 400=端点存在）
    //    旧值 api2.qoder.sh 实测 404（MODEL_NOT_FOUND 的真正原因）
    baseUrl: 'https://qoder.com',
    chatPath: '/model/v1/chat/completions',
    auth: AUTH.BEARER,
    login: LOGIN.DEVICE_CODE,
    refresh: REFRESH.AUTO,
    checkin: { supported: true, note: '每日 10:00 (UTC+8) 刷新' },
    credRef: 'QODER_TOKEN',
    loginPage: 'https://qoder.com',
  },
  qodercn: {
    // 并发上限：未实测 ⇒ 保守取 1
    concurrencyLimit: 1, limitSource: 'default',
    billing: 'free', billingSource: 'declared',
    label: 'Qoder 中国版',
    family: 'openai',
    baseUrl: 'https://qoder.cn',
    chatPath: '/model/v1/chat/completions',
    auth: AUTH.BEARER,
    login: LOGIN.DEVICE_CODE,
    refresh: REFRESH.AUTO,
    checkin: { supported: true, note: '每日 10:00 (UTC+8) 刷新' },
    credRef: 'QODERCN_TOKEN',
    loginPage: 'https://qoder.cn',
  },
  trae: {
    // 并发上限：未实测 ⇒ 保守取 1
    concurrencyLimit: 1, limitSource: 'default',
    billing: 'free', billingSource: 'declared',
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
    // 并发上限：实测可用并发 2
    concurrencyLimit: 2, limitSource: 'measured',
    billing: 'free', billingSource: 'declared',
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
    // 并发上限：实测可用并发 2
    concurrencyLimit: 2, limitSource: 'measured',
    billing: 'free', billingSource: 'declared',
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
    // 并发上限：未实测 ⇒ 保守取 1
    concurrencyLimit: 1, limitSource: 'default',
    billing: 'free', billingSource: 'declared',
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
    // 并发上限：实测可用并发 2
    concurrencyLimit: 2, limitSource: 'measured',
    billing: 'free', billingSource: 'declared',
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
    // 并发上限：未实测 ⇒ 保守取 1
    concurrencyLimit: 1, limitSource: 'default',
    billing: 'free', billingSource: 'declared',
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
    // 并发上限：未实测 ⇒ 保守取 1
    concurrencyLimit: 1, limitSource: 'default',
    billing: 'free', billingSource: 'declared',
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
    // 并发上限：未实测 ⇒ 保守取 1
    concurrencyLimit: 1, limitSource: 'default',
    billing: 'free', billingSource: 'default', // ⚠️ pricing.js 只声明了同族的 'opencode-text'；免费层当前被上游关闭 ⇒ 按 free 声明
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
    // 并发上限：未实测 ⇒ 保守取 1
    concurrencyLimit: 1, limitSource: 'default',
    billing: 'free', billingSource: 'declared',
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
    // 并发上限：未实测 ⇒ 保守取 1
    concurrencyLimit: 1, limitSource: 'default',
    billing: 'free', billingSource: 'declared',
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
    // 并发上限：未实测 ⇒ 保守取 1
    concurrencyLimit: 1, limitSource: 'default',
    billing: 'free', billingSource: 'declared',
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
    // 并发上限：未实测 ⇒ 保守取 1
    concurrencyLimit: 1, limitSource: 'default',
    billing: 'free', billingSource: 'declared',
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

  // ══════════════════════════════════════════════════════════════════════════
  // 自加 API（用户口径：「供给页面给个选项，我只粘贴 API 就行了」）
  //
  // 与其它渠道的区别：**不需要浏览器登录、不需要抓 cookie**，用户把 API Key
  // 粘贴进供给源页面即可。走 LOGIN.PASTE_KEY ⇒ 页面自动出现「粘贴凭据」表单
  // （与 qiniu 同一条路径，零新增 UI 代码）。
  //
  // 🔴 为什么不新建一套「自定义渠道」UI：那要另造存储/渲染/校验三套东西，
  //    而 paste-key 流程已经跑通，复用最省且最不容易出错。
  // ══════════════════════════════════════════════════════════════════════════
  ark: {
    // 火山方舟：并发上限保守取 2（未实测多账号并发）
    concurrencyLimit: 2, limitSource: 'default',
    billing: 'paid', billingSource: 'declared',
    label: '火山方舟（ARK）',
    family: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    chatPath: '/chat/completions',
    auth: AUTH.BEARER,
    login: LOGIN.PASTE_KEY,
    refresh: REFRESH.NONE,
    checkin: { supported: false },
    credRef: 'ARK_API_KEY',
    loginPage: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    note: '火山方舟：粘贴 API Key 即可用；模型以控制台「在线推理」里开通的为准',
  },
  'deepseek-web': {
    // DeepSeek 网页版（chat.deepseek.com）：**不消耗 API token**，走网页会话。
    //
    // 🔴 关键限制（实测/社区已知，页面必须如实告知用户）：
    //   1. 网页版没有原生 function calling ⇒ 工具调用是「提示词模拟」，不稳定
    //   2. 同一账号同一时刻**只允许一路流式请求** ⇒ 并发上限必须为 1
    //   3. 自动化驱动网页会话可能触发平台风控 ⇒ 建议只用于轻量日常对话
    concurrencyLimit: 1, limitSource: 'measured',
    billing: 'free', billingSource: 'declared',
    label: 'DeepSeek 网页版（自带账号）',
    family: 'openai',
    baseUrl: 'https://chat.deepseek.com',
    chatPath: '/api/v0/chat/completions',
    auth: AUTH.BEARER,
    login: LOGIN.PASTE_KEY,
    refresh: REFRESH.NONE,
    checkin: { supported: false },
    credRef: 'DEEPSEEK_WEB_TOKEN',
    loginPage: 'https://chat.deepseek.com',
    note: '网页版免费额度：同一账号同时只能一路对话；工具调用为模拟实现，仅供日常轻量聊天',
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
