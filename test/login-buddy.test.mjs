/**
 * cs-myfree — buddy（腾讯 CodeBuddy）/ workbuddy（WorkBuddy 国际）登录测试
 *
 * 纪律：**全 mock，绝不联网**。真实端点对拍见模块头注释与 commit message。
 *
 * 覆盖：
 *  · start：POST /v2/plugin/auth/state 的 URL/方法/头（platform 随产品）
 *  · 登录 URL：原样使用厂商 authUrl；不含 127.0.0.1、不塞我们的公网 callbackUrl
 *  · workbuddy 的 URL 追加 version + loginSessionId（且不破坏 platform/state）
 *  · token/account 解析（camelCase/snake_case、expiresIn→绝对时间、JWT exp 兜底）
 *  · callback → poll 交换：11217 未就绪→waiting、12151→waiting、就绪→ok+credential
 *  · 错误分类：网络抖动继续等、401/403 致命、超时、未知错误码、取消
 *  · 未取证/未知渠道诚实降级（不造 URL）
 *  · 状态机集成：startLogin → getSession(含 _authState) → pollLogin → credential
 *  · 凭据不进 poll 的 HTTP 可见字段（状态机契约）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  AUTH_STATE_PATH, AUTH_TOKEN_PATH, LOGIN_ACCOUNT_PATH, AUTH_REFRESH_PATH,
  CODE_TOKEN_NOT_READY, CODE_ACCOUNT_NOT_READY, AUTH_REFRESH_SOURCE,
  BUDDY_PRODUCTS, HTTP_HEADER, REQUEST_TIMEOUT_MS,
  resolveProduct, buildAuthStateRequest, buildTokenPollRequest, buildAccountPollRequest,
  decorateLoginUrl, jwtPayload, parseTokenData, parseAccountData,
  buildCredential, credentialExpiresAtMs, maskAccount, maskedAccountOf,
  classifyFailure, fetchAuthState, startProductLogin, pollProductLogin,
  startBuddy, pollBuddy, refreshProductToken,
} from '../src/pools/channels/login/buddy.js'
import {
  WORKBUDDY_PRODUCT, startWorkbuddy, pollWorkbuddy, refreshWorkbuddyToken,
} from '../src/pools/channels/login/workbuddy.js'
import { getFlow, FLOW_MAP, FLOW_TYPE } from '../src/pools/channels/login/flow-map.js'
import {
  startLogin, pollLogin, getSession, cancelLogin,
} from '../src/pools/channels/login/index.js'
import { CHANNELS } from '../src/pools/channels/protocols.js'

const PUB = 'http://150.158.175.241'
const CB = '/cs-myfree/login/callback'
const BUDDY = BUDDY_PRODUCTS.buddy
const WB = BUDDY_PRODUCTS.workbuddy

// ── 测试工具（全 mock）─────────────────────────────────────────────────────

/** 造一个可解码的假 JWT（不需要真签名：解析只读 payload）。 */
function fakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function htmlResponse(status) {
  return {
    ok: false,
    status,
    json: async () => { throw new Error('not json') },
  }
}

/**
 * 按规则路由的假 fetch。handlers: [{ match(url,init), respond() }]
 * 未命中即抛错（防止测试里意外发出真实请求）。
 */
function mockFetch(handlers) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    for (const h of handlers) {
      if (h.match(String(url), init)) return h.respond(String(url), init)
    }
    throw new Error(`意外的网络请求（测试不应联网）：${url}`)
  }
  impl.calls = calls
  return impl
}

/** 标准 auth/state mock：断言 platform 并回服务端下发的 state/authUrl。 */
function stateHandler({ platform, authUrl }) {
  return {
    match: (url, init) => url.includes(AUTH_STATE_PATH) && init.method === 'POST' && url.includes(`platform=${platform}`),
    respond: () => jsonResponse(200, { code: 0, msg: 'OK', data: { state: 'S-123', authUrl } }),
  }
}

function tokenHandler({ platform = 'ide' } = {}) {
  return {
    match: (url) => url.includes(AUTH_TOKEN_PATH) && !url.includes('/refresh'),
    respond: () => jsonResponse(200, {
      code: 0,
      msg: 'OK',
      data: {
        accessToken: fakeJwt({ sub: 'U-1', nickname: '测试昵称', iat: 1700000000, exp: 1700003600 }),
        refreshToken: 'RT-1',
        expiresIn: 3600,
        refreshExpiresIn: 7200,
        tokenType: 'Bearer',
        scope: 'profile offline_access',
        domain: 'copilot.tencent.com',
      },
    }),
  }
}

function accountHandler() {
  return {
    match: (url) => url.includes(LOGIN_ACCOUNT_PATH),
    respond: () => jsonResponse(200, { code: 0, msg: 'OK', data: { uid: 'U-1', nickname: '', enterpriseId: '', type: 'personal' } }),
  }
}

// ── 产品配置（对拍 product.js）──────────────────────────────────────────────

test('产品配置逐字对拍参考包：buddy=ide/copilot.tencent.com，workbuddy=workbuddy-ai/www.workbuddy.ai', () => {
  assert.equal(BUDDY.platform, 'ide')
  assert.equal(BUDDY.endpoint, 'https://copilot.tencent.com')
  assert.equal(BUDDY.apiDomain, 'copilot.tencent.com')
  assert.equal(BUDDY.productCode, 'codebuddy')
  assert.equal(BUDDY.userAgent, 'CodeBuddyIDE/1.106.1')
  assert.equal(BUDDY.appendSessionParams, false)

  assert.equal(WB.platform, 'workbuddy-ai')
  assert.equal(WB.endpoint, 'https://www.workbuddy.ai')
  assert.equal(WB.apiDomain, 'www.workbuddy.ai')
  assert.equal(WB.productCode, 'workbuddy')
  assert.equal(WB.userAgent, 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2')
  assert.equal(WB.appendSessionParams, true)
  assert.equal(WB.pluginVersion, '5.5.2')

  // 端点常量逐字对拍 buddy.js
  assert.equal(AUTH_STATE_PATH, '/v2/plugin/auth/state')
  assert.equal(AUTH_TOKEN_PATH, '/v2/plugin/auth/token')
  assert.equal(LOGIN_ACCOUNT_PATH, '/v2/plugin/login/account')
  assert.equal(AUTH_REFRESH_PATH, '/v2/plugin/auth/token/refresh')
  assert.equal(CODE_TOKEN_NOT_READY, 11217)
  assert.equal(CODE_ACCOUNT_NOT_READY, 12151)

  assert.equal(resolveProduct('buddy'), BUDDY)
  assert.equal(resolveProduct('workbuddy'), WB)
  assert.equal(resolveProduct('nope'), null, '未知渠道必须返回 null（不造假配置）')
})

// ── start：auth/state 请求形状 ─────────────────────────────────────────────

test('auth/state 请求：POST /v2/plugin/auth/state?platform=ide + 参考包要求的所有免鉴权头', () => {
  const req = buildAuthStateRequest(BUDDY)
  assert.equal(req.method, 'POST')
  assert.equal(req.url, 'https://copilot.tencent.com/v2/plugin/auth/state?platform=ide')
  assert.equal(req.headers[HTTP_HEADER.DOMAIN], 'copilot.tencent.com')
  assert.equal(req.headers[HTTP_HEADER.NO_AUTHORIZATION], 'true')
  assert.equal(req.headers[HTTP_HEADER.NO_USER_ID], 'true')
  assert.equal(req.headers[HTTP_HEADER.NO_ENTERPRISE_ID], 'true')
  assert.equal(req.headers[HTTP_HEADER.NO_DEPARTMENT_INFO], 'true')
  assert.equal(req.headers['User-Agent'], BUDDY.userAgent)

  const wb = buildAuthStateRequest(WB)
  assert.equal(wb.url, 'https://www.workbuddy.ai/v2/plugin/auth/state?platform=workbuddy-ai')
  assert.equal(wb.headers[HTTP_HEADER.DOMAIN], 'www.workbuddy.ai')
  assert.equal(wb.headers['User-Agent'], WB.userAgent, 'WorkBuddy 必须带自己的 UA，不能带 CodeBuddy 的')
})

test('token/account 请求：state 走 query，account 带 Bearer 且 X-Domain 以 token.domain 为准', () => {
  const t = buildTokenPollRequest(BUDDY, 'S 1')
  assert.equal(t.url, 'https://copilot.tencent.com/v2/plugin/auth/token?state=S%201')
  assert.equal(t.headers[HTTP_HEADER.NO_AUTHORIZATION], 'true')
  assert.equal(t.headers['User-Agent'], BUDDY.userAgent)

  const a = buildAccountPollRequest(BUDDY, { accessToken: 'AT', domain: 'copilot.tencent.com' }, 'S1')
  assert.equal(a.method, 'GET')
  assert.equal(a.url, 'https://copilot.tencent.com/v2/plugin/login/account?state=S1')
  assert.equal(a.headers.Authorization, 'Bearer AT')
  assert.equal(a.headers[HTTP_HEADER.DOMAIN], 'copilot.tencent.com')

  // token.domain 为空串时回退产品域名（对齐参考包 `token.domain || product.apiDomain`）
  const a2 = buildAccountPollRequest(BUDDY, { accessToken: 'AT', domain: '' }, 'S1')
  assert.equal(a2.headers[HTTP_HEADER.DOMAIN], 'copilot.tencent.com')
})

// ── 登录 URL：诚实、厂商下发、不塞 127.0.0.1/回调 ─────────────────────────

test('startBuddy：URL 是厂商下发的 authUrl，绝不出现 127.0.0.1 / 我们的公网回调', async () => {
  const authUrl = 'https://copilot.tencent.com/login?platform=ide&state=S-123'
  const fetchImpl = mockFetch([stateHandler({ platform: 'ide', authUrl })])
  const init = await startBuddy('buddy', CHANNELS.buddy, {
    fetchImpl,
    // 状态机注入的公网回调：本渠道**不使用**，更不得拼进授权 URL
    callbackUrl: `${PUB}${CB}?state=abc`,
    publicBase: PUB,
    callbackPath: CB,
  })
  assert.equal(init.flow, 'browser')
  assert.equal(init.pollingOnly, true, 'UI 需要知道本渠道没有回调、只有轮询')
  assert.equal(init.url, authUrl, '必须原样使用服务端下发的 authUrl')
  assert.equal(init._authState, 'S-123', 'poll 用厂商下发的 state')
  assert.ok(init.instructions.length >= 2)
  assert.ok(!init.url.includes('127.0.0.1'), '远程浏览器收不到 127.0.0.1')
  assert.ok(!init.url.includes('150.158.175.241'), '不得把我们的公网回调塞进厂商授权 URL（会 URL 非法）')
  assert.ok(!init.url.includes('cs-myfree'), '授权 URL 必须指向厂商域名')

  // 断言真的按参考包发了 POST auth/state
  assert.equal(fetchImpl.calls.length, 1)
  const { url, init: reqInit } = fetchImpl.calls[0]
  assert.ok(url.includes('/v2/plugin/auth/state?platform=ide'))
  assert.equal(reqInit.method, 'POST')
  assert.equal(reqInit.headers['X-No-Authorization'], 'true')
})

test('startWorkbuddy：追加 version + loginSessionId，但不破坏 platform/state', async () => {
  const authUrl = 'https://www.workbuddy.ai/login?platform=workbuddy-ai&state=S-9'
  const fetchImpl = mockFetch([stateHandler({ platform: 'workbuddy-ai', authUrl })])
  const init = await startWorkbuddy('workbuddy', CHANNELS.workbuddy, {
    fetchImpl,
    uuidImpl: () => 'uuid-fixed-1',
  })
  const u = new URL(init.url)
  assert.equal(u.origin, 'https://www.workbuddy.ai')
  assert.equal(u.searchParams.get('platform'), 'workbuddy-ai', '平台参数必须保留（来自服务端）')
  assert.equal(u.searchParams.get('state'), 'S-9', 'state 必须保留（来自服务端）')
  assert.equal(u.searchParams.get('version'), '5.5.2')
  assert.equal(u.searchParams.get('loginSessionId'), 'uuid-fixed-1')
  assert.equal(init.pollingOnly, true)

  // 断言端点是 workbuddy 的（不是 CodeBuddy 的）
  assert.ok(fetchImpl.calls[0].url.startsWith('https://www.workbuddy.ai/'))
  assert.ok(fetchImpl.calls[0].init.headers['User-Agent'].includes('WorkBuddy'))
})

test('decorateLoginUrl：buddy 原样；workbuddy 只追加参数（不改写已有参数）', () => {
  const raw = 'https://copilot.tencent.com/login?platform=ide&state=abc'
  assert.equal(decorateLoginUrl(raw, BUDDY), raw, 'buddy 不得改写 URL')

  const wb = decorateLoginUrl('https://www.workbuddy.ai/login?platform=workbuddy-ai&state=abc', WB, () => 'u1')
  const u = new URL(wb)
  assert.equal(u.searchParams.get('platform'), 'workbuddy-ai')
  assert.equal(u.searchParams.get('state'), 'abc')
  assert.equal(u.searchParams.get('version'), '5.5.2')
  assert.equal(u.searchParams.get('loginSessionId'), 'u1')

  // 非法 URL 原样返回（不抛，交由后续流程报错）
  assert.equal(decorateLoginUrl('not a url', WB), 'not a url')
})

test('auth/state 失败必须诚实报错（不返回编造的 URL）', async () => {
  const fetchImpl = mockFetch([{
    match: (url) => url.includes(AUTH_STATE_PATH),
    respond: () => jsonResponse(500, { code: 500, msg: 'boom' }),
  }])
  await assert.rejects(
    () => startBuddy('buddy', CHANNELS.buddy, { fetchImpl }),
    /获取 CodeBuddy（腾讯）登录地址失败/,
  )

  const noData = mockFetch([{
    match: (url) => url.includes(AUTH_STATE_PATH),
    respond: () => jsonResponse(200, { code: 0, data: null }),
  }])
  await assert.rejects(() => startBuddy('buddy', CHANNELS.buddy, { fetchImpl: noData }), /缺少 data/)

  const noUrl = mockFetch([{
    match: (url) => url.includes(AUTH_STATE_PATH),
    respond: () => jsonResponse(200, { code: 0, data: { state: 'S' } }),
  }])
  await assert.rejects(() => startBuddy('buddy', CHANNELS.buddy, { fetchImpl: noUrl }), /缺少 authUrl/)
})

// ── 解析 ───────────────────────────────────────────────────────────────────

test('parseTokenData：camelCase + 相对 expiresIn 换算绝对时间（基准 JWT iat）', () => {
  const accessToken = fakeJwt({ iat: 1700000000, exp: 1700003600 })
  const t = parseTokenData({
    accessToken,
    refreshToken: 'RT',
    expiresIn: 3600,
    refreshExpiresIn: 7200,
    tokenType: 'Bearer',
    scope: 'profile\n    offline_access',
    domain: 'copilot.tencent.com',
  }, 1800000000000)
  assert.equal(t.accessToken, accessToken)
  assert.equal(t.refreshToken, 'RT')
  assert.equal(t.expiresAt, String((1700000000 + 3600) * 1000), 'expiresIn 以 JWT iat 为基准换算')
  assert.equal(t.refreshExpiresAt, String((1700000000 + 7200) * 1000))
  assert.equal(t.tokenType, 'Bearer')
  assert.equal(t.scope, 'profile offline_access', '多行 scope 必须折叠（防落盘 YAML 破结构）')
  assert.equal(t.domain, 'copilot.tencent.com')
})

test('parseTokenData：snake_case 与绝对时间戳都认，缺失 tokenType 默认 Bearer', () => {
  const t = parseTokenData({ access_token: 'AT', refresh_token: 'RT', expiresAt: '2026-11-05T00:00:00Z' })
  assert.equal(t.accessToken, 'AT')
  assert.equal(t.refreshToken, 'RT')
  assert.equal(t.expiresAt, String(Date.parse('2026-11-05T00:00:00Z')))
  assert.equal(t.tokenType, 'Bearer')

  const secs = parseTokenData({ access_token: 'AT', expiresAt: 1800000000 })
  assert.equal(secs.expiresAt, String(1800000000 * 1000), '秒级时间戳必须换算为毫秒')
})

test('parseTokenData：只有 JWT 没有 expires 字段时，credentialExpiresAtMs 用 JWT exp 兜底', () => {
  const accessToken = fakeJwt({ exp: 1700003600 })
  const t = parseTokenData({ accessToken })
  assert.equal(t.expiresAt, '')
  assert.equal(credentialExpiresAtMs({ expires_at: t.expiresAt, access_token: accessToken }), 1700003600 * 1000)
})

test('parseAccountData：camelCase/snake_case 兼容，缺省 type=personal', () => {
  const a = parseAccountData({ uid: 'U1', nickname: '张三', enterpriseId: 'E1', type: 'enterprise' })
  assert.deepEqual(a, { uid: 'U1', nickname: '张三', enterpriseId: 'E1', accountType: 'enterprise' })

  const b = parseAccountData({ user_id: 'U2', enterprise_id: 'E2', account_type: 'personal' })
  assert.equal(b.uid, 'U2')
  assert.equal(b.enterpriseId, 'E2')
  assert.equal(b.accountType, 'personal')

  assert.deepEqual(parseAccountData(null), { uid: '', nickname: '', enterpriseId: '', accountType: 'personal' })
})

test('buildCredential：契约别名 + 参考包蛇形字段 + refreshSource + JWT 兜底昵称/uid', () => {
  const accessToken = fakeJwt({ sub: 'SUB-1', nickname: 'JWT 昵称', iat: 1700000000, exp: 1700003600 })
  const token = parseTokenData({ accessToken, refreshToken: 'RT-1', expiresIn: 3600, domain: 'copilot.tencent.com' })
  const cred = buildCredential(token, parseAccountData({ uid: '', nickname: '' }))
  assert.equal(cred.token, accessToken)
  assert.equal(cred.refreshToken, 'RT-1')
  assert.equal(cred.refreshSource, AUTH_REFRESH_SOURCE)
  assert.equal(cred.refreshSource, 'ide-main')
  assert.equal(cred.access_token, accessToken)
  assert.equal(cred.refresh_token, 'RT-1')
  assert.equal(cred.expiresAt, (1700000000 + 3600) * 1000)
  assert.equal(cred.nickname, 'JWT 昵称', 'account 无昵称时回填 JWT 声明')
  assert.equal(cred.user_id, 'SUB-1', 'account 无 uid 时回填 JWT sub')
  assert.equal(cred.domain, 'copilot.tencent.com')
})

test('jwtPayload：非法/缺失返回 null，绝不抛', () => {
  assert.equal(jwtPayload(''), null)
  assert.equal(jwtPayload('abc'), null)
  assert.equal(jwtPayload('a.b'), null)
  assert.equal(jwtPayload('a.!!!.c'), null)
  const p = jwtPayload(fakeJwt({ exp: 1 }))
  assert.equal(p.exp, 1)
})

test('maskAccount/maskedAccountOf：UI 只见掩码或昵称，绝不见完整 uid', () => {
  assert.equal(maskAccount('1234567890'), '123***90')
  assert.equal(maskAccount('ab'), 'a***')
  assert.equal(maskAccount(''), null)
  assert.equal(maskedAccountOf({ nickname: '小明', uid: 'U-SECRET-1' }), '小明')
  const masked = maskedAccountOf({ nickname: '', uid: 'USER-SECRET-UID' })
  assert.ok(!masked.includes('SECRET'), `掩码泄漏了完整 uid：${masked}`)
})

test('classifyFailure：401/403=授权失效、429=限流、5xx=上游、错误码=厂商错误', () => {
  assert.equal(classifyFailure({ httpStatus: 401 }).kind, 'auth_expired')
  assert.equal(classifyFailure({ httpStatus: 403 }).kind, 'auth_expired')
  assert.equal(classifyFailure({ httpStatus: 429 }).kind, 'rate_limited')
  assert.equal(classifyFailure({ httpStatus: 502 }).kind, 'upstream')
  const c = classifyFailure({ httpStatus: 200, code: 99999, message: 'bad\r\nthing' })
  assert.equal(c.kind, 'upstream_code')
  assert.ok(!c.error.includes('\n'), '错误文案不得含原始换行')
})

// ── poll：callback → 交换（本协议无 code，用 state 轮询）───────────────────

const baseSession = (over = {}) => ({
  provider: 'buddy',
  flow: 'browser',
  state: 'pending',
  _authState: 'S-123',
  _startedAt: Date.now(),
  startedAt: Date.now(),
  ...over,
})

test('pollBuddy 全链路：11217 未就绪 → waiting；account 12151 → waiting；就绪 → ok+credential', async () => {
  // ① token 未就绪：HTTP 200 + code=11217（实测形态）
  const s1 = mockFetch([{ match: (u) => u.includes(AUTH_TOKEN_PATH), respond: () => jsonResponse(200, { code: CODE_TOKEN_NOT_READY, msg: 'login ing...' }) }])
  const r1 = await pollBuddy(baseSession(), { fetchImpl: s1 })
  assert.equal(r1.state, 'waiting')
  assert.match(r1.hint, /等待/)

  // ② token 就绪，但 account 未就绪：HTTP 200 + code=12151
  const s2 = mockFetch([
    tokenHandler(),
    { match: (u) => u.includes(LOGIN_ACCOUNT_PATH), respond: () => jsonResponse(200, { code: CODE_ACCOUNT_NOT_READY, msg: 'not ready' }) },
  ])
  const session2 = baseSession()
  const r2 = await pollBuddy(session2, { fetchImpl: s2 })
  assert.equal(r2.state, 'waiting')
  assert.match(r2.hint, /读取账号信息/)
  assert.ok(session2._token, 'token 必须暂存在会话里（不进 HTTP 响应）')

  // ③ account 就绪 → ok
  const s3 = mockFetch([tokenHandler(), accountHandler()])
  const session3 = baseSession()
  const r3 = await pollBuddy(session3, { fetchImpl: s3 })
  assert.equal(r3.state, 'ok')
  assert.equal(r3.credential.token.startsWith('eyJ'), true)
  assert.equal(r3.credential.refreshToken, 'RT-1')
  assert.equal(r3.credential.refreshSource, 'ide-main')
  assert.equal(typeof r3.credential.expiresAt, 'number')
  assert.equal(r3.maskedAccount, '测试昵称')
  assert.equal(r3.accountId, 'U-1')

  // account 请求必须带 Bearer + X-Domain
  const acctCall = s3.calls.find((c) => c.url.includes(LOGIN_ACCOUNT_PATH))
  assert.equal(acctCall.init.headers.Authorization.startsWith('Bearer '), true)
  assert.equal(acctCall.init.headers['X-Domain'], 'copilot.tencent.com')
})

test('pollWorkbuddy：走 workbuddy 端点与 UA（不能串到 CodeBuddy）', async () => {
  const fetchImpl = mockFetch([
    { match: (u) => u.includes(AUTH_TOKEN_PATH), respond: () => jsonResponse(200, { code: 0, data: { accessToken: 'AT-WB' } }) },
    { match: (u) => u.includes(LOGIN_ACCOUNT_PATH), respond: () => jsonResponse(200, { code: 0, data: { uid: 'U-WB', nickname: 'WB 用户' } }) },
  ])
  const r = await pollWorkbuddy(baseSession({ provider: 'workbuddy' }), { fetchImpl })
  assert.equal(r.state, 'ok')
  assert.equal(r.credential.token, 'AT-WB')
  for (const c of fetchImpl.calls) {
    assert.ok(c.url.startsWith('https://www.workbuddy.ai/'), `端点必须是 workbuddy：${c.url}`)
    assert.ok(c.init.headers['User-Agent'].includes('WorkBuddy'), 'WorkBuddy 必须带自己的 UA')
  }
})

test('poll：网络抖动继续等（不当失败），401 才是致命', async () => {
  const flaky = mockFetch([{ match: (u) => u.includes(AUTH_TOKEN_PATH), respond: () => { throw new Error('ECONNRESET') } }])
  const r1 = await pollBuddy(baseSession(), { fetchImpl: flaky })
  assert.equal(r1.state, 'waiting', '网络抖动不能把用户刚点完的登录判失败')

  const denied = mockFetch([{ match: (u) => u.includes(AUTH_TOKEN_PATH), respond: () => htmlResponse(401) }])
  const r2 = await pollBuddy(baseSession(), { fetchImpl: denied })
  assert.equal(r2.state, 'error')
  assert.match(r2.error, /授权已失效|重新登录/)
})

test('poll：厂商明确错误码 → error（不无限重试）', async () => {
  const fetchImpl = mockFetch([{ match: (u) => u.includes(AUTH_TOKEN_PATH), respond: () => jsonResponse(200, { code: 40001, msg: 'invalid state' }) }])
  const r = await pollBuddy(baseSession(), { fetchImpl })
  assert.equal(r.state, 'error')
  assert.match(r.error, /40001/)
})

test('poll：5 分钟超时 → error；缺 auth state → error；取消 → cancelled', async () => {
  const noop = mockFetch([])
  const expired = await pollBuddy(baseSession({ _startedAt: Date.now() - 6 * 60 * 1000 }), { fetchImpl: noop })
  assert.equal(expired.state, 'error')
  assert.match(expired.error, /超时/)

  const noState = await pollBuddy(baseSession({ _authState: undefined }), { fetchImpl: noop })
  assert.equal(noState.state, 'error')
  assert.match(noState.error, /auth state/)

  const cancelled = await pollBuddy(baseSession(), { fetchImpl: noop, cancel: true })
  assert.equal(cancelled.state, 'cancelled')

  const wbNull = await pollProductLogin(null, baseSession(), { fetchImpl: noop })
  assert.equal(wbNull.state, 'error')
})

// ── 续期 ───────────────────────────────────────────────────────────────────

test('refresh：POST /v2/plugin/auth/token/refresh + X-Refresh-Token/X-Auth-Refresh-Source/Bearer', async () => {
  const accessToken = fakeJwt({ exp: 1800000000 })
  const fetchImpl = mockFetch([{
    match: (u) => u.includes(AUTH_REFRESH_PATH),
    respond: () => jsonResponse(200, { code: 0, data: { accessToken, refreshToken: 'RT-2', expiresIn: 3600 } }),
  }])
  const t = await refreshProductToken(BUDDY, { access_token: 'AT-OLD', refresh_token: 'RT-OLD', domain: 'copilot.tencent.com' }, { fetchImpl })
  assert.equal(t.accessToken, accessToken)
  assert.equal(t.refreshToken, 'RT-2')

  const call = fetchImpl.calls[0]
  assert.equal(call.init.method, 'POST')
  assert.equal(call.url, 'https://copilot.tencent.com/v2/plugin/auth/token/refresh')
  assert.equal(call.init.headers['X-Refresh-Token'], 'RT-OLD')
  assert.equal(call.init.headers['X-Auth-Refresh-Source'], 'ide-main')
  assert.equal(call.init.headers.Authorization, 'Bearer AT-OLD')
  assert.equal(call.init.headers['User-Agent'], BUDDY.userAgent)

  // workbuddy 续期必须带自己的 UA
  const wbFetch = mockFetch([{
    match: (u) => u.includes(AUTH_REFRESH_PATH),
    respond: () => jsonResponse(200, { code: 0, data: { accessToken: 'AT2' } }),
  }])
  await refreshWorkbuddyToken({ access_token: 'A', refresh_token: 'R' }, { fetchImpl: wbFetch })
  assert.equal(wbFetch.calls[0].init.headers['User-Agent'], WB.userAgent)
  assert.equal(wbFetch.calls[0].init.headers['X-Domain'], 'www.workbuddy.ai')
})

test('refresh：无 refresh_token → auth_expired；401 → auth_expired', async () => {
  await assert.rejects(() => refreshProductToken(BUDDY, { access_token: 'A' }), (err) => err.kind === 'auth_expired')

  const fetchImpl = mockFetch([{ match: (u) => u.includes(AUTH_REFRESH_PATH), respond: () => htmlResponse(401) }])
  await assert.rejects(
    () => refreshProductToken(BUDDY, { access_token: 'A', refresh_token: 'R' }, { fetchImpl }),
    (err) => err.kind === 'auth_expired',
  )
})

// ── 状态机集成（mock start/poll 全链路）────────────────────────────────────

test('状态机集成：startLogin(buddy) → session 带厂商 state → pollLogin → ok 且响应不含 credential', async () => {
  const authUrl = 'https://copilot.tencent.com/login?platform=ide&state=S-777'
  const startFetch = mockFetch([stateHandler({ platform: 'ide', authUrl })])
  const started = await startLogin('buddy', CHANNELS.buddy, {
    publicBase: PUB, callbackPath: CB, fetchImpl: startFetch,
  })
  assert.ok(started.sessionId)
  assert.equal(started.flow, FLOW_TYPE.BROWSER)
  assert.equal(started.url, authUrl, '状态机返回的 url 必须是厂商 authUrl')
  assert.ok(!String(started.callbackUrl).includes('127.0.0.1'))

  const session = getSession(started.sessionId)
  assert.equal(session._authState, 'S-123', 'poll 需要厂商下发的 state')
  assert.equal(session.provider, 'buddy')

  // ① 未就绪
  const notReady = mockFetch([{ match: (u) => u.includes(AUTH_TOKEN_PATH), respond: () => jsonResponse(200, { code: CODE_TOKEN_NOT_READY }) }])
  const p1 = await pollLogin(started.sessionId, { fetchImpl: notReady })
  assert.equal(p1.state, 'waiting')
  assert.equal('credential' in p1, false, 'poll 的 HTTP 可见字段绝不能含 credential')

  // ② 就绪
  const ready = mockFetch([tokenHandler(), accountHandler()])
  let p2 = await pollLogin(started.sessionId, { fetchImpl: ready })
  if (p2.state === 'waiting') p2 = await pollLogin(started.sessionId, { fetchImpl: ready })
  assert.equal(p2.state, 'ok')
  assert.equal('credential' in p2, false, 'poll 的 HTTP 可见字段绝不能含 credential')
  assert.ok(getSession(started.sessionId).credential.access_token, 'credential 只留在会话里，交给落盘')
  assert.equal(p2.maskedAccount, '测试昵称')

  cancelLogin(started.sessionId)
})

test('flow-map：buddy/workbuddy 接真实现（不是通用 browser 壳），且未验证要诚实标注', () => {
  for (const id of ['buddy', 'workbuddy']) {
    const f = getFlow(id, CHANNELS[id])
    assert.equal(f.type, FLOW_TYPE.BROWSER)
    assert.equal(typeof f.poll, 'function', `${id} 必须有真 poll（不能回落通用壳）`)
    assert.notEqual(f.poll.name, 'pollBrowser', `${id} 不能还是通用 browser 壳`)
    assert.equal(f.loginVerified, false, '未完成完整真机 token 交换前必须 false')
    assert.ok(f.loginNote && f.loginNote.length > 0, `${id} 未验证必须有说明`)
    assert.match(f.loginNote, /对拍|验证/, `${id} 的 note 要写明取证到哪一步`)
  }
  // 真实现入口可 await 且拿到厂商 URL（mock 网络）
  return Promise.all(['buddy', 'workbuddy'].map(async (id) => {
    const platform = id === 'buddy' ? 'ide' : 'workbuddy-ai'
    const authUrl = id === 'buddy'
      ? 'https://copilot.tencent.com/login?platform=ide&state=S'
      : 'https://www.workbuddy.ai/login?platform=workbuddy-ai&state=S'
    const fetchImpl = mockFetch([stateHandler({ platform, authUrl })])
    const f = getFlow(id, CHANNELS[id])
    const init = await f.initial(id, CHANNELS[id], { fetchImpl })
    assert.equal(init.flow, FLOW_TYPE.BROWSER)
    assert.ok(String(init.url).startsWith(new URL(authUrl).origin))
    assert.equal(init.pollingOnly, true)
  }))
})

// ── 健壮性：守卫 / 网络错误文案 / 企业头 ──────────────────────────────────

test('未知产品/渠道：明确报错，不自造配置', async () => {
  await assert.rejects(() => fetchAuthState(null), /未知渠道/)
  await assert.rejects(() => startProductLogin(null, 'zzz', null, {}), /未知渠道登录器/)
})

test('auth/state 网络层失败给可读文案（不带原始栈）', async () => {
  const fetchImpl = mockFetch([{ match: (u) => u.includes(AUTH_STATE_PATH), respond: () => { throw new Error('getaddrinfo ENOTFOUND copilot.tencent.com') } }])
  await assert.rejects(
    () => startBuddy('buddy', CHANNELS.buddy, { fetchImpl }),
    (err) => /获取 CodeBuddy（腾讯）登录地址失败（网络错误）/.test(err.message),
  )
})

test('refresh：企业账号带 X-Enterprise-Id / X-Tenant-Id（对齐 credentialRequestHeaders）', async () => {
  const fetchImpl = mockFetch([{
    match: (u) => u.includes(AUTH_REFRESH_PATH),
    respond: () => jsonResponse(200, { code: 0, data: { accessToken: 'AT2' } }),
  }])
  await refreshProductToken(BUDDY, { access_token: 'A', refresh_token: 'R', enterprise_id: 'E-9' }, { fetchImpl })
  const h = fetchImpl.calls[0].init.headers
  assert.equal(h['X-Enterprise-Id'], 'E-9')
  assert.equal(h['X-Tenant-Id'], 'E-9')

  const personal = mockFetch([{
    match: (u) => u.includes(AUTH_REFRESH_PATH),
    respond: () => jsonResponse(200, { code: 0, data: { accessToken: 'AT3' } }),
  }])
  await refreshProductToken(BUDDY, { access_token: 'A', refresh_token: 'R', enterprise_id: '' }, { fetchImpl: personal })
  assert.equal('X-Enterprise-Id' in personal.calls[0].init.headers, false, '个人账号不应带企业头')
})

// ── 静态约束：零第三方依赖 ─────────────────────────────────────────────────

test('零第三方依赖：buddy.js/workbuddy.js 只 import node:* 与本地模块', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const file of ['buddy.js', 'workbuddy.js']) {
    const src = readFileSync(join(here, '..', 'src', 'pools', 'channels', 'login', file), 'utf8')
    const imports = [...src.matchAll(/^import\s+(?:[^'"]*?)\s+from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
    for (const spec of imports) {
      assert.ok(spec.startsWith('node:') || spec.startsWith('./'), `${file} 出现非零依赖 import：${spec}`)
    }
    // 注释里可以提到参考包用了 jose；这里断言的是**不 import** jose
    assert.ok(!/from\s+['"]jose['"]/.test(src), `${file} 不得 import jose（零依赖红线）`)
  }
})
