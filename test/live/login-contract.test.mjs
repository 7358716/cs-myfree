/**
 * cs-myfree 登录契约的**真实服务**端到端测试（专职测试 B / task-12）
 *
 * 目的：单元测试用 mock flow，容易与真实装配漂移。本文件直接打一个
 * **隔离实例**（不是生产 3080），断言设置页依赖的登录契约在真机装配下成立。
 *
 * 覆盖：
 *   ① /login/status 18 家字段齐全
 *   ② /login/start（codearts）url 里 auth_callback_url 必须是公网地址，绝不能含 127.0.0.1
 *   ③ /login/poll 各状态字段齐全且**不含 credential**
 *   ④ /login/cancel /login/test /login/refresh /accounts/remove
 *   ⑤ /channels 每项带 loginVerified/loginNote/flow；accounts 只回 masked
 *   ⑥ 鉴权矩阵：真实 cookie=200 / 伪造 cookie=401 / 无 cookie=401 / 跨源=403 / 回环 localhost=200
 *   ⑦ GET /login/callback?state=bad → 200 且是友好 HTML（不是 JSON 栈）
 *   ⑧ 旧接口不回归：/state /chain /config /scope /ledger /diag /channels/models
 *
 * 安全边界：
 *   · 只读 + 幂等写（start/cancel 会话、remove 一个**不存在**的 id）
 *   · 不写 ~/.dsh/profiles/web、不碰生产 3080
 *   · 不打印任何凭据明文
 *
 * 运行：
 *   CS_MYFREE_BASE=http://127.0.0.1:3199 \
 *   CS_MYFREE_PUBLIC_HOST=150.158.175.241 \
 *   CS_MYFREE_COOKIE_FILE=/tmp/lt-cookie.txt \
 *   node --test test/live/login-contract.test.mjs
 *
 * 环境变量缺一即整组 skip（本机没起隔离实例不应红）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'

const BASE = process.env.CS_MYFREE_BASE || ''
const PUBLIC_HOST = process.env.CS_MYFREE_PUBLIC_HOST || ''
const COOKIE_FILE = process.env.CS_MYFREE_COOKIE_FILE || ''
const TIMEOUT = Number(process.env.CS_MYFREE_TIMEOUT_MS || 12_000)

/** 从 curl cookie jar 解析出真实会话 cookie（Netscape 格式） */
function loadCookie() {
  if (!COOKIE_FILE) return ''
  try {
    return readFileSync(COOKIE_FILE, 'utf8')
      .split('\n')
      // 🔑 curl 把 HttpOnly cookie 写成 `#HttpOnly_<domain>` 前缀，看着像注释但其实是数据行
      .map((l) => l.replace(/^#HttpOnly_/, ''))
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split('\t'))
      .filter((c) => c.length >= 7 && /^dsh-auth-/.test(c[5]))
      .map((c) => `${c[5]}=${c[6]}`)
      .join('; ')
  } catch { return '' }
}
const COOKIE = loadCookie()

/**
 * 发一次请求。
 * @param {string} path
 * @param {{method?:string, body?:any, host?:string, cookie?:string, origin?:string, direct?:boolean}} o
 */
async function req(path, o = {}) {
  // 🔴 必须用 node:http 而不是 fetch：Node 的 fetch(undici) 会按 URL 覆盖 Host 头，
  //    结果「Host: 公网地址」的鉴权矩阵测不出来（实测：设置 headers.host 无效）。
  const headers = { 'content-type': 'application/json' }
  if (o.host !== null) headers.host = o.host ?? PUBLIC_HOST
  const cookie = o.cookie !== undefined ? o.cookie : COOKIE
  if (cookie) headers.cookie = cookie
  if (o.origin) headers.origin = o.origin
  const body = o.body === undefined ? undefined : JSON.stringify(o.body)
  if (body !== undefined) headers['content-length'] = Buffer.byteLength(body)

  const u = new URL(BASE + path)
  return await new Promise((resolve, reject) => {
    const r = httpRequest({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: o.method ?? 'GET',
      headers,
      timeout: TIMEOUT,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* HTML/空体 */ }
        resolve({ status: res.statusCode, json, text, type: String(res.headers['content-type'] ?? '') })
      })
    })
    r.on('timeout', () => { r.destroy(new Error('timeout')) })
    r.on('error', reject)
    if (body !== undefined) r.write(body)
    r.end()
  })
}

// ── 探活（一次）；不可达 / 缺 cookie 则全组 skip ──
let LIVE = false
let LIVE_ERR = ''
if (!BASE || !PUBLIC_HOST) {
  LIVE_ERR = '未设置 CS_MYFREE_BASE / CS_MYFREE_PUBLIC_HOST（隔离实例坐标）'
} else if (!COOKIE) {
  LIVE_ERR = `未从 ${COOKIE_FILE || '(未设置 CS_MYFREE_COOKIE_FILE)'} 读到 dsh-auth cookie`
} else {
  try {
    const r = await req('/cs-myfree/health')
    LIVE = r.status === 200 && r.json?.ok === true
    if (!LIVE) LIVE_ERR = `HTTP ${r.status} ${r.text.slice(0, 120)}`
  } catch (e) {
    LIVE_ERR = String((e && e.message) || e)
  }
}
const liveTest = (name, fn) => test(name, { skip: LIVE ? false : `真实服务不可用（${LIVE_ERR}）` }, fn)

/** 断言响应体里不出现任何凭据类字段名/键值 */
function assertNoCredential(body, label) {
  const s = JSON.stringify(body ?? {})
  assert.ok(!/"(credential|access_token|refresh_token|apiKey|api_key|securityToken|sk|secret)"\s*:/.test(s),
    `${label} 响应里出现凭据字段名：${s.slice(0, 200)}`)
  // credential 原文只在 session 私有字段，绝不能出现在任何响应
  assert.ok(!/"_secret"|"_ticketId"|"_keyPair"|"_pkce"|"_deviceCode"/.test(s),
    `${label} 响应里出现会话私有字段：${s.slice(0, 200)}`)
}

// ══════════════════════════════════════════════════════════════════
// ① /login/status
// ══════════════════════════════════════════════════════════════════
liveTest('① GET /login/status：18 家渠道 + 每字段齐全', async () => {
  const r = await req('/cs-myfree/login/status')
  assert.equal(r.status, 200)
  const d = r.json
  assert.equal(d.ok, true)
  assert.equal(d.total, 18, '必须 18 家渠道')
  assert.equal(d.channels.length, 18)
  assert.ok(Array.isArray(d.verified) && Array.isArray(d.unverified))
  assert.equal(d.verified.length + d.unverified.length, 18)

  for (const c of d.channels) {
    assert.equal(typeof c.id, 'string', 'id 缺')
    assert.equal(typeof c.flow, 'string', `${c.id} flow 缺`)
    assert.equal(typeof c.loginVerified, 'boolean', `${c.id} loginVerified 必须是布尔（UI 徽标依据）`)
    assert.equal(typeof c.note, 'string', `${c.id} note 缺`)
    assert.equal(typeof c.refreshable, 'boolean', `${c.id} refreshable 缺`)
    assert.ok(['browser', 'device', 'qr', 'paste', 'aksk'].includes(c.flow), `${c.id} flow 非法：${c.flow}`)
  }
  // codearts 是唯一真机验证的
  assert.ok(d.verified.includes('codearts'), 'codearts 必须 loginVerified=true')
  assertNoCredential(d, '/login/status')
})

// ══════════════════════════════════════════════════════════════════
// ② /login/start（最关键回归点：公网回调）
// ══════════════════════════════════════════════════════════════════
liveTest('② POST /login/start codearts：字段齐全 + 公网回调（绝不含 127.0.0.1）', async () => {
  const r = await req('/cs-myfree/login/start', { method: 'POST', body: { provider: 'codearts' } })
  assert.equal(r.status, 200)
  const d = r.json
  assert.equal(d.ok, true, `start 失败：${d.error ?? r.text.slice(0, 160)}`)
  assert.equal(d.flow, 'browser')
  assert.ok(d.sessionId, 'sessionId 必须有')
  assert.ok(Array.isArray(d.instructions) && d.instructions.length > 0, 'instructions 必须非空')
  assert.equal(typeof d.loginVerified, 'boolean')
  assert.equal(typeof d.loginNote, 'string')
  assert.ok(d.loginVerified === true, 'codearts 必须标已验证')
  assert.ok(d.callbackUrl, 'callbackUrl 必须有（browser 流）')

  // 🔴 本次最关键的回归点
  const all = JSON.stringify(d)
  assert.ok(!/127\.0\.0\.1|localhost/.test(all),
    `响应里出现回环地址（远程部署下浏览器会跳到用户自己的机器）：${all.slice(0, 300)}`)
  assert.ok(d.callbackUrl.includes('/cs-myfree/login/callback'), 'callbackUrl 必须指向 /cs-myfree/login/callback')
  assert.match(d.callbackUrl, /^https?:\/\/150\.158\.175\.241/, 'callbackUrl 必须是公网地址')

  // 解出内层 auth_callback_url，确认也是公网 + 带一次性 state
  const svc = new URL(d.url).searchParams.get('service')
  assert.ok(svc, 'url 必须带 service 参数')
  const inner = new URL(svc).searchParams.get('auth_callback_url')
  assert.ok(inner, 'service 里必须带 auth_callback_url')
  assert.ok(!/127\.0\.0\.1|localhost/.test(inner), `auth_callback_url 含回环地址：${inner}`)
  assert.match(inner, /\/cs-myfree\/login\/callback\?state=/, 'auth_callback_url 必须带一次性 state')
  assertNoCredential(d, '/login/start')
})

liveTest('②b POST /login/start 全 18 家：均返回 sessionId，且无回环地址', async () => {
  const ids = (await req('/cs-myfree/login/status')).json.channels.map((c) => c.id)
  const bad = []
  for (const id of ids) {
    const r = await req('/cs-myfree/login/start', { method: 'POST', body: { provider: id } })
    if (r.json?.ok !== true || !r.json.sessionId) { bad.push(`${id}: ${r.json?.error ?? r.status}`); continue }
    if (/127\.0\.0\.1/.test(JSON.stringify(r.json))) bad.push(`${id}: 含回环地址`)
    if (!['browser', 'device', 'qr', 'paste', 'aksk'].includes(r.json.flow)) bad.push(`${id}: flow=${r.json.flow}`)
  }
  assert.deepEqual(bad, [], `以下渠道 start 异常：${bad.join(' | ')}`)
})

liveTest('②c POST /login/start 未知渠道 / 缺 provider：友好报错', async () => {
  const a = await req('/cs-myfree/login/start', { method: 'POST', body: { provider: 'nope' } })
  assert.equal(a.status, 200)
  assert.equal(a.json.ok, false)
  assert.match(a.json.error, /未知渠道/)
  const b = await req('/cs-myfree/login/start', { method: 'POST', body: {} })
  assert.equal(b.json.ok, false)
  assert.match(b.json.error, /缺少 provider/)
})

// ══════════════════════════════════════════════════════════════════
// ③ /login/poll 各状态
// ══════════════════════════════════════════════════════════════════
liveTest('③ GET /login/poll：waiting 状态字段齐全且不含 credential', async () => {
  const s = (await req('/cs-myfree/login/start', { method: 'POST', body: { provider: 'codearts' } })).json
  const r = await req(`/cs-myfree/login/poll?sessionId=${encodeURIComponent(s.sessionId)}`)
  assert.equal(r.status, 200)
  const d = r.json
  assert.ok(['pending', 'waiting', 'ok', 'error'].includes(d.state), `state 非法：${d.state}`)
  for (const k of ['ok', 'state', 'hint', 'maskedAccount', 'error']) {
    assert.ok(k in d, `poll 响应缺 ${k}`)
  }
  assert.equal(typeof d.ok, 'boolean')
  assert.equal(typeof d.hint, 'string')
  assert.equal(d.maskedAccount, null, '尚未登录成功时 maskedAccount 必须是 null')
  assertNoCredential(d, '/login/poll')
  // 清理
  await req('/cs-myfree/login/cancel', { method: 'POST', body: { sessionId: s.sessionId } })
})

liveTest('③b GET /login/poll：会话不存在 / 缺参数 的返回', async () => {
  const a = await req('/cs-myfree/login/poll?sessionId=no-such-session-id')
  assert.equal(a.status, 200)
  assert.equal(a.json.ok, false)
  assert.equal(a.json.state, 'error', '不存在的会话 state 必须是 error')
  assert.ok(a.json.error, '必须给出 error 文案')
  assertNoCredential(a.json, '/login/poll(不存在)')

  const b = await req('/cs-myfree/login/poll')
  assert.equal(b.json.ok, false)
  assert.match(b.json.error, /缺少 sessionId/)
})

liveTest('③c GET /login/poll：取消后的会话不再是 waiting', async () => {
  const s = (await req('/cs-myfree/login/start', { method: 'POST', body: { provider: 'codearts' } })).json
  const c = await req('/cs-myfree/login/cancel', { method: 'POST', body: { sessionId: s.sessionId } })
  assert.equal(c.json.ok, true)
  assert.equal(c.json.cancelled, true)
  const p = await req(`/cs-myfree/login/poll?sessionId=${encodeURIComponent(s.sessionId)}`)
  assert.equal(p.json.ok, false, '取消后 poll 必须 ok:false')
  assert.equal(p.json.state, 'error', '取消后会话已销毁 ⇒ error（且不得再回 waiting）')
})

// ══════════════════════════════════════════════════════════════════
// ④ cancel / test / refresh / remove
// ══════════════════════════════════════════════════════════════════
liveTest('④a POST /login/cancel：幂等（第二次 ok:false 但不报错）', async () => {
  const s = (await req('/cs-myfree/login/start', { method: 'POST', body: { provider: 'qoder' } })).json
  const a = await req('/cs-myfree/login/cancel', { method: 'POST', body: { sessionId: s.sessionId } })
  assert.equal(a.status, 200)
  assert.equal(a.json.ok, true)
  const b = await req('/cs-myfree/login/cancel', { method: 'POST', body: { sessionId: s.sessionId } })
  assert.equal(b.status, 200)
  assert.equal(b.json.ok, false, '二次取消 ok:false')
  assert.equal(b.json.cancelled, false)
  const c = await req('/cs-myfree/login/cancel', { method: 'POST', body: {} })
  assert.equal(c.json.ok, false)
  assert.match(c.json.error, /缺少 sessionId/)
})

liveTest('④b POST /login/test：未登录渠道给 AUTH 分类（不发假请求）', async () => {
  const r = await req('/cs-myfree/login/test', { method: 'POST', body: { provider: 'qiniu' } })
  assert.equal(r.status, 200)
  const d = r.json
  assert.equal(d.ok, false)
  assert.equal(d.provider, 'qiniu')
  assert.equal(d.kind, 'AUTH', `失败必须分类，实际 kind=${d.kind}`)
  assert.ok(typeof d.ms === 'number', 'ms 必须是数字')
  assertNoCredential(d, '/login/test')

  const m = await req('/cs-myfree/login/test', { method: 'POST', body: {} })
  assert.equal(m.json.ok, false)
  assert.match(m.json.error, /缺少 provider 或 id/)
})

liveTest('④c POST /login/refresh：loomy 如实提示需人工重登', async () => {
  const r = await req('/cs-myfree/login/refresh', { method: 'POST', body: { provider: 'loomy' } })
  assert.equal(r.status, 200)
  const d = r.json
  assert.equal(d.ok, false, 'loomy 无续期端点时必须 ok:false')
  assert.match(d.error, /无续期端点/)
  assert.equal(d.reloginRequired, true, 'loomy 必须明确提示需人工重登')
  assert.ok(/人工重登|重登/.test(d.note ?? ''), `note 必须说清需人工重登：${d.note}`)
  assertNoCredential(d, '/login/refresh')

  const u = await req('/cs-myfree/login/refresh', { method: 'POST', body: { provider: 'nope' } })
  assert.equal(u.json.ok, false)
  assert.match(u.json.error, /未知渠道/)
})

liveTest('④d POST /accounts/remove：删除 + 幂等 + 剩余数量', async () => {
  const before = (await req('/cs-myfree/channels')).json.channels
    .reduce((n, c) => n + (c.accounts?.length ?? 0), 0)

  // 先造一条账号（qiniu paste 渠道），再删掉，验证 remaining 真实递减
  const fake = `test-${Date.now()}`
  const saved = await req('/cs-myfree/channels/save', {
    method: 'POST',
    body: { provider: 'qiniu', credential: fake, id: `lt-${Date.now()}` },
  })
  assert.equal(saved.json.ok, true, `造账号失败：${saved.json.error}`)
  const id = saved.json.id

  const r1 = await req('/cs-myfree/accounts/remove', { method: 'POST', body: { id } })
  assert.equal(r1.status, 200)
  assert.equal(r1.json.ok, true)
  assert.equal(typeof r1.json.remaining, 'number')
  assert.ok(r1.json.remaining < before + 1, 'remaining 必须反映删除后数量')

  // 幂等：再删一次不报 500，ok:false + 数量不变
  const r2 = await req('/cs-myfree/accounts/remove', { method: 'POST', body: { id } })
  assert.equal(r2.status, 200)
  assert.equal(r2.json.ok, false, '二次删除 ok:false')
  assert.equal(r2.json.remaining, r1.json.remaining, '二次删除不得改变剩余数量')

  const miss = await req('/cs-myfree/accounts/remove', { method: 'POST', body: {} })
  assert.equal(miss.json.ok, false)
  assert.match(miss.json.error, /缺少 id/)
})

// ══════════════════════════════════════════════════════════════════
// ⑤ /channels 契约
// ══════════════════════════════════════════════════════════════════
liveTest('⑤ GET /channels：每项带 loginVerified/loginNote/flow，accounts 只回 masked', async () => {
  const r = await req('/cs-myfree/channels')
  assert.equal(r.status, 200)
  const d = r.json
  assert.equal(d.ok, true)
  assert.equal(d.total, 18)
  assert.equal(d.channels.length, 18)
  for (const c of d.channels) {
    assert.equal(typeof c.loginVerified, 'boolean', `${c.id} loginVerified 缺`)
    assert.equal(typeof c.loginNote, 'string', `${c.id} loginNote 缺`)
    assert.ok('flow' in c, `${c.id} flow 缺`)
    for (const a of c.accounts ?? []) {
      assert.ok('masked' in a, `${c.id} 账号缺 masked`)
      assert.ok(!/"(credential|ak|sk|securityToken|token)"/.test(JSON.stringify(a)),
        `${c.id} 账号响应里出现凭据字段名：${JSON.stringify(a)}`)
    }
  }
  assertNoCredential(d, '/channels')
})

// ══════════════════════════════════════════════════════════════════
// ⑥ 鉴权矩阵
// ══════════════════════════════════════════════════════════════════
liveTest('⑥ 鉴权矩阵：cookie × Host × Origin', async () => {
  // 真实 cookie + 公网 Host → 200
  const t1 = await req('/cs-myfree/health')
  assert.equal(t1.status, 200, '真实 cookie + 公网 Host 应 200')

  // 伪造 cookie + 公网 Host → 401
  const t2 = await req('/cs-myfree/health', { cookie: 'dsh-auth-forged' })
  assert.equal(t2.status, 401, '伪造 cookie 必须 401')
  assert.equal(t2.json?.ok, false)

  // 无 cookie + 公网 Host → 401
  const t3 = await req('/cs-myfree/health', { cookie: '' })
  assert.equal(t3.status, 401, '无 cookie 必须 401')

  // 跨源 Origin → 403（即使带真实 cookie）
  const t4 = await req('/cs-myfree/health', { origin: 'http://evil.example.com' })
  assert.equal(t4.status, 403, '跨源必须 403')

  // 未知 Host → 403
  const t5 = await req('/cs-myfree/health', { host: 'evil.example.com' })
  assert.equal(t5.status, 403, '不可信 Host 必须 403')
})

liveTest('⑥b 直连回环 + Host: localhost → 200（本机管理员通道）', async () => {
  // 用 IP 直连（socket.remoteAddress = 127.0.0.1），Host 头写 localhost
  const r = await req('/cs-myfree/health', { host: 'localhost', cookie: '' })
  assert.equal(r.status, 200, '回环 + localhost 应放行')
  assert.equal(r.json.ok, true)
})

liveTest('⑥c 写接口鉴权：伪造 cookie 的 POST 一律 401（不能只挡 GET）', async () => {
  const posts = [
    ['/cs-myfree/login/start', { provider: 'codearts' }],
    ['/cs-myfree/login/cancel', { sessionId: 'x' }],
    ['/cs-myfree/login/test', { provider: 'qiniu' }],
    ['/cs-myfree/login/refresh', { provider: 'loomy' }],
    ['/cs-myfree/accounts/remove', { id: 'x' }],
  ]
  for (const [p, body] of posts) {
    const r = await req(p, { method: 'POST', body, cookie: 'dsh-auth-forged' })
    assert.equal(r.status, 401, `${p} 伪造 cookie 必须 401（实际 ${r.status}）`)
  }
  for (const [p, body] of posts) {
    const r = await req(p, { method: 'POST', body, cookie: '' })
    assert.equal(r.status, 401, `${p} 无 cookie 必须 401（实际 ${r.status}）`)
  }
})

// ══════════════════════════════════════════════════════════════════
// ⑦ 回调页
// ══════════════════════════════════════════════════════════════════
liveTest('⑦ GET /login/callback?state=bad：200 + 友好 HTML（不是 JSON 栈）', async () => {
  const r = await req('/cs-myfree/login/callback?state=bad', { cookie: '' })
  assert.equal(r.status, 200, '回调页必须 200（浏览器跳转场景）')
  assert.match(r.type, /text\/html/, `回调页必须是 HTML，实际 ${r.type}`)
  assert.ok(r.text.includes('<!doctype html'), '必须是 HTML 文档')
  assert.ok(!/^\s*[{[]/.test(r.text), '不能是 JSON')
  assert.ok(!/at .*\(.*:\d+:\d+\)/.test(r.text), '不能泄漏 JS 栈')
  assert.ok(!/\/(home|Users|tmp)\/[^\s"<]*/.test(r.text), '不能泄漏内部路径')
  assert.ok(/授权|登录|返回/.test(r.text), '必须是给用户看的友好文案')
})

liveTest('⑦b GET /login/callback?state=bad&code=x：无效 state 不发放凭证', async () => {
  const r = await req('/cs-myfree/login/callback?state=bad&code=stolen', { cookie: '' })
  assert.equal(r.status, 200)
  assert.ok(r.text.includes('<!doctype html'))
  assert.ok(!/credential|masked|ok":true/.test(r.text), '无效 state 绝不能回凭据或成功标记')
})

// ══════════════════════════════════════════════════════════════════
// ⑧ 旧接口不回归
// ══════════════════════════════════════════════════════════════════
liveTest('⑧ 旧接口不回归：/state /chain /config /scope /ledger /channels/models', async () => {
  const paths = ['/state', '/chain', '/config', '/scope', '/ledger', '/channels/models']
  const bad = []
  for (const p of paths) {
    const r = await req('/cs-myfree' + p)
    if (r.status !== 200) { bad.push(`${p}: HTTP ${r.status}`); continue }
    if (r.json?.ok !== true) bad.push(`${p}: ok=${r.json?.ok}`)
  }
  assert.deepEqual(bad, [], `旧接口回归：${bad.join(' | ')}`)
})

liveTest('⑧b POST /diag 不回归（返回 checks 数组）', async () => {
  const r = await req('/cs-myfree/diag', { method: 'POST', body: {} })
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.json.checks), 'diag 必须回 checks 数组')
  assert.ok(r.json.checks.length >= 5)
  const names = r.json.checks.map((c) => c.name)
  assert.ok(names.some((n) => /签到定时器|续期定时器/.test(n)), 'diag 应含定时器检查项')
})

// ══════════════════════════════════════════════════════════════════
// ⑨ UI 契约对照（client.js 需要的字段）
// ══════════════════════════════════════════════════════════════════
liveTest('⑨ UI 字段对照：client.js 消费的每个字段都在真实响应里', async () => {
  // W1 供给源卡片：ch.loginVerified / ch.loginNote（见 client.js:701-702）
  const ch = (await req('/cs-myfree/channels')).json.channels
  assert.ok(ch.every((c) => 'loginVerified' in c && 'loginNote' in c), '/channels 缺 UI 徽标字段')

  // W1 登录会话：start 回 sessionId/flow/url/qr/userCode/verificationUri/interval/instructions
  const s = (await req('/cs-myfree/login/start', { method: 'POST', body: { provider: 'codearts' } })).json
  for (const k of ['sessionId', 'flow', 'instructions', 'loginVerified', 'loginNote', 'callbackUrl']) {
    assert.ok(k in s, `/login/start 缺 ${k}（client.js 需要）`)
  }
  // poll：maskedAccount 用于显示掩码
  const p = (await req(`/cs-myfree/login/poll?sessionId=${encodeURIComponent(s.sessionId)}`)).json
  assert.ok('maskedAccount' in p, '/login/poll 缺 maskedAccount')
  await req('/cs-myfree/login/cancel', { method: 'POST', body: { sessionId: s.sessionId } })

  // W12 诊断页：/login/status 的 verified/unverified 计数
  const st = (await req('/cs-myfree/login/status')).json
  assert.ok(Array.isArray(st.verified) && Array.isArray(st.unverified), '/login/status 缺 verified/unverified')

  // 账号列表页：accounts[].id / label / masked（删除按钮用 id）
  const withAcc = (await req('/cs-myfree/channels')).json.channels.filter((c) => (c.accounts ?? []).length)
  for (const c of withAcc) {
    for (const a of c.accounts) {
      assert.ok('id' in a && 'masked' in a, `${c.id} 账号缺 id/masked（删除按钮与掩码显示用）`)
    }
  }
})