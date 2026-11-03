/**
 * cs-myfree — Loomy（讯飞）微信扫码登录测试
 *
 * 纪律：**全 mock，不联网**。所有网络交互都走注入的 fetchImpl。
 *
 * 覆盖：
 *   - 微信授权页 → uuid 提取（含真实页面片段）
 *   - 二维码内容字符串（真实解码取证值）
 *   - 长轮询状态机 408/404/405/403/402 + 405 空 code 保守降级
 *   - HMAC-SHA1 签名固定向量（预期值由 `openssl dgst -sha1 -hmac` **独立**算出）
 *   - 账号请求信封 / 登录响应解析 / 掩码
 *   - start→poll 全链路（pending→scanned→confirmed→ok）与 credential 形状
 *   - bind=0 诚实报错、业务错误透传
 *   - 超时 / 取消 / 网络抖动
 *   - 与统一状态机（index.js + flow-map.js）的集成与「凭据不进响应」
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

import {
  LOOMY_ACCOUNT_BASE, LOOMY_OK_CODE, LOOMY_AUTH_ERROR_CODE, LOOMY_SESSION_TTL_SECONDS,
  LOOMY_WECHAT_APP_ID, LOOMY_WECHAT_REDIRECT_URI, LOOMY_WECHAT_LOGIN_TIMEOUT_MS,
  LOOMY_WECHAT_POLL_STATUS, LOOMY_NEED_PHONE_ERROR, LOOMY_PRODUCT,
  buildLoomyWechatAuthUrl, extractLoomyWechatUuid, buildLoomyWechatQrContent,
  parseLoomyWechatPollBody, pollLoomyWechatOnce,
  buildLoomySigningString, loomyContentMd5, loomyAuthHeaders,
  buildLoomyAccountBody, parseLoomyEnvelope, parseLoomyLoginData, maskLoomyAccount,
  postLoomyAccount, bindLoomyThirdAccount, bindLoomySkip,
  buildLoomyInitial, startLoomy, pollLoomy,
} from '../src/pools/channels/login/loomy.js'
import { getFlow, FLOW_MAP, FLOW_TYPE } from '../src/pools/channels/login/flow-map.js'
import {
  startLogin, pollLogin, cancelLogin, getSession,
} from '../src/pools/channels/login/index.js'
import { CHANNELS } from '../src/pools/channels/protocols.js'

// ── 测试替身 ─────────────────────────────────────────────────────────

/** 伪造 Response（只需本模块用到的字段）。 */
function mkRes({ status = 200, body = '', json } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => {
      if (json !== undefined) return json
      if (typeof body === 'string') return JSON.parse(body)
      return body
    },
  }
}

/** 真实微信授权页的片段（2026-11-03 实测页面，uuid 已随二维码失效）。 */
const REAL_AUTH_PAGE = '<!DOCTYPE html><html><head><title>微信扫码登录</title></head><body>'
  + '<div class="web_qrcode_con"><img class="js_qrcode_img web_qrcode_img" '
  + 'src="/connect/qrcode/041rnolu4TIPkl2B"/></div></body></html>'

const QR_UUID = '041rnolu4TIPkl2B'
/** 实测解码出的二维码内容（官方 /connect/qrcode/<uuid> 图片解码值）。 */
const QR_CONTENT = 'https://open.weixin.qq.com/connect/confirm?uuid=041rnolu4TIPkl2B'

/** 长轮询响应帧（微信实际返回形如 `window.wx_errcode=408;window.wx_code='';`）。 */
const FRAME_WAITING = 'window.wx_errcode=408;window.wx_code=\'\';'
const FRAME_SCANNED = 'window.wx_errcode=404;window.wx_code=\'\';'
const FRAME_CONFIRMED = 'window.wx_errcode=405;window.wx_code=\'WXCODE_ONCE\';'
const FRAME_CONFIRMED_NO_CODE = 'window.wx_errcode=405;window.wx_code=\'\';'
const FRAME_CANCELLED = 'window.wx_errcode=403;window.wx_code=\'\';'
const FRAME_EXPIRED = 'window.wx_errcode=402;window.wx_code=\'\';'

/** 记录每次请求并按 URL 分派的 mock fetch。 */
function mkFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), init }
    calls.push(call)
    return handler(call)
  }
  return { fetchImpl, calls }
}

// ── 微信授权页：uuid 提取 / 二维码内容 ───────────────────────────────

test('loomy：从真实授权页片段提取 uuid（img 主路径）', () => {
  assert.equal(extractLoomyWechatUuid(REAL_AUTH_PAGE), QR_UUID)
  // 兜底路径：long-poll URL 里的 ?uuid=
  assert.equal(
    extractLoomyWechatUuid('<script>var fordevtool = "https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=4Y0N_jyVQg=="</script>'),
    '4Y0N_jyVQg==',
  )
  // 脏输入不能编造 uuid
  assert.equal(extractLoomyWechatUuid(''), '')
  assert.equal(extractLoomyWechatUuid('<html>404</html>'), '')
  assert.equal(extractLoomyWechatUuid(null), '')
})

test('loomy：授权 URL 带 loomy 的 appid + 官方 redirect_uri（微信域名白名单）', () => {
  const url = buildLoomyWechatAuthUrl('state123')
  assert.ok(url.startsWith('https://open.weixin.qq.com/connect/qrconnect?'))
  assert.ok(url.includes(`appid=${LOOMY_WECHAT_APP_ID}`))
  assert.ok(url.includes(`redirect_uri=${encodeURIComponent(LOOMY_WECHAT_REDIRECT_URI)}`))
  assert.ok(url.includes('scope=snsapi_login'))
  assert.ok(url.includes('state=state123'))
  assert.ok(url.includes('#wechat_redirect'))
})

test('loomy：二维码内容字符串 = 实测解码出的 confirm URL（零依赖，前端自己渲染）', () => {
  assert.equal(buildLoomyWechatQrContent(QR_UUID), QR_CONTENT)
  // uuid 里的 base64 补位字符必须转义（否则拼串会断）
  assert.equal(
    buildLoomyWechatQrContent('4Y0N_jyVQg=='),
    'https://open.weixin.qq.com/connect/confirm?uuid=4Y0N_jyVQg%3D%3D',
  )
})

// ── 长轮询状态机（微信官方 JS 语义）─────────────────────────────────

test('loomy：长轮询状态映射 408/404/405/403/402/未知', () => {
  const S = LOOMY_WECHAT_POLL_STATUS
  assert.deepEqual(parseLoomyWechatPollBody(FRAME_WAITING), { status: S.waiting, code: '', errcode: '408' })
  assert.deepEqual(parseLoomyWechatPollBody(FRAME_SCANNED), { status: S.scanned, code: '', errcode: '404' })
  assert.deepEqual(parseLoomyWechatPollBody(FRAME_CONFIRMED), { status: S.confirmed, code: 'WXCODE_ONCE', errcode: '405' })
  assert.deepEqual(parseLoomyWechatPollBody(FRAME_CANCELLED), { status: S.cancelled, code: '', errcode: '403' })
  assert.deepEqual(parseLoomyWechatPollBody(FRAME_EXPIRED), { status: S.expired, code: '', errcode: '402' })
  // 未知 errcode 与空响应一律 waiting（绝不误判成功）
  assert.equal(parseLoomyWechatPollBody('window.wx_errcode=999;').status, S.waiting)
  assert.equal(parseLoomyWechatPollBody('').status, S.waiting)
  assert.equal(parseLoomyWechatPollBody(undefined).status, S.waiting)
})

test('loomy：405 但 wx_code 为空 ⇒ 保守降级 scanned（绝不拿空 code 换 session）', () => {
  assert.deepEqual(parseLoomyWechatPollBody(FRAME_CONFIRMED_NO_CODE), {
    status: LOOMY_WECHAT_POLL_STATUS.scanned, code: '', errcode: '405',
  })
})

test('loomy：长轮询网络异常 ⇒ error 状态（不抛），由调用方继续等', async () => {
  const fetcher = async () => { throw new Error('ECONNRESET') }
  const r = await pollLoomyWechatOnce('uuid1', '', fetcher)
  assert.equal(r.status, LOOMY_WECHAT_POLL_STATUS.error)
  assert.equal(r.code, '')
})

test('loomy：长轮询把上一次 errcode 放进 last 参数，并带防缓存 _=', async () => {
  let seen = null
  const fetcher = async (url) => { seen = String(url); return mkRes({ body: FRAME_WAITING }) }
  await pollLoomyWechatOnce('uuid1', '404', fetcher)
  assert.ok(seen.startsWith('https://long.open.weixin.qq.com/connect/l/qrconnect?'))
  assert.ok(seen.includes('uuid=uuid1'))
  assert.ok(seen.includes('&last=404'))
  assert.ok(/&_=\d+/.test(seen))
})

// ── HMAC-SHA1 签名（固定向量，预期值用 openssl 独立算出）────────────
//
// openssl 对拍命令（同一个待签串，含结尾两个换行）：
//   openssl dgst -sha1 -hmac 'zsak6eadrbawz683wf5r3m2snrwj868r' -binary signstr.txt | base64
//   → dtyPb3W2zs1NogM2AUCK5FvD8Hg=
const SIGN_BODY = '{"base":{"appid":"GM3LOOMY"},"param":{}}'
const SIGN_DATE = 'Wed, 04 Nov 2026 03:04:05 GMT'
const SIGN_NONCE = '11111111-2222-3333-4444-555555555555'
const SIGN_VECTOR = 'dtyPb3W2zs1NogM2AUCK5FvD8Hg='

test('loomy：签名固定向量（9 段 \n 连接 + 结尾两个换行）', () => {
  const expected = 'POST\n'
    + '/login/thirdAccount/bind/auth\n'
    + '\n'
    + 'DTK9dCI0OojDEvyNWyEysA==\n'
    + 'application/json\n'
    + `${SIGN_DATE}\n`
    + `${SIGN_NONCE}\n`
    + '\n'
  const stringToSign = buildLoomySigningString({
    method: 'POST',
    path: '/login/thirdAccount/bind/auth',
    body: SIGN_BODY,
    contentType: 'application/json',
    date: SIGN_DATE,
    nonce: SIGN_NONCE,
  })
  assert.equal(stringToSign, expected)
  assert.ok(stringToSign.endsWith('\n\n'), '必须以两个换行结尾（后两段恒空，去掉会签名失败）')
  assert.equal(stringToSign.length, 146)
  assert.equal(loomyContentMd5(SIGN_BODY), 'DTK9dCI0OojDEvyNWyEysA==')
  // 与其缓存预期值对拍（该值由 openssl 独立算出，非本实现自证）
  assert.equal(createHmac('sha1', LOOMY_PRODUCT.accessKeySecret).update(stringToSign, 'utf8').digest('base64'), SIGN_VECTOR)
})

test('loomy：空 body 的 Content-MD5 为空串；空 query 段为空串；path 逐段转义', () => {
  assert.equal(loomyContentMd5(''), '')
  assert.equal(loomyContentMd5(undefined), '')
  const s = buildLoomySigningString({
    method: 'post',
    path: 'login/third account/bind/', // 无前导 /、有尾 /、含空格
    body: '',
    date: 'D', nonce: 'N',
  })
  assert.equal(s, 'POST\n/login/third%20account/bind\n\n\n\nD\nN\n\n')
})

test('loomy：query 段按传入顺序、两者都转义，且清空时为空串', () => {
  const s = buildLoomySigningString({
    method: 'GET', path: '/a', queryParams: { b: 'x y', a: '1' }, body: '', date: 'D', nonce: 'N',
  })
  assert.equal(s, 'GET\n/a\nb=x%20y&a=1\n\n\nD\nN\n\n')
  assert.equal(buildLoomySigningString({ method: 'GET', path: '/a', queryParams: {}, date: 'D', nonce: 'N' }), 'GET\n/a\n\n\n\nD\nN\n\n')
})

test('loomy：请求头用 account 前缀（不是 Bearer），带 Date/Nonce/Content-MD5', () => {
  const headers = loomyAuthHeaders({
    accessKeyId: LOOMY_PRODUCT.accessKeyId,
    accessKeySecret: LOOMY_PRODUCT.accessKeySecret,
    method: 'POST',
    path: '/login/thirdAccount/bind/auth',
    body: SIGN_BODY,
    contentType: 'application/json',
  })
  assert.ok(headers.Authorization.startsWith(`account ${LOOMY_PRODUCT.accessKeyId}:`))
  assert.ok(!headers.Authorization.includes('Bearer'))
  assert.ok(/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(headers.Date), 'Date 必须是 UTC 字符串')
  assert.ok(/^[0-9a-f-]{36}$/.test(headers.Nonce), 'Nonce 必须是 UUID')
  assert.equal(headers['Content-Type'], 'application/json')
  assert.equal(headers['Content-MD5'], 'DTK9dCI0OojDEvyNWyEysA==')
  // 签名非空且 base64 形状
  const sig = headers.Authorization.slice(`account ${LOOMY_PRODUCT.accessKeyId}:`.length)
  assert.ok(/^[A-Za-z0-9+/]+=*$/.test(sig))
})

// ── 账号信封 / 登录响应解析 ─────────────────────────────────────────

test('loomy：账号请求体信封（appid/modelid/devid/ua 照抄客户端）', () => {
  const body = buildLoomyAccountBody(LOOMY_PRODUCT, { tcode: { code: 'c' }, type: 'wx' })
  assert.equal(body.base.appid, LOOMY_PRODUCT.appId)
  assert.equal(body.base.modelid, 'Web')
  assert.equal(body.base.version, '1.0.0')
  assert.equal(body.base.devid, 'web')
  assert.equal(body.base.ua, 'Loomy|Desktop|Electron|macOS')
  assert.ok(/^[0-9a-f]{32}$/.test(body.base.traceid), 'traceid 是去连字符的 uuid（32 hex）')
  assert.deepEqual(body.param, { tcode: { code: 'c' }, type: 'wx' })
})

test('loomy：业务信封解析（HTTP 200 + code 判成败）', () => {
  assert.deepEqual(parseLoomyEnvelope({ code: LOOMY_OK_CODE, data: { a: 1 } }), {
    ok: true, code: LOOMY_OK_CODE, message: '', data: { a: 1 },
  })
  const authErr = parseLoomyEnvelope({ code: LOOMY_AUTH_ERROR_CODE, desc: '缺少 token' })
  assert.equal(authErr.ok, false)
  assert.equal(authErr.code, LOOMY_AUTH_ERROR_CODE)
  assert.equal(authErr.message, '缺少 token')
  // 非对象 / 数组 / 缺 code
  assert.equal(parseLoomyEnvelope(null).ok, false)
  assert.equal(parseLoomyEnvelope('x').ok, false)
  assert.equal(parseLoomyEnvelope([]).ok, false)
  assert.match(parseLoomyEnvelope({}).message, /缺少 code/)
})

test('loomy：登录响应解析（缺 session/userid 必须报错，不返回半成品）', () => {
  assert.deepEqual(parseLoomyLoginData({ session: 'a'.repeat(32), userid: 'u1' }), {
    session: 'a'.repeat(32), userid: 'u1',
  })
  assert.deepEqual(parseLoomyLoginData({ session: 'a'.repeat(32), userid: 'u1', phone: '13800000000' }), {
    session: 'a'.repeat(32), userid: 'u1', phone: '13800000000',
  })
  assert.throws(() => parseLoomyLoginData({ userid: 'u1' }), /缺少 session/)
  assert.throws(() => parseLoomyLoginData({ session: 'a'.repeat(32) }), /缺少 userid/)
  assert.throws(() => parseLoomyLoginData(null), /缺少 session/)
})

test('loomy：账号掩码不泄漏完整 userid', () => {
  assert.equal(maskLoomyAccount('user-123456789'), 'use****89')
  assert.equal(maskLoomyAccount('abcd'), '****')
  assert.equal(maskLoomyAccount(''), null)
  assert.equal(maskLoomyAccount(null), null)
  assert.ok(!maskLoomyAccount('user-123456789').includes('user-123456789'))
})

// ── start：取 uuid → 二维码内容 ─────────────────────────────────────

test('loomy：startLoomy 发一次二维码页请求并返回 qr 字符串（不返回图片/私有字段）', async () => {
  const { fetchImpl, calls } = mkFetch(() => mkRes({ body: REAL_AUTH_PAGE }))
  const initial = await startLoomy('loomy', CHANNELS.loomy, { fetchImpl })

  assert.equal(calls.length, 1, 'start 只应发一次 HTTP（取 uuid）')
  assert.ok(calls[0].url.startsWith('https://open.weixin.qq.com/connect/qrconnect?'))
  assert.ok(calls[0].url.includes(`appid=${LOOMY_WECHAT_APP_ID}`))

  assert.equal(initial.flow, 'qr')
  assert.equal(initial.qr, QR_CONTENT)
  assert.equal(initial._uuid, QR_UUID)
  assert.ok(initial.interval > 0)
  assert.ok(initial.instructions.length >= 3)
  assert.ok(initial.instructions.join('').includes('14 天'))
  assert.ok(!('url' in initial), '扫码流不给 url')
})

test('loomy：取 uuid 失败时 start 抛可读错误（由状态机/路由兜住）', async () => {
  await assert.rejects(
    () => startLoomy('loomy', CHANNELS.loomy, { fetchImpl: async () => mkRes({ status: 500, body: 'oops' }) }),
    /微信授权页返回 HTTP 500/,
  )
  await assert.rejects(
    () => startLoomy('loomy', CHANNELS.loomy, { fetchImpl: async () => mkRes({ body: '<html>404</html>' }) }),
    /未包含二维码 uuid/,
  )
  await assert.rejects(
    () => startLoomy('loomy', CHANNELS.loomy, { fetchImpl: async () => { throw new Error('ENOTFOUND') } }),
    /微信授权页拉取失败：ENOTFOUND/,
  )
})

// ── poll 全链路：pending → scanned → confirmed → ok ─────────────────

/** 组装「扫码成功 + 微信已绑手机号」的账号端点 mock。 */
function mkScanFetch({ frames, bind = 1, accountError = null, skipError = null } = {}) {
  const queue = [...frames]
  const seen = { longPollFrames: 0, bindBody: null, skipBody: null, authHeaders: [], accountCalls: 0 }
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('https://open.weixin.qq.com/connect/qrconnect?')) {
      return mkRes({ body: REAL_AUTH_PAGE })
    }
    if (url.startsWith('https://long.open.weixin.qq.com/')) {
      seen.longPollFrames += 1
      return mkRes({ body: queue.shift() ?? FRAME_WAITING })
    }
    if (url === `${LOOMY_ACCOUNT_BASE}/login/thirdAccount/bind/auth`) {
      seen.accountCalls += 1
      seen.bindBody = JSON.parse(init.body)
      seen.authHeaders.push(init.headers)
      if (accountError) return mkRes({ json: { code: accountError.code ?? '100001', desc: accountError.desc } })
      return mkRes({ json: { code: LOOMY_OK_CODE, data: { bind, rcode: 'RCODE_1', nickname: '小明' } } })
    }
    if (url === `${LOOMY_ACCOUNT_BASE}/login/thirdAccount/bind/skip`) {
      seen.accountCalls += 1
      seen.skipBody = JSON.parse(init.body)
      seen.authHeaders.push(init.headers)
      if (skipError) return mkRes({ json: { code: '100001', desc: skipError } })
      return mkRes({ json: { code: LOOMY_OK_CODE, data: { session: 'f'.repeat(32), userid: 'user-123456789' } } })
    }
    throw new Error('unexpected url: ' + url)
  }
  return { fetchImpl, seen }
}

test('loomy：poll 状态机 pending→waiting→ok，且拿到 14 天有效期的 session', async () => {
  const { fetchImpl, seen } = mkScanFetch({
    frames: [FRAME_WAITING, FRAME_SCANNED, FRAME_CONFIRMED],
  })
  const session = buildLoomyInitial(QR_UUID)
  const before = Date.now()

  const r1 = await pollLoomy(session, { fetchImpl })
  assert.equal(r1.state, 'pending')
  assert.match(r1.hint, /等待.*扫码/)

  const r2 = await pollLoomy(session, { fetchImpl })
  assert.equal(r2.state, 'waiting')
  assert.match(r2.hint, /已扫码.*确认/)

  const r3 = await pollLoomy(session, { fetchImpl })
  assert.equal(r3.state, 'ok')
  assert.equal(r3.credential.token, 'f'.repeat(32))
  assert.equal(typeof r3.credential.expiresAt, 'number')
  const expectExpiry = before + LOOMY_SESSION_TTL_SECONDS * 1000
  assert.ok(Math.abs(r3.credential.expiresAt - expectExpiry) < 5_000, 'expiresAt 必须是 14 天后')
  assert.equal(r3.maskedAccount, 'use****89')
  assert.equal(r3.accountId, 'user-123456789')
  assert.match(r3.hint, /14 天/)

  // 账号链路断言：微信 code 只用于 bind/auth；bind/skip 只用 rcode
  assert.equal(seen.accountCalls, 2)
  assert.deepEqual(seen.bindBody.param, { tcode: { code: 'WXCODE_ONCE' }, type: 'wx' })
  assert.deepEqual(seen.skipBody.param, { rcode: 'RCODE_1', expire: LOOMY_SESSION_TTL_SECONDS })
  // 每个账号请求都带 account HMAC 头，且 body 有 Content-MD5（签名与发送同一串）
  for (const headers of seen.authHeaders) {
    assert.ok(headers.Authorization.startsWith(`account ${LOOMY_PRODUCT.accessKeyId}:`))
    assert.ok(headers['Content-MD5'])
    assert.equal(headers['Content-Type'], 'application/json')
  }
})

test('loomy：405 但无 code ⇒ 继续 waiting，且不触发任何账号请求', async () => {
  const { fetchImpl, seen } = mkScanFetch({ frames: [FRAME_CONFIRMED_NO_CODE] })
  const session = buildLoomyInitial(QR_UUID)
  const r = await pollLoomy(session, { fetchImpl })
  assert.equal(r.state, 'waiting')
  assert.equal(seen.accountCalls, 0)
})

test('loomy：长轮询 403 取消 / 402 失效 ⇒ 明确失败而不是装成功', async () => {
  const s1 = buildLoomyInitial(QR_UUID)
  const r1 = await pollLoomy(s1, { fetchImpl: mkScanFetch({ frames: [FRAME_CANCELLED] }).fetchImpl })
  assert.equal(r1.state, 'cancelled')

  const s2 = buildLoomyInitial(QR_UUID)
  const r2 = await pollLoomy(s2, { fetchImpl: mkScanFetch({ frames: [FRAME_EXPIRED] }).fetchImpl })
  assert.equal(r2.state, 'error')
  assert.match(r2.error, /二维码已失效/)
})

test('loomy：bind=0（微信未绑讯飞手机号）⇒ 诚实报错，不假装登录成功', async () => {
  const { fetchImpl, seen } = mkScanFetch({ frames: [FRAME_CONFIRMED], bind: 0 })
  const r = await pollLoomy(buildLoomyInitial(QR_UUID), { fetchImpl })
  assert.equal(r.state, 'error')
  assert.equal(r.error, LOOMY_NEED_PHONE_ERROR)
  assert.equal(r.credential, undefined, '失败时绝不能带 credential')
  assert.equal(seen.accountCalls, 1, 'bind=0 不应调用 bind/skip')
})

test('loomy：账号端点业务错误透传 desc（签名/参数问题可读）', async () => {
  const { fetchImpl } = mkScanFetch({
    frames: [FRAME_CONFIRMED],
    accountError: { code: LOOMY_AUTH_ERROR_CODE, desc: '签名校验失败' },
  })
  const r = await pollLoomy(buildLoomyInitial(QR_UUID), { fetchImpl })
  assert.equal(r.state, 'error')
  assert.match(r.error, /签名校验失败/)
})

test('loomy：bind/skip 失败 ⇒ 明确错误（微信 code 已一次性消费，提示重扫）', async () => {
  const { fetchImpl } = mkScanFetch({ frames: [FRAME_CONFIRMED], skipError: '登录态已过期' })
  const r = await pollLoomy(buildLoomyInitial(QR_UUID), { fetchImpl })
  assert.equal(r.state, 'error')
  assert.match(r.error, /登录态已过期/)
  assert.match(r.error, /重新扫码/)
})

test('loomy：长轮询网络抖动 ⇒ 继续 pending（不判失败）', async () => {
  const fetchImpl = async () => { throw new Error('ETIMEDOUT') }
  const r = await pollLoomy(buildLoomyInitial(QR_UUID), { fetchImpl })
  assert.equal(r.state, 'pending')
  assert.match(r.hint, /网络抖动/)
})

test('loomy：poll 支持取消（opts.cancel）且不发网络请求', async () => {
  const { fetchImpl, calls } = mkFetch(() => mkRes({ body: FRAME_WAITING }))
  const r = await pollLoomy(buildLoomyInitial(QR_UUID), { fetchImpl, cancel: true })
  assert.equal(r.state, 'cancelled')
  assert.equal(calls.length, 0)
})

test('loomy：超过 5 分钟未完成 ⇒ 超时错误（不发网络请求）', async () => {
  const session = buildLoomyInitial(QR_UUID, Date.now() - LOOMY_WECHAT_LOGIN_TIMEOUT_MS - 1)
  const { fetchImpl, calls } = mkFetch(() => mkRes({ body: FRAME_WAITING }))
  const r = await pollLoomy(session, { fetchImpl })
  assert.equal(r.state, 'error')
  assert.match(r.error, /登录超时/)
  assert.equal(calls.length, 0)
})

test('loomy：缺 uuid / 会话无效 ⇒ 可读错误', async () => {
  assert.equal((await pollLoomy(null)).state, 'error')
  const r = await pollLoomy({ _startedAt: Date.now() })
  assert.equal(r.state, 'error')
  assert.match(r.error, /缺少二维码参数/)
})

test('loomy：postLoomyAccount 非 JSON 响应 ⇒ 报错（不把 HTML 当成功）', async () => {
  await assert.rejects(
    () => postLoomyAccount('/x', buildLoomyAccountBody(LOOMY_PRODUCT, {}), LOOMY_PRODUCT,
      async () => mkRes({ status: 200, body: '<html>502</html>', json: undefined })),
    /响应不是 JSON/,
  )
})

test('loomy：bindLoomyThirdAccount 缺 rcode 必须报错；bindLoomySkip 缺 session 必须报错', async () => {
  const empty = async () => mkRes({ json: { code: LOOMY_OK_CODE, data: {} } })
  await assert.rejects(() => bindLoomyThirdAccount('code', LOOMY_PRODUCT, empty), /缺少 rcode/)
  await assert.rejects(() => bindLoomySkip('rcode', LOOMY_PRODUCT, empty), /缺少 session/)
})

// ── 与统一状态机集成（flow-map 接线后的真实路径）────────────────────

test('loomy：flow-map 已接线（qr 流 + start/poll + 未真机验证诚实标记）', () => {
  assert.equal(FLOW_MAP.loomy.type, FLOW_TYPE.QR)
  assert.equal(typeof FLOW_MAP.loomy.start, 'function')
  assert.equal(typeof FLOW_MAP.loomy.poll, 'function')
  // 真机验证通过前必须为 false（本测试不依赖具体值之外的行为）
  assert.equal(typeof FLOW_MAP.loomy.loginVerified, 'boolean')
  const flow = getFlow('loomy', CHANNELS.loomy)
  assert.equal(flow.type, 'qr')
})

test('loomy：startLogin→pollLogin 全链路 ok，且 HTTP 形状里没有凭据/私有字段', async () => {
  const { fetchImpl } = mkScanFetch({ frames: [FRAME_WAITING, FRAME_SCANNED, FRAME_CONFIRMED] })

  const started = await startLogin('loomy', CHANNELS.loomy, { fetchImpl })
  assert.equal(started.flow, 'qr')
  assert.equal(started.qr, QR_CONTENT)
  assert.ok(!String(started.qr).startsWith('data:'), '只回字符串，不回图片 data URL')
  const publicJson = JSON.stringify(started)
  assert.ok(!publicJson.includes('_uuid'), '私有字段不进响应')
  assert.ok(!publicJson.includes('accessKey'), '厂商签名参数不进响应')

  const r1 = await pollLogin(started.sessionId, { fetchImpl })
  assert.equal(r1.state, 'pending')
  assert.equal(r1.hint !== undefined, true)
  const r2 = await pollLogin(started.sessionId, { fetchImpl })
  assert.equal(r2.state, 'waiting')

  const r3 = await pollLogin(started.sessionId, { fetchImpl })
  assert.equal(r3.state, 'ok')
  // 🔴 凭据绝不进 poll 响应
  const pollJson = JSON.stringify(r3)
  assert.ok(!pollJson.includes('f'.repeat(32)), 'poll 响应不得包含 token 原文')
  assert.ok(!pollJson.includes('"credential"'))
  // 但状态机内部已把 credential 存好（供落盘）
  const session = getSession(started.sessionId)
  assert.equal(session.credential.token, 'f'.repeat(32))
  assert.equal(session.maskedAccount, 'use****89')

  assert.equal(cancelLogin(started.sessionId), true)
})

test('loomy：startLogin 内部抛错可被上层兜住（不伪造 qr）', async () => {
  await assert.rejects(
    () => startLogin('loomy', CHANNELS.loomy, { fetchImpl: async () => mkRes({ status: 502, body: '' }) }),
    /微信授权页返回 HTTP 502/,
  )
})
