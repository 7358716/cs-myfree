/**
 * cs-myfree — Loomy（讯飞办公助手）**微信扫码**登录（真实实现）
 *
 * 协议来源：逐行对拍参考包
 * `/home/ubuntu/plugins/my-free-model/node_modules/dsh-codearts-auth/lib/`
 * 的 `loomy-wechat.js` / `loomy-wechat-login.js` / `loomy-oauth.js` / `loomy-sign.js`
 * 与原始 TS `src-ref/ofm-src/vendor/channel-pack/src/loomy-*.ts`。
 *
 * ## 链路（三段，全部真机可走）
 *
 * ```
 * ① 取二维码
 *    GET https://open.weixin.qq.com/connect/qrconnect?appid=<LOOMY_WECHAT_APP_ID>
 *        &redirect_uri=<官方回调>&response_type=code&scope=snsapi_login&state=…
 *    页面 HTML 里内嵌二维码 uuid（<img class="js_qrcode_img" src="/connect/qrcode/<uuid>">）
 * ② 扫码 + 长轮询
 *    二维码**内容字符串** = https://open.weixin.qq.com/connect/confirm?uuid=<uuid>
 *      （2026-11-03 实测：下载官方二维码 JPEG 并**解码**得到该 URL，不是猜的）
 *    GET https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=<uuid>[&last=<prev>]
 *      408 waiting / 404 scanned / 405 confirmed(带 wx_code) / 403 cancelled / 402 expired
 * ③ code → session（讯飞 CAccount，HMAC-SHA1 签名）
 *    POST {LOOMY_ACCOUNT_BASE}/login/thirdAccount/bind/auth  {tcode:{code},type:'wx'}
 *      → {bind, rcode, nickname}
 *    bind=1（微信已绑讯飞手机号）→ POST …/bind/skip {rcode} → {session, userid}
 *    bind=0（需绑手机号）→ 需要短信验证码，**统一登录契约没有输入框** ⇒ 诚实报错，
 *      不假装成功（见 LOOMY_NEED_PHONE_ERROR）。
 * ```
 *
 * ## 三个必须记住的点
 *
 * 1. **没有 refresh 端点**：`session` 是登录时声明 14 天（`expire: 1209600`）换来的，
 *    过期只能重新扫码。故本模块**不导出任何续期函数**，UI 要如实显示「14 天后重新扫码」。
 * 2. **二维码只回内容字符串**：前端自己渲染（零第三方依赖红线，不引 QR 库、不传图片）。
 * 3. **账号端点签名用 HMAC-SHA1 + `account {ak}:{sig}`**，不是 Bearer：
 *    签名字符串是 9 段 `\n` 连接、**以两个换行结尾**（后两段恒空）。见
 *    {@link buildLoomySigningString}。body 必须**只序列化一次**，签名与发送共用同一字符串。
 *
 * @module cs-myfree/pools/channels/login/loomy
 */

import { createHash, createHmac, randomUUID } from 'node:crypto'

/** 业务端点基址（推理 / 模型 / 积分）。本文件只做登录，不请求它。 */
export const LOOMY_API_BASE = 'https://loomyad.xunfei.cn/api/v1'
/** 讯飞账号（CAccount）基址：扫码确认后的每一跳都打到这里。 */
export const LOOMY_ACCOUNT_BASE = 'https://account.xfinfr.com'
/** 业务成功码（HTTP 恒 200，成败只看 body 的 code）。 */
export const LOOMY_OK_CODE = '000000'
/** 登录失效码：收到它不得重试，应提示重新登录。 */
export const LOOMY_AUTH_ERROR_CODE = '100002'

/** 登录会话有效期（秒）= 14 天（讯飞账号端点 `expire` 参数声明值）。 */
export const LOOMY_SESSION_TTL_SECONDS = 1_209_600

/** 账号请求超时（毫秒）。 */
export const LOOMY_REQUEST_TIMEOUT_MS = 60_000

/** 微信开放平台「网站应用」AppID（同一讯飞客户端分发值）。 */
export const LOOMY_WECHAT_APP_ID = 'wx18d60be432287cf8'
/**
 * 微信授权回调地址。
 *
 * ⚠️ **必须是这个官方地址**：微信校验 `redirect_uri` 域名白名单，换成本地地址
 * 会得到「redirect_uri 参数错误」页。它实测返回 404，但本链路**不需要它可达** ——
 * `code` 是从长轮询拿到的，它只是白名单占位。
 */
export const LOOMY_WECHAT_REDIRECT_URI = 'https://loomy.xunfei.cn/oauth/wechat/callback'

/** 整个扫码流程的超时（毫秒）—— 与统一状态机的会话 TTL（5 分钟）对齐。 */
export const LOOMY_WECHAT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** 微信长轮询单次超时（毫秒）：微信侧约 25 秒无状态变化才返回，给足余量。 */
export const LOOMY_WECHAT_POLL_TIMEOUT_MS = 40_000
/** 轮询间隔（秒）：只是给前端的建议值，实际靠长轮询阻塞。 */
export const LOOMY_POLL_INTERVAL_SECONDS = 2

/** 微信长轮询状态（语义出自微信授权页内嵌 JS 的 `switch(window.wx_errcode)`）。 */
export const LOOMY_WECHAT_POLL_STATUS = Object.freeze({
  /** 408：等待扫码（常态）。 */
  waiting: 'waiting',
  /** 404：已扫码，等待用户在手机上点确认。**继续轮询**。 */
  scanned: 'scanned',
  /** 405：**已确认**，`wx_code` 就在这一帧。 */
  confirmed: 'confirmed',
  /** 403：用户取消。 */
  cancelled: 'cancelled',
  /** 402：二维码失效，需重新获取 uuid。 */
  expired: 'expired',
  /** 网络/解析异常：调用方应继续轮询（瞬时不代表失败）。 */
  error: 'error',
})

/** bind=0（微信未绑讯飞手机号）时的诚实报错文案。 */
export const LOOMY_NEED_PHONE_ERROR
  = '该微信账号尚未绑定讯飞手机号：请在讯飞 App / 官网用手机号登录并完成绑定后，回来重新扫码'
  + '（本插件暂不支持在登录向导里绑定手机号）'

/**
 * Loomy 产品级配置。
 *
 * ⚠️ 这是**厂商随客户端分发的应用级凭据**（只用于 `account.xfinfr.com` 的 HMAC 签名，
 * 不是任何用户数据），与参考包 `loomy-product.ts` 的 `.env.prod` 取值一致。
 * 用户凭据（`session`）只从登录响应拿、只经 poll 的 `credential` 交给状态机，绝不落日志。
 */
export const LOOMY_PRODUCT = Object.freeze({
  accessKeyId: '2thryby66wxi53sk',
  accessKeySecret: 'zsak6eadrbawz683wf5r3m2snrwj868r',
  appId: 'GM3LOOMY',
  accountBase: LOOMY_ACCOUNT_BASE,
})

/** 扫码请求统一带浏览器 UA —— 微信对空 UA / 爬虫 UA 可能拒绝。 */
const WECHAT_UA
  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * 二维码 uuid 字符集。
 *
 * 实测真实 uuid 形如 `041rnolu4TIPkl2B`（15 位）、`4Y0N_jyVQg==`（base64 补位）。
 * 下限取 6 而非更长：微信未承诺长度，收紧只会让格式微调时**静默失效**。
 */
const UUID_PATTERN = /^[A-Za-z0-9_\-=+/]{6,64}$/

// ── 微信扫码：取 uuid / 二维码内容 / 长轮询 ─────────────────────────────

/**
 * 拼微信授权页 URL。
 * @param {string} state 32 位随机串（微信原样回传；本实现不依赖它，仅与官方一致）
 */
export function buildLoomyWechatAuthUrl(state) {
  return 'https://open.weixin.qq.com/connect/qrconnect'
    + `?appid=${encodeURIComponent(LOOMY_WECHAT_APP_ID)}`
    + `&redirect_uri=${encodeURIComponent(LOOMY_WECHAT_REDIRECT_URI)}`
    + '&response_type=code'
    + '&scope=snsapi_login'
    + `&state=${encodeURIComponent(state)}`
    + '#wechat_redirect'
}

/**
 * 从授权页 HTML 提取二维码 uuid（实测页面直接内嵌，无需执行 JS）。
 *
 * 两条路径互为兜底：
 * - `<img class="js_qrcode_img" src="/connect/qrcode/<uuid>"/>`（主路径）
 * - `var fordevtool = "…/connect/l/qrconnect?uuid=<uuid>"`（兜底）
 *
 * @returns 提取不到时返回**空串**（由调用方决定是否抛错）。
 */
export function extractLoomyWechatUuid(html) {
  if (typeof html !== 'string' || html.length === 0) return ''
  const fromImg = html.match(/\/connect\/qrcode\/([A-Za-z0-9_\-=+/]+)/)
  if (fromImg !== null) {
    const candidate = String(fromImg[1] ?? '')
    if (UUID_PATTERN.test(candidate)) return candidate
  }
  const fromPoll = html.match(/l\/qrconnect\?uuid=([A-Za-z0-9_\-=+/]+)/)
  if (fromPoll !== null) {
    const candidate = String(fromPoll[1] ?? '')
    if (UUID_PATTERN.test(candidate)) return candidate
  }
  return ''
}

/**
 * 二维码**内容字符串**（前端据此自己渲染二维码）。
 *
 * 取证：2026-11-03 下载官方 `https://open.weixin.qq.com/connect/qrcode/<uuid>` 的
 * 真实二维码图片并解码，内容即本函数返回的 URL（含 `uuid=` 原值）。
 */
export function buildLoomyWechatQrContent(uuid) {
  return `https://open.weixin.qq.com/connect/confirm?uuid=${encodeURIComponent(uuid)}`
}

/**
 * 解析一次长轮询的响应体。
 *
 * ⚠️ 语义以微信授权页内嵌 JS 为准（官方源码，不是推测）：
 * 408 待扫码 / 404 已扫码待确认（**继续轮询**）/ 405 已确认（code 在这一帧）
 * / 403 取消 / 402 失效。
 *
 * ⚠️ 405 但 `wx_code` 为空**不判成功**（保守判 scanned）：绝不拿空 code 去换 session。
 */
export function parseLoomyWechatPollBody(body) {
  const text = typeof body === 'string' ? body : ''
  const errcode = (text.match(/wx_errcode\s*=\s*(\d+)/) ?? [])[1] ?? ''
  const code = (text.match(/wx_code\s*=\s*'([^']*)'/) ?? [])[1] ?? ''
  const S = LOOMY_WECHAT_POLL_STATUS
  if (errcode === '405') {
    return code.length > 0
      ? { status: S.confirmed, code, errcode }
      : { status: S.scanned, code: '', errcode }
  }
  if (errcode === '404') return { status: S.scanned, code: '', errcode }
  if (errcode === '403') return { status: S.cancelled, code: '', errcode }
  if (errcode === '402') return { status: S.expired, code: '', errcode }
  // 408 与未知值一律归 waiting（保守：绝不误判成功）
  return { status: S.waiting, code: '', errcode }
}

/**
 * 拉取授权页并提取 uuid。
 * @throws 页面拉取失败或提取不到 uuid（消息可读，不含任何凭据）。
 */
export async function fetchLoomyWechatUuid(state, fetcher = globalThis.fetch) {
  const authUrl = buildLoomyWechatAuthUrl(state)
  let response
  try {
    response = await fetcher(authUrl, {
      headers: { 'User-Agent': WECHAT_UA, Referer: 'https://open.weixin.qq.com/' },
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new Error(`微信授权页拉取失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`微信授权页返回 HTTP ${response.status}`)
  const html = await response.text()
  const uuid = extractLoomyWechatUuid(html)
  if (uuid.length === 0) throw new Error('微信授权页未包含二维码 uuid（页面结构可能已变化）')
  return uuid
}

/**
 * 执行**一次**微信长轮询。
 *
 * 网络异常返回 `error` 状态而**不抛错**：长轮询偶发失败不该终止整个流程，
 * 由调用方决定是否继续等。
 */
export async function pollLoomyWechatOnce(uuid, lastErrcode, fetcher = globalThis.fetch) {
  const query = `uuid=${encodeURIComponent(uuid)}`
    + (lastErrcode ? `&last=${encodeURIComponent(lastErrcode)}` : '')
    + `&_=${Date.now()}`
  const url = `https://long.open.weixin.qq.com/connect/l/qrconnect?${query}`
  let body
  try {
    const response = await fetcher(url, {
      headers: { 'User-Agent': WECHAT_UA, Referer: buildLoomyWechatAuthUrl('') },
      signal: AbortSignal.timeout(LOOMY_WECHAT_POLL_TIMEOUT_MS),
    })
    body = await response.text()
  } catch (error) {
    return {
      status: LOOMY_WECHAT_POLL_STATUS.error,
      code: '',
      errcode: error instanceof Error ? error.message : 'network',
    }
  }
  return parseLoomyWechatPollBody(body)
}

// ── 讯飞账号（CAccount）HMAC-SHA1 签名 ────────────────────────────────

/** RFC3986 转义（`encodeURIComponent` 再补转 `! ' ( ) *`）。 */
function escapeRfc3986(value) {
  return encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
}

/**
 * 计算 `Content-MD5`（base64）。空 body 返回**空串**（不是空串的 md5）。
 */
export function loomyContentMd5(body) {
  const text = typeof body === 'string' ? body : ''
  if (text.length === 0) return ''
  return createHash('md5').update(text, 'utf8').digest('base64')
}

/** 构建 ESCAPED_PATH：补前导 `/`、剥末尾 `/`（长度 > 1 时）、逐段转义。 */
function buildEscapedPath(rawPath) {
  let clean = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  if (clean.length > 1 && clean.endsWith('/')) clean = clean.slice(0, -1)
  return clean.split('/').map((seg) => (seg.length > 0 ? escapeRfc3986(seg) : '')).join('/')
}

/** 构建 ESCAPED_QUERY：`key=value` 用 `&` 连接，**不排序**，两者都转义。 */
function buildEscapedQueryString(queryParams) {
  if (queryParams === undefined || queryParams === null) return ''
  const entries = Object.entries(queryParams)
  if (entries.length === 0) return ''
  return entries
    .map(([key, value]) => `${escapeRfc3986(key)}=${value === null || value === undefined ? '' : escapeRfc3986(String(value))}`)
    .join('&')
}

/**
 * 构建待签名字符串（**纯函数**，`date`/`nonce` 由调用方传入，便于固定向量单测）。
 *
 * 9 段 `\n` 连接：
 * `{METHOD}\n{ESCAPED_PATH}\n{ESCAPED_QUERY}\n{Content-MD5}\n{Content-Type}\n{Date}\n{Nonce}\n{SignedHeaders}\n{CanonicalizedHeaders}`
 *
 * ⚠️ 后两段恒为空串 ⇒ 最终字符串**以两个换行结尾**。不要「顺手」去掉尾随换行。
 */
export function buildLoomySigningString(options) {
  const opts = options ?? {}
  const method = String(opts.method ?? 'GET').toUpperCase()
  const escapedPath = buildEscapedPath(String(opts.path ?? '/'))
  const escapedQuery = buildEscapedQueryString(opts.queryParams)
  const body = typeof opts.body === 'string' ? opts.body : ''
  const md5 = loomyContentMd5(body)
  const contentType = typeof opts.contentType === 'string' ? opts.contentType : ''
  return [
    method,
    escapedPath,
    escapedQuery,
    md5,
    contentType,
    String(opts.date ?? ''),
    String(opts.nonce ?? ''),
    '',
    '',
  ].join('\n')
}

/**
 * 生成讯飞账号请求头。
 *
 * ⚠️ 返回的 body 必须与签名时的 `options.body` 是**同一个字符串**（调用方先
 * `JSON.stringify` 一次，签名与发送共用）——二次序列化会改变字节导致签名失效。
 */
export function loomyAuthHeaders(options) {
  const opts = options ?? {}
  const date = new Date().toUTCString()
  const nonce = randomUUID()
  const contentType = typeof opts.contentType === 'string' ? opts.contentType : 'application/json'
  const body = typeof opts.body === 'string' ? opts.body : ''
  const stringToSign = buildLoomySigningString({ ...opts, contentType, body, date, nonce })
  const signature = createHmac('sha1', String(opts.accessKeySecret ?? ''))
    .update(stringToSign, 'utf8')
    .digest('base64')
  const headers = {
    Authorization: `account ${String(opts.accessKeyId ?? '')}:${signature}`,
    Date: date,
    Nonce: nonce,
    'Content-Type': contentType,
  }
  const md5 = loomyContentMd5(body)
  if (md5.length > 0) headers['Content-MD5'] = md5
  return headers
}

// ── 讯飞账号请求：信封 / 登录响应 ─────────────────────────────────────

/**
 * 账号端点请求体信封 `{ base, param }`。
 *
 * ⚠️ `ua` 硬编码 macOS：客户端在 Windows 上发的也是这个值，照抄不要改。
 */
export function buildLoomyAccountBody(product, param) {
  const p = product ?? LOOMY_PRODUCT
  return {
    base: {
      appid: p.appId,
      modelid: 'Web',
      version: '1.0.0',
      devid: 'web',
      ua: 'Loomy|Desktop|Electron|macOS',
      traceid: randomUUID().replace(/-/g, ''),
    },
    param: param ?? {},
  }
}

/**
 * 解析 Loomy 业务信封。
 * ⚠️ 业务失败**恒返回 HTTP 200**，成败只能读 body 的 `code`。
 */
export function parseLoomyEnvelope(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, code: '', message: '响应不是 JSON 对象', data: undefined }
  }
  const record = payload
  const code = typeof record.code === 'string' ? record.code : ''
  const message = typeof record.desc === 'string' && record.desc.length > 0
    ? record.desc
    : (typeof record.message === 'string' ? record.message : '')
  if (code !== LOOMY_OK_CODE) {
    return {
      ok: false,
      code,
      message: message.length > 0 ? message : `业务错误 ${code || '(缺少 code)'}`,
      data: undefined,
    }
  }
  return { ok: true, code, message, data: record.data }
}

/**
 * 解析登录响应 `{ session, userid, phone? }`。
 *
 * ⚠️ `session` 是**用户凭据**：只允许经 poll 的 `credential` 交给状态机，
 * 绝不写日志、绝不进 HTTP 响应。
 *
 * @throws 缺 session / 缺 userid。
 */
export function parseLoomyLoginData(data) {
  const record = (data ?? {})
  const session = typeof record.session === 'string' ? record.session : ''
  const userid = typeof record.userid === 'string' ? record.userid : ''
  const phone = typeof record.phone === 'string' ? record.phone : ''
  if (session.length === 0) throw new Error('讯飞登录响应缺少 session')
  if (userid.length === 0) throw new Error('讯飞登录响应缺少 userid')
  return { session, userid, ...(phone.length > 0 ? { phone } : {}) }
}

/** 账号掩码（只给 UI 看；不泄漏完整 userid）。 */
export function maskLoomyAccount(value) {
  const s = String(value ?? '')
  if (s.length === 0) return null
  if (s.length <= 4) return '****'
  return `${s.slice(0, 3)}****${s.slice(-2)}`
}

/**
 * 发一次账号端点请求并拆信封。
 * @throws 网络失败 / 非 JSON / 业务码非 000000（透传服务端 desc，便于区分「验证码错误」等）。
 */
export async function postLoomyAccount(path, body, product, fetcher = globalThis.fetch) {
  const p = product ?? LOOMY_PRODUCT
  const accountBase = String(p.accountBase ?? LOOMY_ACCOUNT_BASE)
  // 🔴 只序列化一次：签名与发送共用同一字符串
  const serialized = JSON.stringify(body)
  const headers = loomyAuthHeaders({
    accessKeyId: p.accessKeyId,
    accessKeySecret: p.accessKeySecret,
    method: 'POST',
    path,
    body: serialized,
    contentType: 'application/json',
  })
  let response
  try {
    response = await fetcher(`${accountBase}${path}`, {
      method: 'POST',
      headers,
      body: serialized,
      signal: AbortSignal.timeout(LOOMY_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`讯飞账号请求失败（${path}）：${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`讯飞账号响应不是 JSON（${path}，HTTP ${response.status}）`)
  }
  const envelope = parseLoomyEnvelope(parsed)
  if (!envelope.ok) {
    throw new Error(envelope.message.length > 0 ? envelope.message : `讯飞账号请求失败（${path}）`)
  }
  return envelope.data
}

/** 第 1 步：微信 code → `{ bind, rcode, nickname }`（bind=0 表示需绑手机号）。 */
export async function bindLoomyThirdAccount(code, product, fetcher = globalThis.fetch) {
  const body = buildLoomyAccountBody(product, { tcode: { code: String(code) }, type: 'wx' })
  const data = await postLoomyAccount('/login/thirdAccount/bind/auth', body, product, fetcher)
  const record = (data ?? {})
  const rcode = typeof record.rcode === 'string' ? record.rcode : ''
  if (rcode.length === 0) throw new Error('微信授权响应缺少 rcode')
  // ⚠️ bind 缺失时归 0（保守方向）：宁可让用户多绑一次，也不跳过绑定拿到没手机号的账号。
  const bind = record.bind === 1 ? 1 : 0
  return {
    bind,
    rcode,
    ...(typeof record.nickname === 'string' && record.nickname.length > 0 ? { nickname: record.nickname } : {}),
    ...(typeof record.isnew === 'number' ? { isnew: record.isnew } : {}),
  }
}

/** bind=1 时：跳过绑定，直接换 `{ session, userid }`。 */
export async function bindLoomySkip(rcode, product, fetcher = globalThis.fetch) {
  const body = buildLoomyAccountBody(product, {
    rcode: String(rcode),
    expire: LOOMY_SESSION_TTL_SECONDS,
  })
  const data = await postLoomyAccount('/login/thirdAccount/bind/skip', body, product, fetcher)
  return parseLoomyLoginData(data)
}

// ── 统一登录契约：start / poll ────────────────────────────────────────

/**
 * 由 uuid 构造 initial（**纯函数**，便于单测固定形状）。
 */
export function buildLoomyInitial(uuid, nowMs = Date.now()) {
  return {
    flow: 'qr',
    qr: buildLoomyWechatQrContent(uuid),
    interval: LOOMY_POLL_INTERVAL_SECONDS,
    instructions: [
      '用手机微信「扫一扫」扫描下方二维码',
      '扫码后请在手机上点「确认登录」',
      '若提示需绑定手机号：请先在讯飞 App 完成手机号绑定，再回来重新扫码',
      '登录凭证 14 天有效（讯飞没有续期接口），到期需重新扫码',
    ],
    _uuid: String(uuid),
    _lastErrcode: '',
    _startedAt: nowMs,
  }
}

/**
 * start：先向微信取一个二维码 uuid（**一次 HTTP**），再返回二维码内容字符串。
 *
 * ⚠️ 本函数是 async —— 统一状态机 `startLogin` 已 `await flow.initial(...)`（2026-11-03 起）。
 */
export async function startLoomy(provider, ch, opts = {}) {
  const fetcher = opts.fetchImpl ?? globalThis.fetch
  const uuid = await fetchLoomyWechatUuid(randomUUID().replace(/-/g, ''), fetcher)
  return buildLoomyInitial(uuid)
}

/**
 * poll：每次调用执行**一次**微信长轮询（可能阻塞 ~25-40 秒），状态推进：
 * pending（待扫码）→ waiting（已扫码待确认）→ 确认后换 session → ok。
 *
 * 超时 5 分钟（与会话 TTL 对齐）；`opts.cancel === true` 支持取消。
 */
export async function pollLoomy(session, opts = {}) {
  if (!session || typeof session !== 'object') return { state: 'error', error: '登录会话无效' }
  if (opts.cancel === true) return { state: 'cancelled', hint: '已取消扫码登录' }

  const uuid = String(session._uuid ?? '')
  if (uuid.length === 0) return { state: 'error', error: '登录会话缺少二维码参数，请重新发起' }

  const startedAt = Number.isFinite(session._startedAt) ? session._startedAt : Date.now()
  if (Date.now() - startedAt > LOOMY_WECHAT_LOGIN_TIMEOUT_MS) {
    return { state: 'error', error: '登录超时（5 分钟内未完成扫码），请重新发起' }
  }

  const fetcher = opts.fetchImpl ?? globalThis.fetch
  const product = opts.product ?? LOOMY_PRODUCT

  const polled = await pollLoomyWechatOnce(uuid, String(session._lastErrcode ?? ''), fetcher)
  if (polled.errcode.length > 0) session._lastErrcode = polled.errcode
  const S = LOOMY_WECHAT_POLL_STATUS

  if (polled.status === S.waiting) return { state: 'pending', hint: '等待用手机微信扫码…' }
  if (polled.status === S.scanned) return { state: 'waiting', hint: '已扫码，请在手机上点「确认登录」' }
  if (polled.status === S.cancelled) return { state: 'cancelled', hint: '你已在手机上取消授权' }
  if (polled.status === S.expired) return { state: 'error', error: '二维码已失效，请重新发起登录' }
  if (polled.status === S.error) return { state: 'pending', hint: '网络抖动，继续等待扫码…' }

  // 405 = 已确认。⚠️ 空 code 不判成功（上一行解析已保守降级为 scanned，这里再兜一次）。
  if (polled.status !== S.confirmed || polled.code.length === 0) {
    return { state: 'waiting', hint: '已扫码，请在手机上点「确认登录」' }
  }

  let auth
  try {
    auth = await bindLoomyThirdAccount(polled.code, product, fetcher)
  } catch (error) {
    return {
      state: 'error',
      error: `微信授权确认了，但换取讯飞登录态失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (auth.bind !== 1) {
    // 需绑手机号：契约没有输入 UI ⇒ 诚实失败，不假装成功。
    return { state: 'error', error: LOOMY_NEED_PHONE_ERROR }
  }

  let login
  try {
    login = await bindLoomySkip(auth.rcode, product, fetcher)
  } catch (error) {
    return {
      state: 'error',
      error: `换取讯飞登录凭证失败：${error instanceof Error ? error.message : String(error)}。请重新扫码`,
    }
  }

  const expiresAt = Date.now() + LOOMY_SESSION_TTL_SECONDS * 1000
  return {
    state: 'ok',
    hint: '登录成功：14 天内有效；讯飞无续期接口，到期后需重新扫码',
    maskedAccount: maskLoomyAccount(login.userid),
    accountId: login.userid,
    credential: {
      token: login.session,
      expiresAt,
      ...(login.userid.length > 0 ? { userid: login.userid } : {}),
      ...(auth.nickname !== undefined ? { nickname: auth.nickname } : {}),
    },
  }
}
