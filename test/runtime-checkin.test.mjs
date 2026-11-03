/**
 * 自动签到/领积分/余额 运行时测试（task-6）
 *
 * 覆盖：codearts 真实端点形状（mock HTTP）、幂等预检、不支持渠道诚实返回、
 * 定时器（假时钟：到点会跑 / 关闭不跑 / 一家失败不影响其他）、状态文件、HTTP API。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claimDailyCheckin, fetchAccountInfo, parseCreditBalance,
  PATHS, SNAP_ENGINE,
} from '../src/pools/channels/credits/codearts.js'
import {
  runCheckin, fetchCredits, runProviders, capabilityOf, autoCheckinProviders,
} from '../src/pools/channels/credits/index.js'
import { createCheckinExecutor, createCheckinScheduler, sanitizeState, readCheckinState, writeCheckinState, toDateKey, computeNextRun } from '../src/pools/channels/checkin.js'
import { registerRoutes, PREFIX } from '../src/web/routes.js'

const SECRET = { ak: 'AKIDtest1234567890', sk: 'SKsecret1234567890123456789012345678901234' }

/** 按 URL 路径分发的假 fetch */
function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    const u = new URL(url)
    const key = `${init.method ?? 'GET'} ${u.pathname}`
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers, body: init.body })
    const hit = routes[key]
    if (!hit) throw new Error(`unexpected request ${key}`)
    const r = typeof hit === 'function' ? hit(url, init) : hit
    return {
      ok: r.status === undefined || (r.status >= 200 && r.status < 300),
      status: r.status ?? 200,
      text: async () => JSON.stringify(r.json ?? {}),
    }
  }
}

const okPackage = (over = {}) => ({
  package: { is_credit_package: true, is_token_package: false, package_name_cn: '积分包', status: 'ACTIVE' },
  metrics: [
    { name: 'usageTotalPackageCredit', package_credit_remain: 1234, package_credit_amount: 2000, package_credit_used: 766 },
    { name: 'usageBasicPackageCredit', package_credit_remain: 1234, package_credit_amount: 2000, package_credit_used: 766 },
  ],
  ...over,
})

const okActivities = (item = {}) => ({
  code: 0,
  data: { items: [{ campaignId: 1, type: 'USER_LOGIN', title: '每日签到', claimable: true, status: 'AVAILABLE', benefitAmount: 1000, ...item }] },
})

// ── ① codearts 签到流程 ──

test('🔴 codearts 签到：签名 GET 账户 → 查活动 → claim → confirm', async () => {
  const calls = []
  const fetchImpl = fakeFetch({
    [`GET ${PATHS.packageInfo}`]: { json: okPackage() },
    [`GET ${PATHS.opsDelivery}`]: { json: okActivities() },
    [`POST ${PATHS.opsClaim}`]: { json: { code: 0, data: { id: 'benefit-1', benefitAmount: 1000 } } },
    [`POST ${PATHS.opsConfirm}`]: { json: { code: 0, data: {} } },
  }, calls)

  const r = await claimDailyCheckin({ secret: SECRET, fetchImpl })
  assert.equal(r.kind, 'claimed')
  assert.deepEqual(r.gain, { amount: 1000, unit: 'credit' })

  // 4 次请求，全部打 snap-access 且带 SDK-HMAC 签名
  assert.deepEqual(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), [
    `GET ${PATHS.packageInfo}`,
    `GET ${PATHS.opsDelivery}`,
    `POST ${PATHS.opsClaim}`,
    `POST ${PATHS.opsConfirm}`,
  ])
  for (const c of calls) {
    assert.equal(new URL(c.url).origin, SNAP_ENGINE)
    assert.match(c.headers.authorization, /^SDK-HMAC-SHA256 Access=AKIDtest1234567890,/)
    assert.equal(c.headers.authorization.includes('content-type'), false, 'content-type 不得进 SignedHeaders')
    assert.equal(c.headers['Agent-Type'], 'PromptCenter', '签名后追加，不参与签名')
    assert.equal(c.headers['X-Language'], 'zh-cn')
  }
  // claim body 形状
  assert.deepEqual(JSON.parse(calls[2].body), { campaignId: '1', channel: 'IDE' })
  assert.deepEqual(JSON.parse(calls[3].body), { campaignId: '1' })
})

test('codearts 幂等预检：活动已领取 ⇒ already-claimed，且不发 claim', async () => {
  const calls = []
  const fetchImpl = fakeFetch({
    [`GET ${PATHS.packageInfo}`]: { json: okPackage() },
    [`GET ${PATHS.opsDelivery}`]: { json: okActivities({ claimable: false, status: 'CLAIMED' }) },
  }, calls)
  const r = await claimDailyCheckin({ secret: SECRET, fetchImpl })
  assert.equal(r.kind, 'already-claimed')
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0)
})

test('codearts 非积分账户 ⇒ inactive（不误报失败）', async () => {
  const fetchImpl = fakeFetch({
    [`GET ${PATHS.packageInfo}`]: { json: okPackage({ package: { is_credit_package: false, is_token_package: true } }) },
  })
  const r = await claimDailyCheckin({ secret: SECRET, fetchImpl })
  assert.equal(r.kind, 'inactive')
  assert.match(r.message, /Token/)
})

test('codearts 401 ⇒ failed 且保留服务端原因', async () => {
  const fetchImpl = fakeFetch({
    [`GET ${PATHS.packageInfo}`]: { status: 401, json: { error_code: 'APIG.0301', error_msg: 'verify ak sk signature fail' } },
  })
  const r = await claimDailyCheckin({ secret: SECRET, fetchImpl })
  assert.equal(r.kind, 'failed')
  assert.match(r.message, /401/)
  assert.match(r.message, /signature fail/)
})

test('codearts 缺 AK/SK ⇒ failed（发出前）', async () => {
  const r = await claimDailyCheckin({ secret: { ak: 'x' }, fetchImpl: async () => { throw new Error('不该发出去') } })
  assert.equal(r.kind, 'failed')
  assert.match(r.message, /AK\/SK/)
})

test('codearts 余额：只认 total 指标（不重复累加分类）', async () => {
  assert.deepEqual(parseCreditBalance(okPackage().metrics), {
    total: 1234,
    packages: [
      { name: '总积分包', unit: 'credit', remaining: 1234, total: 2000, used: 766 },
      { name: '基础积分包', unit: 'credit', remaining: 1234, total: 2000, used: 766 },
    ],
  })
  const calls = []
  const r = await fetchCredits('codearts', {
    secret: SECRET,
    fetchImpl: fakeFetch({ [`GET ${PATHS.packageInfo}`]: { json: okPackage() } }, calls),
  })
  assert.equal(r.ok, true)
  assert.equal(r.total, 1234)
  assert.equal(r.unit, 'credit')
})

// ── ② 能力表诚实标注 ──

test('🔴 只有 codearts 标记为「已实现且已验证」的签到', () => {
  assert.deepEqual(autoCheckinProviders(), ['codearts'])
  for (const id of ['minimax', 'loomy', 'qoder', 'trae', 'lobsterai', 'buddy', 'workbuddy', 'cline', 'raccoon', 'zcode', 'officeace', 'accio', 'opencode', 'gemini', 'qiniu', 'qodercn', 'minimaxintl']) {
    const cap = capabilityOf(id)
    assert.equal(cap.checkin, false, id + ' 未实现签到 ⇒ 必须标 false')
    assert.ok(cap.reason, id + ' 必须给出原因')
  }
})

test('未实现渠道 runCheckin 返回 unsupported（不假装成功）', async () => {
  for (const p of ['loomy', 'minimax', 'trae', 'qoder']) {
    const r = await runCheckin(p, { secret: { token: 't' } })
    assert.equal(r.kind, 'unsupported')
    assert.ok(r.message)
  }
  const c = await fetchCredits('loomy', { secret: { token: 't' } })
  assert.equal(c.ok, false)
  assert.ok(c.error)
})

test('未登录（无 secret）⇒ failed AUTH 而不是 0', async () => {
  const r = await runCheckin('codearts', {})
  assert.equal(r.kind, 'failed')
  assert.match(r.message, /未登录|缺少凭据/)
})

// ── ③ 串行执行：一家失败不影响其他 ──

test('🔴 runProviders：一个渠道抛错不影响其他渠道', async () => {
  const out = await runProviders(['a', 'b', 'c'], async (p) => {
    if (p === 'b') throw new Error('boom')
    return { kind: 'claimed', message: 'ok' }
  })
  assert.deepEqual(out.map((r) => `${r.provider}:${r.kind}`), ['a:claimed', 'b:failed', 'c:claimed'])
  assert.match(out[1].message, /boom/)
})

// ── ④ 定时器（假时钟）──

function makeFakeClock(startISO = '2026-11-03T09:00:00+08:00') {
  const clock = {
    t: new Date(startISO).getTime(),
    timers: [],
    fireAll() { const timers = clock.timers; clock.timers = []; return timers.map((x) => x.fn()) },
  }
  clock.setTimer = (fn, ms) => { const h = { fn, ms, unref() { h.unrefCalled = true } }; clock.timers.push(h); return h }
  clock.clearTimer = (h) => { clock.timers = clock.timers.filter((x) => x !== h) }
  clock.now = () => clock.t
  return clock
}

const flush = () => new Promise((r) => setImmediate(r))

test('🔴 定时器：到点会跑（setTimeout 链 + unref）', async () => {
  const clock = makeFakeClock()
  const ran = []
  const sched = createCheckinScheduler({
    executor: async () => { ran.push(Date.now()); return { results: [{ provider: 'codearts', kind: 'claimed', message: 'ok' }], coversToday: true } },
    state: { read: async () => sanitizeState({}), write: async () => true },
    config: () => ({ enabled: true, at: '10:05' }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  sched.start()
  await flush()
  assert.equal(clock.timers.length, 1, '必须排一个定时器')
  assert.equal(clock.timers[0].unrefCalled, true, '句柄必须 unref（不挂住进程）')
  // 还不到点：_tick 被调用也只会因未到点而跳过（由调度器 delay 保证）
  const beforeDue = clock.timers[0].ms
  assert.ok(beforeDue > 0)

  // 到点：触发定时器回调（先推进时钟，模拟真实流逝）
  clock.t = new Date('2026-11-03T10:05:01+08:00').getTime()
  await Promise.all(clock.fireAll())
  await flush()
  assert.equal(ran.length, 1, '到点必须执行一轮')
  const st = sched.status()
  assert.equal(st.lastDate, toDateKey(new Date(clock.t)), '完成后记录今天已跑')
  assert.equal(st.lastResult, 'done')
  sched.stop()
})

test('🔴 定时器：enabled=false 不排程、不执行', async () => {
  const clock = makeFakeClock()
  let calls = 0
  let enabled = false
  const sched = createCheckinScheduler({
    executor: async () => { calls++; return { results: [], coversToday: false } },
    state: { read: async () => sanitizeState({}), write: async () => true },
    config: () => ({ enabled }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  sched.start()
  await flush()
  assert.equal(clock.timers.length, 0, '关闭时不得排程')
  const r = await sched._tick()
  assert.equal(r.skipped, true)
  assert.equal(calls, 0)
  // 打开开关（index.js 里配置已热更新）⇒ 立即排程
  enabled = true
  sched.setEnabled(true)
  await flush()
  assert.ok(clock.timers.length >= 1, '开关打开必须立即排程')
  sched.stop()
})

test('定时器：今天已跑且无欠账 ⇒ 不重复跑', async () => {
  const clock = makeFakeClock('2026-11-03T11:00:00+08:00')
  let calls = 0
  const sched = createCheckinScheduler({
    executor: async () => { calls++; return { results: [], coversToday: true } },
    state: {
      read: async () => sanitizeState({ lastDate: '2026-11-03', lastAt: clock.t, lastResult: 'done', pending: 0 }),
      write: async () => true,
    },
    config: () => ({ enabled: true }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  const r = await sched._tick()
  assert.equal(r.skipped, true)
  assert.match(r.reason, /今天/)
  assert.equal(calls, 0)
})

test('定时器 status 暴露 nextAt/alive（页面/诊断可见）', async () => {
  const clock = makeFakeClock('2026-11-03T09:00:00+08:00')
  const sched = createCheckinScheduler({
    executor: async () => ({ results: [], coversToday: false }),
    state: { read: async () => sanitizeState({}), write: async () => true },
    config: () => ({ enabled: true, at: '10:05' }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  sched.start(); await flush()
  const st = sched.status()
  assert.equal(st.alive, true)
  assert.equal(st.enabled, true)
  assert.equal(st.nextAt, computeNextRun({ at: '10:05' }, clock.t))
  sched.stop()
  assert.equal(sched.status().alive, false)
})

// ── ⑤ 状态文件 ──

test('checkin.json：原子写 + 0600 + 损坏回落默认', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cs-myfree-ck-'))
  try {
    const ok = await writeCheckinState(home, { lastDate: '2026-11-03', lastAt: 1, lastResult: 'done', pending: 0, channels: [{ provider: 'codearts', kind: 'claimed', text: '+1000' }] })
    assert.equal(ok, true)
    const file = join(home, 'cs-myfree', 'checkin.json')
    const mode = (await stat(file)).mode & 0o777
    assert.equal(mode, 0o600, '状态文件必须 0600')
    const read = await readCheckinState(home)
    assert.equal(read.lastDate, '2026-11-03')
    assert.equal(read.channels[0].provider, 'codearts')
    // 损坏文件不抛
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, '{not json')
    const bad = await readCheckinState(home)
    assert.equal(bad.lastDate, '')
    assert.deepEqual(bad.channels, [])
    assert.equal(sanitizeState(null).pending, 0)
  } finally { await rm(home, { recursive: true, force: true }) }
})

// ── ⑥ 执行器：默认只跑「已登录且能力=可签到」的渠道 ──

test('🔴 执行器：只对已登录 + 能力表允许的渠道发请求（未登录渠道不浪费请求）', async () => {
  const accounts = {
    list: async () => [{ provider: 'codearts', id: 'a1' }, { provider: 'loomy', id: 'l1' }],
    secretOf: async (p) => (p === 'codearts' ? SECRET : { token: 't' }),
  }
  const calls = []
  const executor = createCheckinExecutor({ accounts, fetchImpl: fakeFetch({
    [`GET ${PATHS.packageInfo}`]: { json: okPackage() },
    [`GET ${PATHS.opsDelivery}`]: { json: okActivities({ claimable: false, status: 'CLAIMED' }) },
  }, calls) })
  const out = await executor({})
  assert.deepEqual(out.results.map((r) => `${r.provider}:${r.kind}`), ['codearts:already-claimed'])
  assert.equal(out.coversToday, true)
})

// ── ⑦ HTTP API ──

function makeServer() {
  const routes = new Map()
  return { register: (r) => routes.set(String(r.path).replace(PREFIX, ''), r), get: (p) => routes.get(p) }
}
async function call(server, path, { method = 'GET', body } = {}) {
  const r = server.get(path)
  if (!r) throw new Error('no route ' + path)
  const res = { writeHead: (s) => { res._status = s }, end: (b) => { try { res._body = JSON.parse(b) } catch { res._body = b } } }
  const req = {
    method, url: PREFIX + path,
    headers: { host: 'localhost:3080' },
    socket: { remoteAddress: '127.0.0.1' },
    on: (ev, cb) => { if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body))); if (ev === 'end') cb() },
  }
  await r.handler(req, res)
  return { status: res._status, body: res._body }
}

test('🔴 HTTP：/checkin/run /checkin/status /credits /diag 定时器检查', async () => {
  const srv = makeServer()
  const state = {
    readChain: async (d) => ({ chain: [] }),
    readProbe: async (d) => d,
    overview: async () => ({ exists: true, dir: '/tmp/x', files: [] }),
  }
  registerRoutes(srv, {
    state,
    version: 'test',
    trustedHosts: [],
    getChain: () => [{ provider: 'kilo', model: 'kilo-auto/free', tier: 1 }],
    getConfig: () => ({}),
    fetchImpl: async () => ({ ok: true, json: async () => ({ is_available: false }) }),
    getRuntime: () => ({
      adapterReady: true,
      modelCount: 3,
      chainLength: 1,
      lastFailure: { kind: 'RATE_LIMIT', provider: 'kilo', model: 'kilo-auto/free' },
      checkin: { enabled: true, alive: true, at: '10:05', nextAt: Date.now() + 60000, lastDate: '2026-11-02', lastResult: 'done', pending: 0, channels: [] },
      refresh: { enabled: false, alive: false, tickMs: 60000, leadMinutes: 5 },
    }),
    runCheckin: async ({ providers }) => ({
      results: (providers ?? ['codearts']).map((p) => ({ provider: p, kind: 'claimed', gain: { amount: 1000, unit: 'credit' }, message: '+1000 积分' })),
      coversToday: true,
    }),
    getCredits: async () => [
      { provider: 'codearts', ok: true, total: 1234, unit: 'credit' },
      { provider: 'loomy', ok: false, error: '需扫码登录换 token' },
    ],
  })

  const run = await call(srv, '/checkin/run', { method: 'POST', body: { providers: ['codearts'] } })
  assert.equal(run.body.ok, true)
  assert.equal(run.body.summary.claimed, 1)
  assert.equal(run.body.coversToday, true)

  const st = await call(srv, '/checkin/status')
  assert.equal(st.body.enabled, true)
  assert.equal(st.body.alive, true)
  assert.equal(st.body.lastDate, '2026-11-02')

  const cr = await call(srv, '/credits')
  assert.equal(cr.body.ok, true)
  assert.equal(cr.body.providers.length, 2)
  assert.equal(cr.body.providers[0].total, 1234)
  assert.ok(cr.body.providers[1].error)

  const diag = await call(srv, '/diag')
  const names = diag.body.checks.map((c) => c.name)
  assert.ok(names.includes('adapter 注册与派发'), '必须有 adapter 检查项')
  assert.ok(names.includes('签到定时器'), '必须有签到定时器检查项')
  assert.ok(names.includes('续期定时器'), '必须有续期定时器检查项')
  const adapterCheck = diag.body.checks.find((c) => c.name === 'adapter 注册与派发')
  assert.equal(adapterCheck.ok, true)
  assert.match(adapterCheck.detail, /RATE_LIMIT/, '最近失败码必须带上')
})

// ── ⑧ 装配级：apply() 真的启动调度器（不是只写盘）──

test('🔴 装配级：apply 后 /checkin/status 显示定时器已排程 + 启动日志；配置关闭立即停表', async () => {
  const { apply } = await import('../src/index.js')
  const home = await mkdtemp(join(tmpdir(), 'cs-myfree-ck-apply-'))
  try {
    const routes = new Map()
    const logs = []
    const ws = { register: (r) => routes.set(String(r.path).replace(PREFIX, ''), r) }
    const llm = { registerAdapter() {} }
    const ctx = {
      app: { version: '0.2.1-rc.2' },
      logger: { info: (m) => logs.push(String(m)), warn() {}, debug() {}, error() {} },
      inject(services, cb) {
        const scoped = {}
        if (services.includes('llm')) scoped.llm = llm
        if (services.includes('webServer')) scoped.webServer = ws
        if (services.includes('web')) scoped.web = { registerSearchProvider() {} }
        try { cb(scoped) } catch { /* ignore */ }
      },
    }
    apply(ctx, { dshHome: home, checkin: { enabled: true, at: '10:05' } })
    // 启动日志必须明说定时器状态（运维可见）
    assert.ok(logs.some((m) => m.includes('自动签到：开启') && m.includes('定时器已排程')), '启动日志：' + logs.filter((m) => m.includes('自动签到')).join(' | '))

    const call = async (path, { method = 'GET', body } = {}) => {
      const r = routes.get(path)
      const res = { writeHead: (s) => { res._status = s }, end: (b) => { try { res._body = JSON.parse(b) } catch { res._body = b } } }
      const req = {
        method, url: PREFIX + path,
        headers: { host: 'localhost:3080' },
        socket: { remoteAddress: '127.0.0.1' },
        on: (ev, cb) => { if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body))); if (ev === 'end') cb() },
      }
      await r.handler(req, res)
      return { status: res._status, body: res._body }
    }

    const st = await call('/checkin/status')
    assert.equal(st.body.ok, true)
    assert.equal(st.body.enabled, true)
    assert.equal(st.body.alive, true, 'apply 后定时器必须是活的')
    assert.ok(st.body.nextAt > Date.now(), 'nextAt 必须是未来时间')

    const diag = await call('/diag')
    const ckCheck = diag.body.checks.find((c) => c.name === '签到定时器')
    assert.ok(ckCheck, 'diag 必须有签到定时器检查')
    assert.equal(ckCheck.ok, true)

    // 关掉开关 ⇒ 立即停表（真实生效，不是只写盘）
    await call('/config', { method: 'POST', body: { checkin: { enabled: false } } })
    const st2 = await call('/checkin/status')
    assert.equal(st2.body.enabled, false)
    assert.equal(st2.body.alive, false, '关闭后定时器必须停')
  } finally {
    for (let i = 0; i < 8; i++) {
      try { await rm(home, { recursive: true, force: true }); break } catch { await new Promise((r) => setTimeout(r, 50)) }
    }
  }
})
