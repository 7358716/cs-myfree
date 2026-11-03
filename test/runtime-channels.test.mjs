/**
 * 渠道层运行时：URL 拼接 / 华为云签名 / AK-SK 凭据 / 能力实况
 *
 * 依据：2026-11-03 渠道调研（/tmp/chan-research.md，本机实测 HTTP 状态为准）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHANNELS, AUTH } from '../src/pools/channels/protocols.js'
import { joinUrl, chat } from '../src/pools/channels/driver.js'
import { signHuaweiRequest, sdkDateStamp, sha256hex, canonicalQuery } from '../src/pools/channels/sign.js'
import { createAccountStore, pairAkSkEntries, maskCredential } from '../src/pools/channels/accounts.js'
import { listChannels } from '../src/web/channels.js'

// ── ① URL 拼接（/v1/v1 必然 404）──

test('🔴 所有渠道的 chat URL 不得出现重复 /v1（/v1/v1）', () => {
  for (const [id, ch] of Object.entries(CHANNELS)) {
    const url = joinUrl(ch.baseUrl, ch.chatPath ?? '/v1/chat/completions')
    assert.equal(/\/v1\/v1\//.test(url), false, `${id} URL 重复 /v1：${url}`)
    assert.equal(/\/api\/v1\/v1\//.test(url), false, `${id} URL 重复 /api/v1：${url}`)
    assert.match(url, /^https:\/\//, `${id} 必须是 HTTPS：${url}`)
  }
})

test('codearts 用真实推理网关（不是 officeace 的 agentarts）', () => {
  const ch = CHANNELS.codearts
  assert.equal(ch.baseUrl, 'https://snap-access.cn-north-4.myhuaweicloud.com')
  assert.equal(ch.chatPath, '/api/v2/chat/completions')
  assert.equal(joinUrl(ch.baseUrl, ch.chatPath), 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions')
  assert.equal(ch.auth, AUTH.SIGNED_HUAWEI)
})

test('NXDOMAIN 域名已换成真实入口（workbuddy / raccoon）', () => {
  assert.equal(CHANNELS.workbuddy.baseUrl, 'https://www.workbuddy.ai')
  assert.equal(CHANNELS.raccoon.baseUrl, 'https://xiaohuanxiong.com')
})

// ── ② 华为云签名 ──

const AK = 'AKIDtest1234567890'
const SK = 'SKsecret1234567890123456789012345678901234'

test('signHuaweiRequest：Authorization 形状 + content-type 不参与签名', () => {
  const r = signHuaweiRequest({
    ak: AK,
    sk: SK,
    method: 'POST',
    url: 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions',
    body: '{"a":1}',
    now: new Date('2026-11-03T07:30:00.000Z'),
  })
  assert.match(r.authorization, /^SDK-HMAC-SHA256 Access=AKIDtest1234567890,SignedHeaders=/, 'Authorization 格式')
  assert.equal(r.authorization.includes('content-type'), false, 'content-type 不得进 SignedHeaders（本机实测 401）')
  assert.equal(r.signedHeaders.includes('content-type'), false)
  assert.deepEqual(r.signedHeaders, ['host', 'x-sdk-content-sha256', 'x-sdk-date'])
  assert.equal(r.headers['x-sdk-date'], '20261103T073000Z')
  assert.equal(r.headers['x-sdk-content-sha256'], sha256hex('{"a":1}'))
  // canonicalRequest 的 uri 末尾补 '/'
  assert.ok(r.canonicalRequest.startsWith('POST\n/api/v2/chat/completions/\n'))
})

test('signHuaweiRequest：确定性 + 时间戳格式 + securityToken 参与签名', () => {
  assert.equal(sdkDateStamp(new Date('2026-01-02T03:04:05.678Z')), '20260102T030405Z')
  const args = { ak: AK, sk: SK, method: 'GET', url: 'https://x.test/p', body: '', now: new Date('2026-11-03T07:30:00.000Z') }
  assert.equal(signHuaweiRequest(args).authorization, signHuaweiRequest(args).authorization, '同样输入必须同签名')
  const withToken = signHuaweiRequest({ ...args, securityToken: 'ST123' })
  assert.ok(withToken.signedHeaders.includes('x-security-token'))
  assert.notEqual(withToken.authorization, signHuaweiRequest(args).authorization)
  // body 不同 ⇒ 签名不同
  assert.notEqual(
    signHuaweiRequest({ ...args, body: 'a' }).authorization,
    signHuaweiRequest({ ...args, body: 'b' }).authorization,
  )
})

test('signHuaweiRequest：缺 AK/SK 抛 AUTH（不发出去吃 401）', () => {
  assert.throws(() => signHuaweiRequest({ ak: 'x', sk: '', method: 'POST', url: 'https://x.test/p' }), /AK\/SK/)
  assert.throws(() => signHuaweiRequest({ ak: '', sk: 'y', method: 'POST', url: 'https://x.test/p' }), (e) => e.code === 'AUTH')
})

test('canonicalQuery 按字典序', () => {
  const u = new URL('https://x.test/p?b=2&a=1')
  assert.equal(canonicalQuery(u.searchParams), 'a=1&b=2')
})

// ── ③ 渠道 chat 请求真的签名 + body 形状 ──

test('🔴 codearts chat：SDK 签名 + body 附加字段 + tools + max_tokens 钳制', async () => {
  let seen = null
  await chat({
    channelId: 'codearts',
    ch: CHANNELS.codearts,
    cred: { ak: AK, sk: SK },
    model: 'GLM-5.2',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'bash', description: '', parameters: {} } }],
    maxTokens: 999_999,
    sessionId: 'sess-1',
    signal: null,
    fetchImpl: async (url, init) => {
      seen = { url, init, body: JSON.parse(init.body) }
      return { ok: true, body: null }
    },
  })
  assert.equal(seen.url, 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions')
  assert.match(seen.init.headers.authorization, /^SDK-HMAC-SHA256 Access=/)
  assert.ok(seen.init.headers['x-sdk-date'])
  assert.equal(seen.body.model, 'GLM-5.2')
  assert.equal(seen.body.stream, true)
  // 渠道声明式附加字段
  assert.deepEqual(seen.body.include, ['reasoning.encrypted_content'])
  assert.equal(seen.body.reasoning_summary, 'auto')
  assert.equal(seen.body.tool_stream, true)
  // prompt_cache_key 来自 sessionId
  assert.equal(seen.body.prompt_cache_key, 'sess-1')
  // 输出上限必须钳到 65536（131072 会被上游拒/空流）
  assert.equal(seen.body.max_tokens, 65_536)
  assert.equal(seen.body.tools[0].function.name, 'bash')
})

test('🔴 缺 SK 的 codearts 请求在发出前就失败（不浪费一次 401）', async () => {
  await assert.rejects(() => chat({
    channelId: 'codearts',
    ch: CHANNELS.codearts,
    cred: { ak: AK },
    model: 'GLM-5.2',
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: async () => { throw new Error('不该发出去') },
  }), (e) => e.code === 'AUTH')
})

test('免密/普通渠道仍不因签名逻辑改变行为（Bearer 渠道照旧）', async () => {
  let seen = null
  await chat({
    channelId: 'buddy',
    ch: CHANNELS.buddy,
    cred: { token: 'tok123' },
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: async (url, init) => { seen = { url, headers: init.headers }; return { ok: true, body: null } },
  })
  assert.equal(seen.headers.authorization, 'Bearer tok123')
  assert.equal(seen.url, 'https://api.lkeap.cloud.tencent.com/v1/chat/completions', '不得再出现 /v1/v1')
})

// ── ④ AK/SK 凭据结构 + 历史两条账号配对 ──

test('🔴 save：AK:SK 单字符串 / ak+sk 结构化都能存，secretOf 取到三元组', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cs-myfree-acc-'))
  try {
    const store = createAccountStore(home)
    const r1 = await store.save({ provider: 'codearts', credential: `${AK}:${SK}` })
    assert.equal(r1.kind, 'aksk')
    assert.deepEqual(
      { ak: (await store.secretOf('codearts')).ak, sk: (await store.secretOf('codearts')).sk },
      { ak: AK, sk: SK },
    )
    const home2 = await mkdtemp(join(tmpdir(), 'cs-myfree-acc2-'))
    try {
      const s2 = createAccountStore(home2)
      const r2 = await s2.save({ provider: 'codearts', ak: AK, sk: SK, securityToken: 'ST-1' })
      assert.equal(r2.kind, 'aksk')
      const sec = await s2.secretOf('codearts')
      assert.equal(sec.ak, AK)
      assert.equal(sec.sk, SK)
      assert.equal(sec.securityToken, 'ST-1')
      // 列表绝不返回原文
      const list = await s2.list()
      assert.equal(JSON.stringify(list).includes(SK), false, 'list 不得含 SK 原文')
      assert.equal(list[0].kind, 'aksk')
    } finally { await rm(home2, { recursive: true, force: true }) }
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('🔴 历史数据「AK 一条 + SK 一条」自动配对成一条（含写盘归一）', async () => {
  const legacy = {
    'a1': { provider: 'codearts', credential: AK, addedAt: 1 },
    'a2': { provider: 'codearts', credential: SK, addedAt: 2 },
    'b1': { provider: 'buddy', credential: 'single-token-0123456789', addedAt: 3 },
  }
  const { merged, changed } = pairAkSkEntries(legacy, new Set(['codearts']))
  assert.equal(changed, true)
  assert.equal(Object.keys(merged).length, 2, '两条 codearts 合成一条')
  assert.equal(merged['codearts-aksk'].ak, AK)
  assert.equal(merged['codearts-aksk'].sk, SK)
  assert.equal(merged['b1'].credential, 'single-token-0123456789', '非签名渠道不动')

  const home = await mkdtemp(join(tmpdir(), 'cs-myfree-pair-'))
  try {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(home, 'cs-myfree'), { recursive: true })
    await writeFile(join(home, 'cs-myfree', 'accounts.json'), JSON.stringify({ accounts: legacy }))
    const store = createAccountStore(home)
    const r = await store.normalizeAkSk(new Set(['codearts']))
    assert.deepEqual({ changed: r.changed, before: r.before, after: r.after }, { changed: true, before: 3, after: 2 })
    const list = await store.list()
    assert.equal(list.filter((a) => a.provider === 'codearts').length, 1)
    assert.equal((await store.secretOf('codearts')).sk, SK)
    assert.equal(maskCredential(AK).includes(AK), false)
  } finally { await rm(home, { recursive: true, force: true }) }
})

// ── ⑤ 能力实况（诚实降级）──

test('🔴 渠道清单如实标注 implemented / reason', async () => {
  const store = { list: async () => [] }
  const list = await listChannels(store)
  const byId = Object.fromEntries(list.map((c) => [c.id, c]))
  assert.equal(byId.codearts.implemented, true, 'codearts 有 AK/SK 直签实现 ⇒ 可用')
  assert.equal(byId.qiniu.implemented, true, 'qiniu 粘贴 API Key 可用')
  for (const id of ['buddy', 'workbuddy', 'cline', 'trae', 'qoder', 'minimax', 'lobsterai', 'zcode', 'officeace', 'accio', 'raccoon']) {
    assert.equal(byId[id].implemented, false, id + ' 未实现 token 交换 ⇒ 必须标 false')
    assert.ok(byId[id].reason, id + ' 必须给出 reason')
  }
  assert.equal(byId.gemini.implemented, false)
  assert.match(byId.gemini.reason, /网络不可达/)
  assert.equal(byId.qodercn.implemented, false)
  assert.match(byId.qodercn.reason, /404|WASM/)
  assert.equal(byId.opencode.implemented, false)
  assert.match(byId.opencode.reason, /403/)
})
