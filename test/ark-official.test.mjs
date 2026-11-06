/**
 * 契约 D 测试 —— 火山主账号 AK/SK 与官方计费查询（design/22 §5）
 *
 * 覆盖四条硬约束：
 *   1. 无 AK/SK ⇒ `NO_AK_SK` 且 **零网络请求**（fetchImpl 调用计数 = 0）
 *   2. 有 AK/SK 但 endpoint 未确认 ⇒ `NOT_IMPLEMENTED`，同样不打网络（不猜官方地址、不假装成功）
 *   3. estimated 响应里**不得出现**「官方 / 实时 / live」字样（不许伪装实时数据）
 *   4. AK/SK 绝不进日志、绝不进响应体（只允许 source + masked）
 *
 * ⚠️ 纪律：本文件所有用例都注入 fetchImpl，**绝不真联网**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resolveVolcAkSk, volcAkSkPublic, maskAk, volcSignV4, queryArkOfficial, queryArkBalance,
  registerCashRoute, CASH_PATH, VOLC_ENV_AK, VOLC_ENV_SK,
} from '../src/web/cash.js'

/** 临时 dshHome（每用例独立目录；空账本 ⇒ estimated 的 total 为 null） */
function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'cs-myfree-ark-'))
  mkdirSync(join(dir, 'cs-myfree'), { recursive: true })
  return dir
}

/**
 * 隔离环境变量（VOLC_ACCESS_KEY_ID / VOLC_SECRET_ACCESS_KEY / ARK_API_KEY），
 * 避免开发机上的真实 key 污染断言；用例 finally 里恢复。
 */
function isolateEnv() {
  const names = [VOLC_ENV_AK, VOLC_ENV_SK, 'ARK_API_KEY']
  const saved = names.map((n) => [n, process.env[n]])
  for (const n of names) delete process.env[n]
  return {
    restore() {
      for (const [n, v] of saved) {
        if (v === undefined) delete process.env[n]
        else process.env[n] = v
      }
    },
    setAkSk(ak, sk) { process.env[VOLC_ENV_AK] = ak; process.env[VOLC_ENV_SK] = sk },
    setArkKey(k) { process.env.ARK_API_KEY = k },
  }
}

/** 计数 fetch：返回固定响应，同时记录调用次数与入参（用于断言「零网络」与「不泄漏 sk」） */
function countingFetch(impl = async () => ({ ok: true, status: 200, json: async () => ({}) })) {
  const calls = []
  const fn = async (url, init) => { calls.push({ url, init }); return impl(url, init) }
  fn.calls = calls
  return fn
}

// ── ① resolveVolcAkSk：优先级与缺失语义 ────────────────────────────────────
test('AK/SK：env 优先于 credentials', () => {
  const r = resolveVolcAkSk({
    env: { [VOLC_ENV_AK]: 'AKLTenv0001abcd', [VOLC_ENV_SK]: 'sk-env-value' },
    credentials: { [VOLC_ENV_AK]: 'AKLTcred0002wxyz', [VOLC_ENV_SK]: 'sk-cred-value' },
  })
  assert.equal(r.source, 'env')
  assert.equal(r.ak, 'AKLTenv0001abcd')
  assert.equal(r.sk, 'sk-env-value')
})

test('AK/SK：env 缺失时回落到 credentials.yaml 同名键', () => {
  const r = resolveVolcAkSk({
    env: {},
    credentials: { [VOLC_ENV_AK]: 'AKLTcred0002wxyz', [VOLC_ENV_SK]: 'sk-cred-value' },
  })
  assert.equal(r.source, 'credentials')
  assert.equal(r.ak, 'AKLTcred0002wxyz')
})

test('AK/SK：都没有 ⇒ ak/sk 为 null、source 为 null', () => {
  const r = resolveVolcAkSk({ env: {}, credentials: null })
  assert.equal(r.ak, null)
  assert.equal(r.sk, null)
  assert.equal(r.source, null)
})

test('AK/SK：只有一半（缺 SK）视为缺失（签名无法成功）', () => {
  const r = resolveVolcAkSk({ env: { [VOLC_ENV_AK]: 'AKLTonly-ak' }, credentials: { [VOLC_ENV_SK]: 'only-sk' } })
  assert.equal(r.source, null)
  assert.equal(r.ak, null)
})

test('AK/SK：masked 不含完整 AK；对外投影只给 source+masked', () => {
  const r = resolveVolcAkSk({ env: { [VOLC_ENV_AK]: 'AKLTabcdefgh1234', [VOLC_ENV_SK]: 'sk-should-never-surface' }, credentials: null })
  assert.equal(maskAk('AKLTabcdefgh1234'), 'AKLT****1234')
  const pub = volcAkSkPublic(r)
  assert.deepEqual(Object.keys(pub).sort(), ['masked', 'source'])
  const s = JSON.stringify(pub)
  assert.equal(s.includes('AKLTabcdefgh1234'), false, '投影不得含完整 AK')
  assert.equal(s.includes('sk-should-never-surface'), false, 'SK 绝不能出现在对外投影里')
})

// ── ② queryArkOfficial：无 AK/SK ⇒ NO_AK_SK 且零网络 ───────────────────────
test('🔴 无 AK/SK ⇒ NO_AK_SK，且一个网络请求都不发', async () => {
  const f = countingFetch()
  const r = await queryArkOfficial({ fetchImpl: f, ak: null, sk: null })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_AK_SK')
  assert.equal(f.calls.length, 0, 'NO_AK_SK 分支必须零网络请求')
})

test('有 AK/SK 但缺 SK 也走 NO_AK_SK（不成对等于没有）', async () => {
  const f = countingFetch()
  const r = await queryArkOfficial({ fetchImpl: f, ak: 'AKLTonly', sk: null })
  assert.equal(r.code, 'NO_AK_SK')
  assert.equal(f.calls.length, 0)
})

// ── ③ endpoint 未确认 ⇒ NOT_IMPLEMENTED（不猜、不假装成功） ────────────────
test('🟡 有 AK/SK 但官方 endpoint 未确认 ⇒ NOT_IMPLEMENTED，不打网络', async () => {
  const f = countingFetch()
  const r = await queryArkOfficial({ fetchImpl: f, ak: 'AKLTabcdefgh1234', sk: 'sk-x' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NOT_IMPLEMENTED')
  assert.match(r.error, /endpoint/)
  assert.equal(f.calls.length, 0, '未确认 endpoint 时绝不猜测地址发请求')
})

// ── ④ 签名：纯函数，结构稳定；换 SK 签名必变 ───────────────────────────────
test('volcSignV4 签名稳定（固定输入 ⇒ 固定签名），且对 SK 敏感', () => {
  const base = { ak: 'AKLTtest', sk: 'secret-a', atMs: 1793836800000, query: { b: '2', a: '1' } }
  const s1 = volcSignV4(base)
  const s2 = volcSignV4(base)
  assert.equal(s1.signature, s2.signature, '同输入必须同签名')
  assert.equal(s1.signature.length, 64)
  assert.match(s1.authorization, /^HMAC-SHA256 Credential=AKLTtest\/\d{8}\/cn-beijing\/billing\/request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/)
  assert.match(s1.canonicalRequest, /^POST\n\//, 'canonical request 以 method + 路径开头')
  // query 参与签名且按键排序（a 在 b 前）
  assert.match(s1.canonicalRequest, /a=1&b=2/)
  const s3 = volcSignV4({ ...base, sk: 'secret-b' })
  assert.notEqual(s1.signature, s3.signature, '换 SK 必须换签名')
  // 签名结果里不得出现 SK 原文
  assert.equal(JSON.stringify(s1).includes('secret-a'), false, '签名输出不得含 SK 原文')
})

// ── ⑤ 有 AK/SK + 显式 endpoint：网络/签名失败 ⇒ ok:false（不伪装 live） ────
test('有 AK/SK + 显式 endpoint，网络抛错 ⇒ ok:false（code=NETWORK）', async () => {
  const f = async () => { throw new Error('ECONNRESET') }
  const r = await queryArkOfficial({ fetchImpl: f, ak: 'AKLTabcdefgh1234', sk: 'sk-x', endpoint: 'https://billing.example/api' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NETWORK')
  assert.match(r.error, /ECONNRESET/)
})

test('🔴 有 AK/SK + 显式 endpoint，HTTP 401 ⇒ ok:false 且错误信息不含 ak/sk', async () => {
  const AK = 'AKLTabcdefgh1234'
  const SK = 'sk-never-leak-this-value'
  const f = countingFetch(async () => ({
    ok: false, status: 401,
    json: async () => ({ ResponseMetadata: { Error: { Code: 'SignatureDoesNotMatch', Message: 'signature mismatch' } } }),
  }))
  const r = await queryArkOfficial({ fetchImpl: f, ak: AK, sk: SK, endpoint: 'https://billing.example/api' })
  assert.equal(r.ok, false)
  assert.match(r.code, /^HTTP_401/)
  const sent = JSON.stringify(f.calls)
  assert.equal(sent.includes(SK), false, 'SK 不得落在任何请求头/查询串/返回体里')
  // AK 按 HMAC-SHA256 规范**必须**出现在 authorization 头的 Credential 段，除此之外不得出现
  const { authorization, ...otherHeaders } = f.calls[0].init.headers
  assert.match(authorization, /^HMAC-SHA256 Credential=AKLT/)
  assert.equal(JSON.stringify(otherHeaders).includes(AK), false, 'AK 只能出现在 authorization 头内')
  assert.equal(JSON.stringify(r).includes(SK), false, 'SK 绝不进响应')
})

test('有 AK/SK + 显式 endpoint，返回可解析 ⇒ live（带 fetchedAt 与 period）', async () => {
  const atMs = 1793836800000
  const f = countingFetch(async () => ({
    ok: true, status: 200,
    json: async () => ({ ResponseMetadata: {}, Result: { AvailableBalance: '12.34', Items: [{ Model: 'doubao-pro', Calls: 3, InputTokens: 100, OutputTokens: 200, Cost: 0.5 }] } }),
  }))
  const r = await queryArkOfficial({
    fetchImpl: f, ak: 'AKLTabcdefgh1234', sk: 'sk-x',
    endpoint: 'https://billing.example/api', now: () => atMs,
  })
  assert.equal(r.ok, true)
  assert.equal(r.source, 'live')
  assert.equal(r.totalCNY, 12.34)
  assert.equal(r.fetchedAt, atMs)
  assert.equal(r.period.toMs, atMs)
  assert.equal(r.items[0].model, 'doubao-pro')
  assert.equal(f.calls.length, 1)
  // 请求确实带了火山 HMAC 签名头
  assert.match(f.calls[0].init.headers.authorization, /^HMAC-SHA256 Credential=AKLT/)
})

test('有 AK/SK + 显式 endpoint，返回体解析不出金额 ⇒ ok:false（宁可报错不给假数）', async () => {
  const f = countingFetch(async () => ({ ok: true, status: 200, json: async () => ({ Result: { Unknown: 1 } }) }))
  const r = await queryArkOfficial({ fetchImpl: f, ak: 'AKLTabcdefgh1234', sk: 'sk-x', endpoint: 'https://billing.example/api' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'UNPARSEABLE')
})

// ── ⑥ 三分支顺序：estimated 不得伪装 live ─────────────────────────────────
test('🔴 有 ARK key、无 AK/SK ⇒ estimated，且响应里不含「官方/实时/live」字样', async () => {
  const env = isolateEnv()
  const home = makeHome()
  try {
    env.setArkKey('ark-probe-key-123')
    const f = countingFetch()
    // 默认接线：registerCashRoute 里的 volcBalance 就是 queryArkOfficial ⇒ 这里直接模拟
    const r = await queryArkBalance({}, {
      dshHome: home,
      fetchImpl: f,
      volcBalance: (o) => queryArkOfficial(o),
    })
    assert.equal(r.source, 'estimated')
    assert.equal(r.billingQuery, 'NO_AK_SK', '估算必须留下去哪一步停下的状态码')
    const s = JSON.stringify(r)
    assert.equal(/官方/.test(s), false, 'estimated 响应不得出现「官方」')
    assert.equal(/实时/.test(s), false, 'estimated 响应不得出现「实时」')
    assert.equal(/live/i.test(s), false, 'estimated 响应不得出现 live')
    assert.match(r.note, /估算/)
    assert.equal(f.calls.length, 0, 'estimated 分支不该产生任何网络请求')
  } finally { env.restore(); rmSync(home, { recursive: true, force: true }) }
})

test('无 ARK key、无 AK/SK ⇒ error（如实说明缺什么）', async () => {
  const env = isolateEnv()
  try {
    const r = await queryArkBalance({}, { dshHome: makeHome() })
    assert.equal(r.source, 'error')
    assert.equal(r.total, null)
    assert.match(r.error, /ARK_API_KEY|AK\/SK/)
  } finally { env.restore() }
})

test('live 分支：env AK/SK + 可用的官方查询 ⇒ source=live 且带 fetchedAt/period', async () => {
  const env = isolateEnv()
  const home = makeHome()
  try {
    env.setAkSk('AKLTenv0001abcd', 'sk-env-secret')
    env.setArkKey('ark-probe-key-123')
    const atMs = 1793836800000
    const f = countingFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ Result: { AvailableBalance: 8.5 } }),
    }))
    const r = await queryArkBalance({}, {
      dshHome: home,
      fetchImpl: f,
      now: () => atMs,
      // 部署方显式启用（endpoint 已实测确认）后的真实路径
      volcBalance: (o) => queryArkOfficial({ ...o, endpoint: 'https://billing.example/api' }),
    })
    assert.equal(r.source, 'live')
    assert.equal(r.total, 8.5)
    assert.equal(r.fetchedAt, atMs, 'live 必须带 fetchedAt')
    assert.ok(r.period && r.period.toMs === atMs, 'live 必须带 period')
    assert.equal(f.calls.length, 1)
    assert.equal(JSON.stringify(r).includes('sk-env-secret'), false, 'SK 绝不进响应')
  } finally { env.restore(); rmSync(home, { recursive: true, force: true }) }
})

// ── ⑦ registerCashRoute 默认接线（契约 D3） ───────────────────────────────
test('registerCashRoute 默认接 queryArkOfficial：无 AK/SK ⇒ estimated 且零网络', async () => {
  const env = isolateEnv()
  const home = makeHome()
  try {
    env.setArkKey('ark-probe-key-123')
    const routes = []
    const ws = { register: (r) => routes.push(r) }
    const f = countingFetch()
    let captured = null
    const ok = registerCashRoute(ws, {}, {
      dshHome: home,
      fetchImpl: f,
      helpers: {
        judge: () => ({ ok: true }),
        sendJson: (res, status, body) => { captured = { status, body } },
      },
    })
    assert.equal(ok, true)
    assert.equal(routes[0].path, CASH_PATH)
    await routes[0].handler({ headers: {} }, {})
    assert.equal(captured.status, 200)
    assert.equal(captured.body.ark.source, 'estimated')
    assert.equal(captured.body.ark.billingQuery, 'NO_AK_SK')
    assert.equal(f.calls.length, 0, '默认接线在无 AK/SK 时也必须零网络')
  } finally { env.restore(); rmSync(home, { recursive: true, force: true }) }
})

test('registerCashRoute 默认接线：AK/SK 与 ARK key 都缺 ⇒ error 同时给出两条线索', async () => {
  const env = isolateEnv()
  const home = makeHome()
  try {
    const routes = []
    const f = countingFetch()
    let captured = null
    registerCashRoute({ register: (r) => routes.push(r) }, {}, {
      dshHome: home,
      fetchImpl: f,
      helpers: {
        judge: () => ({ ok: true }),
        sendJson: (res, status, body) => { captured = { status, body } },
      },
    })
    await routes[0].handler({ headers: {} }, {})
    assert.equal(captured.body.ark.source, 'error')
    assert.match(captured.body.ark.error, /ARK_API_KEY/, '要提示缺推理 Key')
    assert.match(captured.body.ark.error, /AK\/SK/, '同时提示缺主账号 AK/SK')
    assert.equal(f.calls.length, 0, '两个 key 都缺时也必须零网络')
  } finally { env.restore(); rmSync(home, { recursive: true, force: true }) }
})
