/**
 * cs-myfree — 腾讯 CodeBuddy（buddy）浏览器一键登录（真实实现）
 *
 * 协议来源：对拍本机真实运行的参考包
 *   /home/ubuntu/plugins/my-free-model/node_modules/dsh-codearts-auth/lib/
 *   `buddy-oauth.js`（fetchAuthState → loopGetToken → getAccount）、
 *   `buddy.js`（常量/解析/凭据结构）、`product.js`（CODEBUDDY / WORKBUDDY 产品配置）。
 *
 * 流程（**external-link-v2 轮询式，不是标准 OAuth 授权码**）：
 *   ① POST {endpoint}/v2/plugin/auth/state?platform=<platform>
 *        → 服务端返回 { state, authUrl }（state 由**厂商**签发，一次性）
 *   ② 用户在浏览器打开 authUrl（登录站落在厂商域名，例如
 *        https://copilot.tencent.com/login?platform=ide&state=…
 *      本条 authUrl 必须原样使用，**不得重建/改写**：platform/state/路径全部由服务端下发）
 *   ③ 插件后台轮询 GET {endpoint}/v2/plugin/auth/token?state=…
 *        HTTP 200 且带 data ⇒ token 就绪；
 *        code=11217（"login ing..."）或 data 缺失 ⇒ 用户还没登录完，继续等；
 *        网络错误 ⇒ 继续等（对齐 Rust loop_get_token，不中断登录）
 *   ④ token 到手后再轮询 GET {endpoint}/v2/plugin/login/account?state=…（Bearer）
 *        code=12151 ⇒ 账号信息未就绪，继续等
 *   ⑤ buildCredential → { access_token, refresh_token, expires_at, … }
 *
 * 🔴 与 codearts 的关键差异（回应任务里的「公网回调」约束）：
 *   本协议**没有 redirect_uri、没有本地/公网回调、没有 code 交换**。
 *   参考包 buddy.d.ts 头部原文：「客户端不起本地服务器，而是定期轮询后端 API
 *   检查登录状态」。因此 opts.callbackUrl（公网回调）在本渠道**不参与流程**、
 *   也不得塞进 authUrl（那会把厂商下发的合法 URL 改写坏）。
 *   state 是厂商服务端下发的一次性串，不是我们自己的 oauthState；
 *   session.callbackCode 对 buddy/workbuddy 无意义（状态机写浏览器回调流的
 *   oauthState 登记也无害，只是本渠道不会消费它）。
 *
 * 🔴 零第三方依赖：参考包用 `jose` 解 JWT，这里只用 `node:crypto` + Buffer 的
 *   base64url 解码（仅读 exp/iat/sub/nickname 用于过期兜底与展示，不验签）。
 *
 * @module cs-myfree/pools/channels/login/buddy
 */

import { randomUUID } from 'node:crypto'

// ── 端点（逐字对拍参考包 buddy.js / product.js）────────────────────────────
export const AUTH_STATE_PATH = '/v2/plugin/auth/state'
export const AUTH_TOKEN_PATH = '/v2/plugin/auth/token'
export const LOGIN_ACCOUNT_PATH = '/v2/plugin/login/account'
export const AUTH_REFRESH_PATH = '/v2/plugin/auth/token/refresh'

// ── 协议常量（buddy.js / product.js）───────────────────────────────────────
/** token 尚未就绪（HTTP 200 + code=11217，继续轮询）。 */
export const CODE_TOKEN_NOT_READY = 11217
/** 账户信息尚未就绪（HTTP 200 + code=12151，继续轮询）。 */
export const CODE_ACCOUNT_NOT_READY = 12151
/** 登录轮询总超时：5 分钟（对齐 IDE 的 5*60*1e3）。 */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** 轮询间隔：1 秒（对齐 IDE 的 setTimeout(o,1e3)）。 */
export const POLL_INTERVAL_MS = 1000
/** auth/state 请求超时：10 秒（参考包实测 WorkBuddy 需 5.8–7.5s，5s 会必超时）。 */
export const STATE_REQUEST_TIMEOUT_MS = 10_000
/** 单次控制面请求超时：60 秒（对齐参考包 REQUEST_TIMEOUT_MS）。 */
export const REQUEST_TIMEOUT_MS = 60_000
/** 单次 poll 内 token/account 请求的超时：10 秒（状态机按秒轮询，过长会重叠）。 */
export const POLL_REQUEST_TIMEOUT_MS = 10_000
/** 登录态失效（需要用户重新登录）的 HTTP 状态。 */
const AUTH_EXPIRED_STATUS = new Set([401, 403])

// ── HTTP 头名（buddy.js）───────────────────────────────────────────────────
export const HTTP_HEADER = Object.freeze({
  DOMAIN: 'X-Domain',
  ENTERPRISE_ID: 'X-Enterprise-Id',
  TENANT_ID: 'X-Tenant-Id',
  NO_AUTHORIZATION: 'X-No-Authorization',
  NO_USER_ID: 'X-No-User-Id',
  NO_ENTERPRISE_ID: 'X-No-Enterprise-Id',
  NO_DEPARTMENT_INFO: 'X-No-Department-Info',
  REFRESH_TOKEN: 'X-Refresh-Token',
  AUTH_REFRESH_SOURCE: 'X-Auth-Refresh-Source',
  PRODUCT: 'X-Product',
  PRODUCT_CODE: 'X-Product-Code',
})
/** X-Product 是部署类型（SaaS），两个产品共用。 */
export const BUDDY_DEPLOYMENT_TYPE = 'SaaS'
/** 刷新来源标识（对齐 IDE 的 ide-main）。 */
export const AUTH_REFRESH_SOURCE = 'ide-main'

/** 无法从参考包证实的渠道 ⇒ 诚实降级，不造假 URL。 */
export const UNVERIFIED_PATH_NOTE = '本渠道登录协议未取证，请前往厂商官网登录后使用说明中的方式保存凭据'

/**
 * CodeBuddy 系产品配置（逐字对拍 product.js 的 CODEBUDDY / WORKBUDDY）。
 *
 * ⚠️ 同源产品共用一套 `/v2/plugin/**` 协议：差异只有 endpoint / platform /
 * User-Agent / productCode / 登录 URL 附加参数。故实现只有一份，配置化。
 */
export const BUDDY_PRODUCTS = Object.freeze({
  buddy: Object.freeze({
    id: 'buddy',
    /** product.json authentication.attributes.platform */
    platform: 'ide',
    endpoint: 'https://copilot.tencent.com',
    /** 凭据 domain / X-Domain 的兜底值 */
    apiDomain: 'copilot.tencent.com',
    productCode: 'codebuddy',
    userAgent: 'CodeBuddyIDE/1.106.1',
    /** 登录 URL 是否需要追加 version + loginSessionId（WorkBuddy 才有） */
    appendSessionParams: false,
    pluginVersion: null,
    displayName: 'CodeBuddy（腾讯）',
  }),
  workbuddy: Object.freeze({
    id: 'workbuddy',
    platform: 'workbuddy-ai',
    endpoint: 'https://www.workbuddy.ai',
    apiDomain: 'www.workbuddy.ai',
    productCode: 'workbuddy',
    userAgent: 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2',
    appendSessionParams: true,
    pluginVersion: '5.5.2',
    displayName: 'WorkBuddy（国际）',
  }),
})

/** 按 provider id 取产品配置；未知渠道返回 null（调用方据此诚实降级）。 */
export function resolveProduct(provider) {
  return BUDDY_PRODUCTS[String(provider)] ?? null
}

// ── 纯函数：请求构造 ───────────────────────────────────────────────────────

/** POST auth/state 的请求描述（URL / method / headers）。 */
export function buildAuthStateRequest(product) {
  return {
    url: `${product.endpoint}${AUTH_STATE_PATH}?platform=${encodeURIComponent(product.platform)}`,
    method: 'POST',
    headers: {
      [HTTP_HEADER.DOMAIN]: product.apiDomain,
      [HTTP_HEADER.NO_AUTHORIZATION]: 'true',
      [HTTP_HEADER.NO_USER_ID]: 'true',
      [HTTP_HEADER.NO_ENTERPRISE_ID]: 'true',
      [HTTP_HEADER.NO_DEPARTMENT_INFO]: 'true',
      'User-Agent': product.userAgent,
    },
  }
}

/** GET auth/token?state=… 的请求描述（状态机在 poll 里用）。 */
export function buildTokenPollRequest(product, state) {
  return {
    url: `${product.endpoint}${AUTH_TOKEN_PATH}?state=${encodeURIComponent(String(state))}`,
    method: 'GET',
    headers: {
      [HTTP_HEADER.NO_AUTHORIZATION]: 'true',
      'User-Agent': product.userAgent,
    },
  }
}

/**
 * GET login/account?state=… 的请求描述（Bearer）。
 * X-Domain 以服务端本次下发的 token.domain 为准，为空串时回退产品域名
 * （对齐参考包 `token.domain || product.apiDomain`）。
 */
export function buildAccountPollRequest(product, token, state) {
  const headers = {
    [HTTP_HEADER.DOMAIN]: token.domain || product.apiDomain,
    Authorization: `Bearer ${token.accessToken}`,
    [HTTP_HEADER.NO_USER_ID]: 'true',
    [HTTP_HEADER.NO_ENTERPRISE_ID]: 'true',
    'User-Agent': product.userAgent,
  }
  return {
    url: `${product.endpoint}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(String(state))}`,
    method: 'GET',
    headers,
  }
}

/**
 * 按产品配置装饰登录 URL：WorkBuddy 需追加 `version` 与 `loginSessionId`
 * （loginSessionId 为客户端 UUID，仅用于服务端日志追踪，实测无校验语义）。
 * 只**追加参数**，不重建 URL —— platform/state/路径全部来自服务端 authUrl。
 */
export function decorateLoginUrl(authUrl, product, uuidImpl = randomUUID) {
  if (!product?.appendSessionParams) return authUrl
  try {
    const url = new URL(authUrl)
    if (product.pluginVersion) url.searchParams.set('version', product.pluginVersion)
    url.searchParams.set('loginSessionId', String(uuidImpl()))
    return url.toString()
  } catch {
    // authUrl 非法时原样返回，交由后续流程报错
    return authUrl
  }
}

// ── 纯函数：响应解析 ───────────────────────────────────────────────────────

/** 从 JSON 安全读字符串字段（兼容后端把时间戳返回为数字），剔除控制字符。 */
function readStringField(data, key) {
  const v = data[key]
  if (typeof v === 'string') return stripControlChars(v)
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

/** 去掉控制字符（含 CR/LF/Tab），连续空白折叠为单个空格（对齐参考包，防 YAML 破结构）。 */
function stripControlChars(value) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/** 从 JSON 读数值字段（兼容数字型字符串）。 */
function readNumberField(data, key) {
  const v = data[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v)
  return undefined
}

/**
 * 读 JWT payload（**不验签**，只用于 exp/iat/sub/nickname 兜底）。
 * 用 Buffer 的 base64url 解码，替代参考包的 `jose`（零依赖红线）。
 * 非 JWT / 解析失败返回 null。
 */
export function jwtPayload(token) {
  if (typeof token !== 'string' || token.length === 0) return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const payload = JSON.parse(json)
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

function jwtExpiresAtMs(token) {
  const payload = jwtPayload(token)
  return typeof payload?.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined
}

function jwtIssuedAtMs(token) {
  const payload = jwtPayload(token)
  return typeof payload?.iat === 'number' && Number.isFinite(payload.iat) ? payload.iat * 1000 : undefined
}

function jwtNickname(token) {
  const payload = jwtPayload(token)
  const nickname = payload?.nickname ?? payload?.preferred_username ?? payload?.name
  return typeof nickname === 'string' ? stripControlChars(nickname) : ''
}

function jwtSubject(token) {
  const payload = jwtPayload(token)
  return typeof payload?.sub === 'string' ? payload.sub : ''
}

/** 绝对时间字段归一为毫秒时间戳字符串；无法解析时返回原字符串。 */
function normalizeAbsolute(value) {
  if (!/^\d+$/.test(value)) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? value : String(parsed)
  }
  const n = Number(value)
  return String(n > 1_000_000_000_000 ? n : n * 1000)
}

/**
 * 相对秒数（expiresIn / refreshExpiresIn）换算绝对毫秒；绝对字段优先。
 * 基准取 access_token 的 JWT `iat`（权威签发时刻），缺失时用当前时刻。
 */
function absoluteExpiryMs(record, absoluteKey, relativeKey, accessToken, nowMs = Date.now()) {
  const absolute = readStringField(record, absoluteKey)
  if (absolute.length > 0) return normalizeAbsolute(absolute)
  const relative = readNumberField(record, relativeKey)
  if (relative === undefined) return ''
  const base = jwtIssuedAtMs(accessToken) ?? nowMs
  return String(base + relative * 1000)
}

/**
 * 解析 `/v2/plugin/auth/token` 的 `data`（兼容 camelCase 与 snake_case）。
 *
 * 实测（参考包注释 + 2026-11-03 本机对拍）：该端点只返回**相对** `expiresIn`，
 * 没有绝对 `expiresAt`，故绝对字段缺失时用 expiresIn 换算。
 *
 * @param {object} data
 * @param {number} [nowMs] 测试可注入当前时刻
 */
export function parseTokenData(data, nowMs = Date.now()) {
  const record = (data && typeof data === 'object') ? data : {}
  const accessToken = readStringField(record, 'accessToken') || readStringField(record, 'access_token')
  const refreshToken = readStringField(record, 'refreshToken') || readStringField(record, 'refresh_token')
  const tokenType = readStringField(record, 'tokenType') || readStringField(record, 'token_type')
  return {
    accessToken,
    refreshToken,
    expiresAt: absoluteExpiryMs(record, 'expiresAt', 'expiresIn', accessToken, nowMs),
    refreshExpiresAt: absoluteExpiryMs(record, 'refreshExpiresAt', 'refreshExpiresIn', accessToken, nowMs),
    tokenType: tokenType.length > 0 ? tokenType : 'Bearer',
    scope: readStringField(record, 'scope'),
    domain: readStringField(record, 'domain'),
  }
}

/**
 * 解析 `/v2/plugin/login/account` 的 `data`（兼容 camelCase 与 snake_case）。
 * 该响应**不含**昵称时由 access_token 的 JWT 声明兜底（见 buildCredential）。
 */
export function parseAccountData(data) {
  const record = (data && typeof data === 'object') ? data : {}
  const accountType = readStringField(record, 'type') || readStringField(record, 'accountType') || 'personal'
  return {
    uid: readStringField(record, 'uid') || readStringField(record, 'userId') || readStringField(record, 'user_id'),
    nickname: readStringField(record, 'nickname'),
    enterpriseId: readStringField(record, 'enterpriseId') || readStringField(record, 'enterprise_id'),
    accountType,
  }
}

/** 凭据的绝对过期毫秒（优先 expires_at，回退 JWT exp；无法解析返回 null）。 */
export function credentialExpiresAtMs(credential) {
  const raw = credential?.expires_at
  if (typeof raw === 'string' && raw.length > 0) {
    if (/^\d+$/.test(raw)) {
      const n = Number(raw)
      return n > 1_000_000_000_000 ? n : n * 1000
    }
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  } else if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1_000_000_000_000 ? raw : raw * 1000
  }
  return jwtExpiresAtMs(credential?.access_token ?? credential?.token) ?? null
}

/**
 * 组合令牌 + 账户 → 可持久化凭据（对齐参考包 buildCredential 的字段语义）。
 *
 * 同时提供 task 契约要求的驼峰别名（token / refreshToken / expiresAt）与参考包
 * 的蛇形字段（access_token / refresh_token / expires_at）：
 * 状态机 `routes.js#normalizeCredential` 认 `token`/`access_token`，
 * 后续续期实现认 `refresh_token`。**两种别名是同一份数据的视图，不是两份副本。**
 */
export function buildCredential(token, account) {
  const nickname = account.nickname.length > 0 ? account.nickname : jwtNickname(token.accessToken)
  const userId = account.uid.length > 0 ? account.uid : jwtSubject(token.accessToken)
  const expiresAtMs = credentialExpiresAtMs({ expires_at: token.expiresAt, access_token: token.accessToken })
  return {
    // —— 契约别名 ——
    token: token.accessToken,
    refreshToken: token.refreshToken || undefined,
    // 续期来源：routes/accounts 原样落盘，续期请求头 X-Auth-Refresh-Source 用它
    refreshSource: AUTH_REFRESH_SOURCE,
    expiresAt: expiresAtMs ?? undefined,
    refreshExpiresAt: parseExpiresMs(token.refreshExpiresAt) ?? undefined,
    // —— 参考包蛇形字段（持久化 / 续期用）——
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expires_at: token.expiresAt,
    refresh_expires_at: token.refreshExpiresAt,
    token_type: token.tokenType,
    scope: token.scope,
    domain: token.domain,
    user_id: userId,
    nickname,
    enterprise_id: account.enterpriseId,
    account_type: account.accountType,
  }
}

function parseExpiresMs(v) {
  if (typeof v !== 'string' || v.length === 0) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 掩码：用于 `maskedAccount`（UI 可见），绝不回凭据原文。 */
export function maskAccount(value, head = 3, tail = 2) {
  const s = String(value ?? '').trim()
  if (s.length === 0) return null
  if (s.length <= head + tail) return `${s.slice(0, 1)}***`
  return `${s.slice(0, head)}***${s.slice(-tail)}`
}

/** 登录成功后给 UI 的掩码账号：优先昵称，其次脱敏 uid。 */
export function maskedAccountOf(account) {
  if (account.nickname) return account.nickname
  return maskAccount(account.uid)
}

// ── 错误分类 ───────────────────────────────────────────────────────────────

/** 错误分类（供 hint/error 文案与测试断言；不泄漏响应体中的敏感内容）。 */
export function classifyFailure({ httpStatus, code, message } = {}) {
  if (AUTH_EXPIRED_STATUS.has(httpStatus)) {
    return { kind: 'auth_expired', error: `登录授权已失效（HTTP ${httpStatus}），请重新登录` }
  }
  if (httpStatus === 429) return { kind: 'rate_limited', error: '请求过于频繁（HTTP 429），请稍后重试' }
  if (typeof httpStatus === 'number' && httpStatus >= 500) {
    return { kind: 'upstream', error: `厂商服务异常（HTTP ${httpStatus}），请稍后重试` }
  }
  if (typeof code === 'number' && code !== 0) {
    return { kind: 'upstream_code', error: `厂商返回错误码 ${code}${message ? `：${truncate(message)}` : ''}` }
  }
  if (typeof httpStatus === 'number') return { kind: 'http', error: `厂商返回 HTTP ${httpStatus}` }
  return { kind: 'unknown', error: '登录失败（未知错误）' }
}

function truncate(s, max = 120) {
  const t = String(s ?? '').replace(/[\r\n]+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

// ── 网络 ───────────────────────────────────────────────────────────────────

/**
 * 发一次请求并解析 JSON（网络错误抛出，由调用方决定 transient 处理）。
 * 只返回 { status, body }，**不记录 URL 里的 state、不记录响应体**（安全红线）。
 */
async function request(fetcher, { url, method, headers }, { timeoutMs, signal } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs ?? PROBE_TIMEOUT_MS)
  const combined = signal
    ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([timeout, signal]) : timeout)
    : timeout
  const res = await fetcher(url, { method, headers, signal: combined })
  let body = null
  try { body = await res.json() } catch { body = null }
  return { status: res.status, body }
}

const PROBE_TIMEOUT_MS = STATE_REQUEST_TIMEOUT_MS

function responseData(body) {
  if (!body || typeof body !== 'object') return undefined
  const data = body.data
  return data === null ? undefined : data
}

function responseCode(body) {
  if (!body || typeof body !== 'object') return 0
  return typeof body.code === 'number' ? body.code : 0
}

function responseMessage(body) {
  if (!body || typeof body !== 'object') return ''
  return typeof body.msg === 'string' ? body.msg : (typeof body.message === 'string' ? body.message : '')
}

// ── 流程：start（异步：必须现场换取 authUrl）────────────────────────────────

/**
 * 获取 auth state（POST，无需认证）。
 * @returns {Promise<{state:string, authUrl:string}>}
 */
export async function fetchAuthState(product, { fetchImpl, signal, timeoutMs } = {}) {
  if (!product) throw new Error('未知渠道：没有对应的 CodeBuddy 系产品配置')
  const fetcher = fetchImpl ?? globalThis.fetch
  const req = buildAuthStateRequest(product)
  let result
  try {
    result = await request(fetcher, req, { timeoutMs: timeoutMs ?? STATE_REQUEST_TIMEOUT_MS, signal })
  } catch (err) {
    // 网络层失败（DNS/超时/连接重置）：给可读文案，不把原始栈丢给 UI
    throw new Error(`获取 ${product.displayName}登录地址失败（网络错误）：${String(err?.message ?? err).slice(0, 160)}`)
  }
  const { status, body } = result
  if (status !== 200) {
    const f = classifyFailure({ httpStatus: status, code: responseCode(body), message: responseMessage(body) })
    throw new Error(`获取 ${product.displayName}登录地址失败（auth/state）：${f.error}`)
  }
  const data = responseData(body)
  if (!data || typeof data !== 'object') throw new Error(`获取 ${product.displayName}登录地址失败：auth/state 响应缺少 data`)
  const state = typeof data.state === 'string' ? data.state : ''
  const authUrl = typeof data.authUrl === 'string' ? data.authUrl : ''
  if (!state) throw new Error(`获取 ${product.displayName}登录地址失败：auth/state 响应缺少 state`)
  if (!authUrl) throw new Error(`获取 ${product.displayName}登录地址失败：auth/state 响应缺少 authUrl`)
  return { state, authUrl }
}

/** start 的说明文案（UI 逐步展示）。 */
function startInstructions(product) {
  return [
    '点「打开登录页」，用你的账号在官方页面完成登录',
    '登录完成后不需要粘贴任何东西，本页会自动轮询并完成登录',
    `授权域名为 ${product.apiDomain}；任何索要密码/验证码的页面都不是本插件`,
  ]
}

/**
 * 开始一次 buddy/workbuddy 登录（**async**：authUrl 必须现场向厂商换取）。
 *
 * 状态机（index.js）已 `await flow.initial(...)`，故这里直接返回 Promise。
 * 端点/参数全部来自参考包对拍，见文件头；拿不到 authUrl 时**抛错**（诚实失败），
 * 绝不返回编造的厂商 URL。
 */
export async function startProductLogin(product, provider, ch, opts = {}) {
  if (!product) throw new Error(`未知渠道登录器：${provider ?? '?'}`)
  const { state, authUrl } = await fetchAuthState(product, {
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
    timeoutMs: opts.stateTimeoutMs,
  })
  const url = decorateLoginUrl(authUrl, product, opts.uuidImpl)
  return {
    flow: 'browser',
    // 🔴 原样使用厂商下发的 authUrl（只按产品配置追加 version/loginSessionId）
    url,
    // UI 用：本渠道没有回调，只有轮询 ⇒ 文案应为「已打开登录页，正在等待授权…」
    pollingOnly: true,
    interval: 2,
    instructions: startInstructions(product),
    // poll 用的私有字段（_ 开头，不回给前端）
    _authState: state,
    _provider: provider,
    _product: product.id,
    _callbackUrl: opts.callbackUrl,
    _startedAt: Date.now(),
  }
}

// ── 流程：poll ─────────────────────────────────────────────────────────────

function isExpiredSession(session, nowMs) {
  const deadline = (session._startedAt ?? session.startedAt ?? nowMs) + LOGIN_TIMEOUT_MS
  return nowMs > deadline
}

/**
 * 轮询 exchange：一步（尽可能）推进登录。
 *
 * 状态：
 *  · token 未就绪（11217 / data 缺失 / 网络抖动）→ waiting
 *  · token 就绪但 account 未就绪（12151）→ waiting（token 存 session._token，不进响应）
 *  · 两者就绪 → ok + credential
 *  · 授权被拒（401/403）或厂商明确错误 → error
 *  · 超过 5 分钟 → error（不会永远转圈）
 */
export async function pollProductLogin(product, session, opts = {}) {
  const fetcher = opts.fetchImpl ?? globalThis.fetch
  const nowMs = opts.nowMs ?? Date.now()
  if (opts.cancel || session.state === 'cancelled') return { state: 'cancelled', hint: '已取消登录' }
  if (!product) return { state: 'error', error: `未知渠道登录器：${session.provider ?? '?'}` }

  if (!session._authState) return { state: 'error', error: '登录会话缺少 auth state，请重新发起登录' }
  if (isExpiredSession(session, nowMs)) {
    return { state: 'error', error: '登录超时（5 分钟内未完成授权），请重试' }
  }

  // ① token：已有就直接进入 ②（account 轮询可能要多次）
  if (!session._token) {
    const req = buildTokenPollRequest(product, session._authState)
    let status
    let body
    try {
      ;({ status, body } = await request(fetcher, req, { timeoutMs: POLL_REQUEST_TIMEOUT_MS }))
    } catch {
      // 网络抖动：继续等，不当失败（对齐参考包 loopGetToken 的 catch continue）
      return { state: 'waiting', hint: '网络抖动，继续等待你在浏览器完成登录…' }
    }
    if (status === 200) {
      const data = responseData(body)
      if (data !== undefined) {
        const token = parseTokenData(data, nowMs)
        if (!token.accessToken) {
          return { state: 'error', error: '厂商返回了空 access_token，请重试' }
        }
        session._token = token
      } else if (responseCode(body) === CODE_TOKEN_NOT_READY || responseCode(body) === 0) {
        return { state: 'waiting', hint: '等待你在浏览器完成登录…' }
      } else {
        const f = classifyFailure({ httpStatus: status, code: responseCode(body), message: responseMessage(body) })
        return { state: 'error', error: f.error }
      }
    } else {
      const f = classifyFailure({ httpStatus: status, code: responseCode(body), message: responseMessage(body) })
      return { state: f.kind === 'rate_limited' ? 'waiting' : 'error', error: f.kind === 'rate_limited' ? undefined : f.error, hint: f.kind === 'rate_limited' ? '请求过于频繁，稍后自动重试…' : undefined }
    }
  }

  // ② account（token 就绪后）
  const token = session._token
  const acctReq = buildAccountPollRequest(product, token, session._authState)
  let status
  let body
  try {
    ;({ status, body } = await request(fetcher, acctReq, { timeoutMs: POLL_REQUEST_TIMEOUT_MS }))
  } catch {
    return { state: 'waiting', hint: '已拿到令牌，正在读取账号信息（网络抖动，重试中）…' }
  }
  if (status === 200) {
    const data = responseData(body)
    if (data !== undefined) {
      const account = parseAccountData(data)
      const credential = buildCredential(token, account)
      return {
        state: 'ok',
        hint: '登录成功',
        credential,
        maskedAccount: maskedAccountOf({ nickname: credential.nickname, uid: credential.user_id }),
        accountId: account.uid || undefined,
      }
    }
    if (responseCode(body) === CODE_ACCOUNT_NOT_READY || responseCode(body) === 0) {
      return { state: 'waiting', hint: '已拿到令牌，正在读取账号信息…' }
    }
    const f = classifyFailure({ httpStatus: status, code: responseCode(body), message: responseMessage(body) })
    return { state: 'error', error: f.error }
  }
  const f = classifyFailure({ httpStatus: status, code: responseCode(body), message: responseMessage(body) })
  return { state: f.kind === 'rate_limited' ? 'waiting' : 'error', error: f.kind === 'rate_limited' ? undefined : f.error, hint: f.kind === 'rate_limited' ? '请求过于频繁，稍后自动重试…' : undefined }
}

// ── 导出：buddy ────────────────────────────────────────────────────────────

/** buddy（腾讯 CodeBuddy）start。 */
export async function startBuddy(provider, ch, opts = {}) {
  const product = resolveProduct('buddy')
  return startProductLogin(product, provider ?? 'buddy', ch, opts)
}

/** buddy（腾讯 CodeBuddy）poll。 */
export function pollBuddy(session, opts = {}) {
  return pollProductLogin(resolveProduct('buddy'), session, opts)
}

/**
 * 刷新令牌（供续期接线用；当前 routes 尚未持久化 refresh_token，见 README/任务回报）。
 * 端点/头逐字对拍参考包 refreshToken。
 * @param {object} credential 含 refresh_token + access_token
 * @returns {Promise<{accessToken, refreshToken, expiresAt, ...}>}
 */
export async function refreshProductToken(product, credential, opts = {}) {
  const fetcher = opts.fetchImpl ?? globalThis.fetch
  const refreshToken = credential?.refresh_token ?? credential?.refreshToken ?? ''
  const accessToken = credential?.access_token ?? credential?.token ?? ''
  if (!refreshToken) {
    const err = new Error('无 refresh_token，需要重新登录')
    err.kind = 'auth_expired'
    throw err
  }
  const req = {
    url: `${product.endpoint}${AUTH_REFRESH_PATH}`,
    method: 'POST',
    headers: {
      [HTTP_HEADER.DOMAIN]: credential.domain || product.apiDomain,
      'User-Agent': product.userAgent,
      Authorization: `Bearer ${accessToken}`,
      [HTTP_HEADER.REFRESH_TOKEN]: refreshToken,
      [HTTP_HEADER.AUTH_REFRESH_SOURCE]: AUTH_REFRESH_SOURCE,
      // 企业账号：参考包 credentialRequestHeaders 会带这两个头，续期同样需要
      ...(credential.enterprise_id
        ? { [HTTP_HEADER.ENTERPRISE_ID]: credential.enterprise_id, [HTTP_HEADER.TENANT_ID]: credential.enterprise_id }
        : {}),
    },
  }
  const { status, body } = await request(fetcher, req, { timeoutMs: opts.timeoutMs ?? REQUEST_TIMEOUT_MS })
  if (status !== 200) {
    const code = responseCode(body)
    const message = responseMessage(body)
    const expired = AUTH_EXPIRED_STATUS.has(status) || AUTH_EXPIRED_STATUS.has(code)
      || /expired|invalid/i.test(message)
    const f = classifyFailure({ httpStatus: status, code, message })
    const err = new Error(f.error)
    err.kind = expired ? 'auth_expired' : f.kind
    throw err
  }
  const data = responseData(body)
  if (!data || typeof data !== 'object') throw new Error('刷新 token 响应缺少 data 字段')
  return parseTokenData(data, opts.nowMs ?? Date.now())
}
