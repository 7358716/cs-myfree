/**
 * 账号级真机验证（用户需求 #3）
 *
 * 用户原话：「CodeBuddy 和 WorkBuddy、Qoder、OfficeAce（华为 MaaS）都是已登录未验证
 *   ……排查处理一下」。
 *
 * 本文件钉住三条不能退让的事：
 *   ① **不撒谎**：验证通过只写「真实跑通过」的时间戳，绝不把 loginVerified 抄成 true；
 *   ② **失败如实**：验证失败要落 `verifyError`，且**保留**上次成功时间（不是二值翻转）；
 *   ③ **没发出请求不算验证**：并发满 / 无凭据 ⇒ 不写盘（否则等于伪造证据）。
 *
 * 另外钉住 `probeChannel` 与 `/login/test` 是**同一条代码路径**（同源纪律）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAccountStore } from '../src/pools/channels/accounts.js'
import { getSharedGate, resetSharedGate } from '../src/adapter/concurrency.js'
import { registerRoutes, PREFIX } from '../src/web/routes.js'

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'cs-myfree-verify-'))
  mkdirSync(join(dir, 'cs-myfree'), { recursive: true })
  return dir
}
function cleanup(home) { rmSync(home, { recursive: true, force: true }) }

function makeServer() {
  const routes = new Map()
  return { register: (r) => routes.set(r.path.replace(PREFIX, ''), r), get: (p) => routes.get(p) }
}
async function call(server, path, { method = 'GET', body } = {}) {
  const r = server.get(path)
  if (!r) throw new Error('no route ' + path)
  const res = {
    writeHead: (s, h) => { res._status = s; res._headers = h },
    end: (b) => { try { res._body = JSON.parse(b) } catch { res._body = b } },
  }
  const req = {
    method, url: PREFIX + path,
    headers: { host: 'localhost:3080' },
    socket: { remoteAddress: '127.0.0.1' },
    on: (ev, cb) => {
      if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
      if (ev === 'end') cb()
    },
  }
  await r.handler(req, res)
  return { status: res._status, body: res._body }
}
function makeState() {
  const store = { config: {}, chain: { chain: [] }, probe: null }
  return {
    readConfig: async (d) => store.config ?? d,
    writeConfig: async (v) => { store.config = v; return true },
    readChain: async (d) => store.chain ?? d,
    writeChain: async (v) => { store.chain = v; return true },
    readProbe: async (d) => store.probe ?? d,
    writeProbe: async (v) => { store.probe = v; return true },
    overview: async () => ({ exists: true, dir: '/tmp/x', files: [] }),
    _store: store,
  }
}

/** 造一个只在 accounts.json 里存在的登录账号 */
function seedAccount(home, { id = 'acc-1', provider = 'buddy', credential = 'tok-abcdefghijklmnop' } = {}) {
  const file = join(home, 'cs-myfree', 'accounts.json')
  let data = { accounts: {} }
  try { data = JSON.parse(readFileSync(file, 'utf8')) } catch { /* 首次 */ }
  data.accounts[id] = { provider, label: provider, credential, addedAt: 1, expiresAt: null }
  writeFileSync(file, JSON.stringify(data))
  return id
}

/** 一个「上游通了」的假 fetch：SSE 首帧立刻给一行 data: */
function okFetch(calls = []) {
  return async (url, init) => {
    calls.push({ url, body: init?.body })
    const enc = new TextEncoder()
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"pong"}}]}\n\n'))
        c.close()
      },
    })
    return { ok: true, status: 200, body: stream }
  }
}

/** 一个「上游 401」的假 fetch */
function authFailFetch(calls = []) {
  return async (url, init) => {
    calls.push({ url, body: init?.body })
    return {
      ok: false, status: 401,
      text: async () => '{"error":{"message":"token invalid","code":"AUTH"}}',
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// accounts.markVerified：只写真实结果
// ══════════════════════════════════════════════════════════════════════════

test('markVerified：成功写 verifiedAt；失败写 verifyError 且**保留**上次成功时间', async () => {
  const home = makeHome()
  try {
    const store = createAccountStore(home)
    const id = seedAccount(home, { id: 'acc-v1' })

    // 初始：从未验证
    let list = await store.list()
    assert.equal(list[0].verifiedAt, null, '新账号必须如实为 null（不预设已验证）')
    assert.equal(list[0].verifyError, null)

    // 成功 ⇒ 写时间戳
    const ok = await store.markVerified(id, { ok: true, at: 111 })
    assert.equal(ok.ok, true)
    assert.equal(ok.verifiedAt, 111)
    list = await store.list()
    assert.equal(list[0].verifiedAt, 111, '成功必须落盘')
    assert.equal(list[0].verifyError, null)

    // 之后失败 ⇒ 不抹掉上次成功时间，只记失败原因（证据两侧都要）
    await store.markVerified(id, { ok: false, at: 222, error: 'HTTP 401 token invalid' })
    list = await store.list()
    assert.equal(list[0].verifiedAt, 111, '失败不得抹掉「曾经验过」的证据')
    assert.equal(list[0].verifyError, 'HTTP 401 token invalid')
    assert.equal(list[0].verifyErrorAt, 222)

    // 再成功 ⇒ 清掉失败原因
    await store.markVerified(id, { ok: true, at: 333 })
    list = await store.list()
    assert.equal(list[0].verifiedAt, 333)
    assert.equal(list[0].verifyError, null, '成功必须清掉旧失败原因（否则页面永远显示红字）')
  } finally { cleanup(home) }
})

test('markVerified：不存在的账号如实报错，不悄悄建条目', async () => {
  const home = makeHome()
  try {
    const store = createAccountStore(home)
    const r = await store.markVerified('nope', { ok: true })
    assert.equal(r.ok, false)
    assert.match(r.error, /账号不存在/)
    assert.deepEqual((await store.list()), [], '不得凭空创建账号')
  } finally { cleanup(home) }
})

test('accounts.list：过期凭据如实标 expired（officeace 2h 短效）', async () => {
  const home = makeHome()
  try {
    const store = createAccountStore(home)
    const file = join(home, 'cs-myfree', 'accounts.json')
    writeFileSync(file, JSON.stringify({
      accounts: {
        expired1: { provider: 'officeace', credential: 'tok', addedAt: 1, expiresAt: Date.now() - 1000 },
        live1: { provider: 'officeace', credential: 'tok2', addedAt: 1, expiresAt: Date.now() + 3600_000 },
      },
    }))
    const list = await store.list()
    const byId = Object.fromEntries(list.map((a) => [a.id, a]))
    assert.equal(byId.expired1.expired, true, '过期必须标出来（不能当成能用）')
    assert.equal(byId.live1.expired, false)
  } finally { cleanup(home) }
})

// ══════════════════════════════════════════════════════════════════════════
// /channels/verify 路由：真机验证
// ══════════════════════════════════════════════════════════════════════════

test('🔴 /channels/verify 成功：真发请求 + 落 verifiedAt（不是把 loginVerified 抄成 true）', async () => {
  resetSharedGate()
  const home = makeHome()
  try {
    const id = seedAccount(home, { id: 'acc-ok', provider: 'buddy' })
    const calls = []
    const srv = makeServer()
    registerRoutes(srv, {
      state: makeState(), version: 'test', trustedHosts: [], dshHome: home,
      getChain: () => [], getConfig: () => ({}), isAdmin: () => true,
      fetchImpl: okFetch(calls),
    })
    const r = await call(srv, '/channels/verify', { method: 'POST', body: { id } })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true, JSON.stringify(r.body))
    assert.equal(r.body.accountId, id)
    assert.ok(calls.length >= 1, '必须真的发了上游请求（不是本地假判定）')
    assert.ok(Number.isFinite(r.body.verifiedAt) && r.body.verifiedAt > 0, '必须写验证时间戳')

    // 落盘可核查
    const store = createAccountStore(home)
    const acct = (await store.list()).find((a) => a.id === id)
    assert.ok(Number.isFinite(acct.verifiedAt), '磁盘上必须有 verifiedAt')
    assert.equal(acct.verifyError, null)
  } finally { cleanup(home); resetSharedGate() }
})

test('🔴 /channels/verify 失败：如实落 verifyError，且不产生 verifiedAt（不许伪造成已验证）', async () => {
  resetSharedGate()
  const home = makeHome()
  try {
    const id = seedAccount(home, { id: 'acc-bad', provider: 'buddy' })
    const srv = makeServer()
    registerRoutes(srv, {
      state: makeState(), version: 'test', trustedHosts: [], dshHome: home,
      getChain: () => [], getConfig: () => ({}), isAdmin: () => true,
      fetchImpl: authFailFetch([]),
    })
    const r = await call(srv, '/channels/verify', { method: 'POST', body: { id } })
    assert.equal(r.body.ok, false, '上游 401 ⇒ 必须如实失败')
    assert.ok(r.body.error, '必须给原因')
    assert.equal(r.body.verifiedAt, null, '失败绝不能产生验证通过时间')

    const store = createAccountStore(home)
    const acct = (await store.list()).find((a) => a.id === id)
    assert.equal(acct.verifiedAt, null, '磁盘上不得有 verifiedAt')
    assert.ok(acct.verifyError && acct.verifyError.length > 0, '失败原因必须落盘')
  } finally { cleanup(home); resetSharedGate() }
})

test('🟥 没发出请求（并发满）⇒ 不写验证结果（否则等于伪造证据）', async () => {
  resetSharedGate()
  const home = makeHome()
  try {
    const id = seedAccount(home, { id: 'acc-busy', provider: 'buddy' })
    // 验证走**账号级**名额（withAccount ⇒ `buddy#acc-busy`），所以要把那个槽占满
    const gate = getSharedGate()
    const hogs = []
    for (let i = 0; i < 8; i++) {
      const s = await gate.acquire('buddy', id)
      if (s.ok) hogs.push(s)
    }
    assert.ok(hogs.length > 0, '先要真的占满该账号的名额')

    const srv = makeServer()
    registerRoutes(srv, {
      state: makeState(), version: 'test', trustedHosts: [], dshHome: home,
      getChain: () => [], getConfig: () => ({}), isAdmin: () => true,
      fetchImpl: okFetch([]),
    })
    const r = await call(srv, '/channels/verify', { method: 'POST', body: { id } })
    assert.equal(r.body.ok, false)
    assert.equal(r.body.kind, 'CHANNEL_BUSY', '应是并发满而不是别的失败：' + JSON.stringify(r.body))
    assert.equal(r.body.verifiedAt, null)

    const acct = (await createAccountStore(home).list()).find((a) => a.id === id)
    assert.equal(acct.verifiedAt, null, '并发满不算验证过')
    assert.equal(acct.verifyError, null, '并发满也不算「验证失败」——那是没发出请求，不该留红字')
    for (const h of hogs) h.release()
  } finally { cleanup(home); resetSharedGate() }
})

test('未登录渠道调 /channels/verify：如实说「先登录」，不当成验证失败', async () => {
  resetSharedGate()
  const home = makeHome()
  try {
    const srv = makeServer()
    registerRoutes(srv, {
      state: makeState(), version: 'test', trustedHosts: [], dshHome: home,
      getChain: () => [], getConfig: () => ({}), isAdmin: () => true,
      fetchImpl: okFetch([]),
    })
    // 没有任何账号 ⇒ resolveProvider 找不到 account
    const r = await call(srv, '/channels/verify', { method: 'POST', body: { provider: 'qoder' } })
    assert.equal(r.body.ok, false)
    assert.match(String(r.body.error), /登录/, '要说清是没登录：' + JSON.stringify(r.body))
  } finally { cleanup(home); resetSharedGate() }
})

// ══════════════════════════════════════════════════════════════════════════
// 同源纪律：/login/test 与 /channels/verify 走同一条探测路径
// ══════════════════════════════════════════════════════════════════════════

test('🔴 同源：同一份凭据、同一次上游故障 ⇒ /login/test 与 /channels/verify 的结论必须一致', async () => {
  resetSharedGate()
  const home = makeHome()
  try {
    const id = seedAccount(home, { id: 'acc-same', provider: 'buddy' })
    const mk = (fetchImpl) => {
      const srv = makeServer()
      registerRoutes(srv, {
        state: makeState(), version: 'test', trustedHosts: [], dshHome: home,
        getChain: () => [], getConfig: () => ({}), isAdmin: () => true,
        fetchImpl,
      })
      return srv
    }
    // 失败情形
    const bad = mk(authFailFetch([]))
    const t1 = await call(bad, '/login/test', { method: 'POST', body: { id } })
    const v1 = await call(bad, '/channels/verify', { method: 'POST', body: { id } })
    assert.equal(t1.body.ok, v1.body.ok, '同一次 401 两处结论必须一致')
    assert.equal(t1.body.kind, v1.body.kind)
    // 成功情形
    const good = mk(okFetch([]))
    const t2 = await call(good, '/login/test', { method: 'POST', body: { id } })
    const v2 = await call(good, '/channels/verify', { method: 'POST', body: { id } })
    assert.equal(t2.body.ok, true)
    assert.equal(v2.body.ok, true)
  } finally { cleanup(home); resetSharedGate() }
})

test('验证走账号级名额：A 账号满时验证 B 账号不会被 A 挡住', async () => {
  resetSharedGate()
  const home = makeHome()
  try {
    const a = seedAccount(home, { id: 'acc-A', provider: 'buddy' })
    const b = seedAccount(home, { id: 'acc-B', provider: 'buddy' })
    const gate = getSharedGate()
    // 占满 A 账号的名额
    const hogs = []
    for (let i = 0; i < 8; i++) {
      const s = await gate.acquire('buddy', a)
      if (s.ok) hogs.push(s)
    }
    assert.ok(hogs.length > 0)

    const srv = makeServer()
    registerRoutes(srv, {
      state: makeState(), version: 'test', trustedHosts: [], dshHome: home,
      getChain: () => [], getConfig: () => ({}), isAdmin: () => true,
      fetchImpl: okFetch([]),
    })
    const r = await call(srv, '/channels/verify', { method: 'POST', body: { id: b } })
    assert.equal(r.body.ok, true, 'B 的验证不该被 A 占满挡住：' + JSON.stringify(r.body))
    for (const h of hogs) h.release()
  } finally { cleanup(home); resetSharedGate() }
})
// ══════════════════════════════════════════════════════════════════════════
// 探测请求的消息形状（修 workbuddy「first message is not system prompt」）
//
// 实测背景：workbuddy 上游明确回 400 code:11128 "first message is not system prompt"。
// 根因是探测只发了 user:ping —— **探测请求与真实对话的消息形状不一致**，
// 于是「探测说不通」和「真实对话能用」会互相打脸。这条测试钉住：必须带 system 首帧。
// ══════════════════════════════════════════════════════════════════════════
test('🟥 探测请求首条必须是 system（workbuddy 实测要求，否则 400 first message is not system prompt）', async () => {
  resetSharedGate()
  const home = makeHome()
  try {
    const id = seedAccount(home, { id: 'acc-wb', provider: 'workbuddy' })
    const calls = []
    const srv = makeServer()
    registerRoutes(srv, {
      state: makeState(), version: 'test', trustedHosts: [], dshHome: home,
      getChain: () => [], getConfig: () => ({}), isAdmin: () => true,
      fetchImpl: okFetch(calls),
    })
    await call(srv, '/channels/verify', { method: 'POST', body: { id } })
    assert.ok(calls.length >= 1, '必须真的发出请求')
    const payload = JSON.parse(calls[0].body)
    assert.ok(Array.isArray(payload.messages) && payload.messages.length >= 2,
      '至少要 system + user 两条：' + JSON.stringify(payload.messages))
    assert.equal(payload.messages[0].role, 'system',
      '首条必须是 system（否则 workbuddy 回 400）：' + JSON.stringify(payload.messages[0]))
    assert.equal(payload.messages[payload.messages.length - 1].role, 'user', '最后一条是 user')
  } finally { cleanup(home); resetSharedGate() }
})
