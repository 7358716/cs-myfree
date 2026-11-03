/**
 * 运行时选路 / 链配置 —— 「选了模型不走」「降级链是装饰品」的回归测试
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdapter } from '../src/adapter/index.js'
import { mergeChain, validateOverrides, normalizeChainAliases } from '../src/adapter/chain-overrides.js'
import { createState } from '../src/web/state.js'
import { registerRoutes, PREFIX } from '../src/web/routes.js'

async function collect(iter) { const o = []; for await (const c of iter) o.push(c); return o }
const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const okSend = (calls) => async ({ provider, model }) => {
  calls.push({ provider, model })
  return (async function* () {
    yield { type: 'text-delta', text: 'ok' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

// ── ① 请求的模型优先直连 ──

test('🔴 请求 codearts/deepseek-v4-pro 时先调 codearts（不再改调 kilo）', async () => {
  const calls = []
  const adapter = createAdapter({
    builtin: [
      { provider: 'kilo', model: 'kilo-auto/free', tier: 1 },
      { provider: 'ovh', model: 'Qwen3.5-397B-A17B', tier: 2 },
    ],
    // 渠道模型不在链里（生产由 extraModels 动态提供）；这里同时验证 directModel 兜底
    directModel: (id) => (id.startsWith('codearts/') ? { provider: 'codearts', model: id, channelModel: true } : null),
    send: okSend(calls),
  })

  const out = await collect(adapter.stream({ model: 'codearts/deepseek-v4-pro', messages: [] }))
  assert.equal(calls.length, 1, '直连成功就不该再试其他候选')
  assert.equal(calls[0].provider, 'codearts')
  assert.equal(calls[0].model, 'codearts/deepseek-v4-pro', '模型 id 原样下传（由 send 解析渠道）')
  assert.equal(textOf(out), 'ok')
})

test('请求的免密模型优先直连（同 model 命中链条目）', async () => {
  const calls = []
  const adapter = createAdapter({
    builtin: [
      { provider: 'kilo', model: 'kilo-auto/free', tier: 1 },
      { provider: 'ovh', model: 'Qwen3.5-397B-A17B', tier: 2 },
    ],
    send: okSend(calls),
  })
  await collect(adapter.stream({ model: 'Qwen3.5-397B-A17B', messages: [] }))
  assert.equal(calls[0].provider, 'ovh', '请求的模型必须优先，不受 tier 影响')
})

test('extraModels 目录里的渠道模型既能选到、也能直连', async () => {
  const calls = []
  const adapter = createAdapter({
    builtin: [{ provider: 'kilo', model: 'kilo-auto/free', tier: 1 }],
    extraModels: () => [{ id: 'codearts/deepseek-v4-pro', name: 'CodeArts · DeepSeek', channelId: 'codearts', inputModalities: ['text'] }],
    send: okSend(calls),
  })

  // listModels：渠道模型可被选中（宿主契约：provider 必须是 cs-myfree、id 唯一）
  const ids = adapter.listModels('cs-myfree').map((m) => m.id)
  assert.ok(ids.includes('kilo-auto/free'))
  assert.ok(ids.includes('codearts/deepseek-v4-pro'))
  // resolveModel：选择器选中后宿主会解析
  const rm = adapter.resolveModel('cs-myfree', 'codearts/deepseek-v4-pro')
  assert.equal(rm.id, 'codearts/deepseek-v4-pro')
  assert.equal(rm.provider, 'cs-myfree')

  await collect(adapter.stream({ model: 'codearts/deepseek-v4-pro', messages: [] }))
  assert.equal(calls[0].provider, 'codearts')
  assert.equal(calls[0].model, 'codearts/deepseek-v4-pro')
})

test('直连失败后才按链降级（模型不存在 → 换模型）', async () => {
  const calls = []
  const adapter = createAdapter({
    builtin: [
      { provider: 'kilo', model: 'kilo-auto/free', tier: 1 },
      { provider: 'ovh', model: 'Qwen3.5-397B-A17B', tier: 2 },
    ],
    directModel: (id) => (id.startsWith('codearts/') ? { provider: 'codearts', model: id, channelModel: true } : null),
    send: async ({ provider, model }) => {
      calls.push({ provider, model })
      if (provider === 'codearts') {
        return (async function* () {
          throw Object.assign(new Error('codearts HTTP 404: no such model'), { status: 404 })
        })()
      }
      return (async function* () {
        yield { type: 'text-delta', text: '降级答案' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  })

  const out = await collect(adapter.stream({ model: 'codearts/deepseek-v4-pro', messages: [] }))
  assert.deepEqual(calls.map((c) => c.provider), ['codearts', 'kilo'], '先直连、失败后降级到链首')
  assert.equal(textOf(out), '降级答案')
})

// ── ② 链覆盖层：写盘 → 立即生效 → 重启一致 ──

test('🔴 setChain 立即改变 listModels 与选路（不再需要重启）', async () => {
  const calls = []
  const adapter = createAdapter({
    builtin: [{ provider: 'kilo', model: 'kilo-auto/free', tier: 1 }],
    send: okSend(calls),
  })
  adapter.setChain(
    [{ provider: 'kilo', model: 'kilo-auto/free', tier: 1 }],
    [{ provider: 'ovh', model: 'Qwen3.5-397B-A17B', tier: 1 }],
  )
  assert.deepEqual(adapter.listModels('cs-myfree').map((m) => m.id), ['kilo-auto/free', 'Qwen3.5-397B-A17B'])
  await collect(adapter.stream({ model: 'Qwen3.5-397B-A17B', messages: [] }))
  assert.equal(calls[0].provider, 'ovh')
})

test('🔴 POST /chain 写盘后返回 applied:true，且 GET /chain 与 adapter 生效链一致', async () => {
  const builtin = [{ provider: 'kilo', model: 'kilo-auto/free', tier: 1 }]
  const calls = []
  const adapter = createAdapter({ builtin, send: okSend(calls) })

  // 假 state（写内存），假 webServer
  const store = { chain: { chain: [] } }
  const state = {
    readChain: async (d) => store.chain ?? d,
    writeChain: async (v) => { store.chain = v; return true },
    readProbe: async (d) => d,
    overview: async () => ({ exists: true, dir: '/tmp/x', files: [] }),
  }
  const routes = new Map()
  const ws = { register: (r) => routes.set(r.path.replace(PREFIX, ''), r) }
  registerRoutes(ws, {
    state,
    version: 'test',
    trustedHosts: [],
    getChain: () => builtin,
    getChainState: () => adapter.getChain(),
    applyChain: (entries) => adapter.setChain(builtin, entries),
    getConfig: () => ({}),
    fetchImpl: async () => ({ ok: true, json: async () => ({ is_available: true, balance_infos: [] }) }),
  })

  async function call(path, { method = 'GET', body } = {}) {
    const r = routes.get(path)
    const res = { writeHead: (s) => { res._status = s }, end: (b) => { try { res._body = JSON.parse(b) } catch { res._body = b } } }
    const req = {
      method,
      url: PREFIX + path,
      headers: { host: 'localhost:3080' },
      socket: { remoteAddress: '127.0.0.1' },
      on: (ev, cb) => { if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body))); if (ev === 'end') cb() },
    }
    await r.handler(req, res)
    return { status: res._status, body: res._body }
  }

  const post = await call('/chain', {
    method: 'POST',
    body: { chain: [{ provider: 'ovh', model: 'Qwen3.5-397B-A17B', tier: 1 }] },
  })
  assert.equal(post.body.ok, true)
  assert.equal(post.body.applied, true, '必须回报 applied，UI 才能显示「立即生效」')
  assert.equal(store.chain.chain.length, 1)

  const get = await call('/chain')
  assert.equal(get.body.effective.length, 2)
  assert.deepEqual(
    get.body.effective.map((e) => `${e.provider}/${e.model}`),
    adapter.getChain().effective.map((e) => `${e.provider}/${e.model}`),
    'GET /chain 的生效链必须与 adapter 实际使用的一致',
  )

  // 覆盖层里的模型立即能选到
  assert.ok(adapter.listModels('cs-myfree').some((m) => m.id === 'Qwen3.5-397B-A17B'))
})

test('🔴 重启一致：chain-overrides.json 同步读回后与写入的链一致（DSH_HOME 隔离）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cs-myfree-chain-'))
  try {
    const st = createState(home)
    const entries = [
      { provider: 'kilo-free', model: 'kilo-auto/free', tier: 1 },     // 别名待归一
      { provider: 'ovh', model: 'Qwen3.5-397B-A17B', tier: 2 },
    ]
    await st.writeChain({ chain: entries, at: 1 })

    // 模拟 index.js 启动路径：同步读 → 归一 → mergeChain
    const persisted = st.readChainSync()
    assert.ok(persisted, '必须能同步读回')
    const normalized = normalizeChainAliases(persisted.chain, (id) => (id === 'kilo-free' ? 'kilo' : id))
    const builtin = [{ provider: 'kilo', model: 'kilo-auto/free', tier: 1 }]
    const effective = mergeChain(builtin, normalized)

    assert.deepEqual(
      effective.map((e) => `${e.provider}/${e.model}`),
      ['kilo/kilo-auto/free', 'ovh/Qwen3.5-397B-A17B'],
      '重启后的生效链必须与页面显示一致（别名已归一、无重复）',
    )
    // 文件不存在 ⇒ readChainSync 返回 null（首启播种路径可区分）
    const empty = await mkdtemp(join(tmpdir(), 'cs-myfree-chain-empty-'))
    try { assert.equal(createState(empty).readChainSync(), null) } finally { await rm(empty, { recursive: true, force: true }) }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('validateOverrides + normalizeChainAliases 去重与别名归一', () => {
  const raw = [
    { provider: 'kilo-free', model: 'kilo-auto/free', tier: 1 },
    { provider: 'kilo', model: 'kilo-auto/free', tier: 2 },
  ]
  // 归一后同键 ⇒ 只留第一条（POST /chain 会先做这一步再校验）
  const n = normalizeChainAliases(raw, (id) => (id === 'kilo-free' ? 'kilo' : id))
  assert.equal(n.length, 1, '归一后只剩一条')
  assert.equal(n[0].provider, 'kilo')
  assert.equal(n[0].tier, 1, '保留第一条的 tier')

  const v = validateOverrides({ chain: raw.map((e) => ({ ...e, provider: e.provider === 'kilo-free' ? 'kilo' : e.provider })) })
  assert.equal(v.ok, false, '归一后重复必须被校验发现（防重复计费/重试）')
  assert.ok(v.errors.some((e) => e.includes('重复')))
})

// ── ③ 渠道链条目（provider=渠道 + 裸模型名）也要走渠道 ──

test('🔴 routeTarget：三种写法都正确分流（渠道/渠道/免密）', async () => {
  const { routeTarget } = await import('../src/index.js')
  // ① 规范 id（选择器）
  assert.deepEqual(routeTarget({ provider: 'cs-myfree', model: 'codearts/deepseek-v4-pro' }), {
    kind: 'channel', channelId: 'codearts', modelId: 'deepseek-v4-pro', model: 'codearts/deepseek-v4-pro',
  })
  // ② 链条目：渠道 + 裸模型名（「17 条渠道链」常见写法）⇒ 补前缀
  assert.deepEqual(routeTarget({ provider: 'codearts', model: 'deepseek-v4-pro' }), {
    kind: 'channel', channelId: 'codearts', modelId: 'deepseek-v4-pro', model: 'codearts/deepseek-v4-pro',
  })
  // ③ 免密源
  assert.equal(routeTarget({ provider: 'kilo', model: 'kilo-auto/free' }).kind, 'keyless')
  assert.equal(routeTarget({ provider: 'kilo-free', model: 'kilo-auto/free' }).kind, 'keyless')
})
