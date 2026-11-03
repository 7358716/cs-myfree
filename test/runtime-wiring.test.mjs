/**
 * 插件装配级集成测试（隔离 DSH_HOME，不联网、不碰生产状态）
 *
 * 用假 ctx 触发 apply()，再通过它真正注册的 HTTP 路由验证：
 *   · P0-1 POST /channels/save 接受 AK:SK（否则 9 家 AK/SK 渠道无法登录）
 *   · P0-3 配置：启动读盘 / POST 后内存热更新 / 重启后仍是新值
 *   · P0-2 链：POST 写盘后 adapter 立即换链（applied:true），重启后一致
 *   · P1-4 GET /models 的 probed 能命中（源 id 与探测 id 归一）
 *   · P1-5 GET /channels/models 暴露 source（内置清单/远端）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'
import { PREFIX } from '../src/web/routes.js'

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'cs-myfree-it-'))
  try {
    return await fn(home)
  } finally {
    // apply() 里有几个 fire-and-forget 异步写（账本/模型缓存）⇒ 清理要重试几次
    for (let i = 0; i < 8; i++) {
      try { await rm(home, { recursive: true, force: true }); break }
      catch { await new Promise((r) => setTimeout(r, 50)) }
    }
  }
}

/** 造一个最小宿主 ctx：inject 同步回调，捕获 llm/webServer 注册 */
function makeHost() {
  const routes = new Map()
  const host = { routes, registered: {}, llm: null }
  const ws = {
    register: (r) => routes.set(String(r.path).replace(PREFIX, ''), r),
  }
  const llm = {
    registerAdapter(providers, adapter) {
      host.registered.providers = providers
      host.registered.adapter = adapter
    },
  }
  host.llm = llm
  host.ctx = {
    app: { version: '0.2.1-rc.2' },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    inject(services, cb) {
      const scoped = {}
      if (services.includes('llm')) scoped.llm = llm
      if (services.includes('webServer')) scoped.webServer = ws
      if (services.includes('web')) scoped.web = { registerSearchProvider() {} }
      try { cb(scoped) } catch { /* 与宿主行为一致：失败不影响其它 inject */ }
    },
  }
  return host
}

async function call(host, path, { method = 'GET', body } = {}) {
  const r = host.routes.get(path)
  if (!r) throw new Error('路由未注册：' + path)
  const res = {
    writeHead: (s) => { res._status = s },
    end: (b) => { try { res._body = JSON.parse(b) } catch { res._body = b } },
  }
  const req = {
    method,
    url: PREFIX + path,
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

test('🔴 装配级：AK:SK 可保存 / 配置热更新与重启一致 / 链保存即生效 / probed 命中 / source 暴露', async () => {
  await withHome(async (home) => {
    const stateDir = join(home, 'cs-myfree')
    await mkdir(stateDir, { recursive: true })
    // 预置：磁盘配置（模拟上次 UI 保存）+ 渠道模型缓存 + 探测缓存
    await writeFile(join(stateDir, 'config.json'), JSON.stringify({ budget: { dailyCNY: 5 } }))
    await writeFile(join(stateDir, 'channel-models.json'), JSON.stringify({
      codearts: {
        at: Date.now(), ok: true, error: null, source: 'builtin',
        models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
      },
    }))
    await writeFile(join(stateDir, 'probe-cache.json'), JSON.stringify({
      at: Date.now(), anyOk: true, okCount: 1, results: [{ id: 'kilo', ok: true, ms: 800, sample: 'pong' }],
    }))

    // ── 第一次启动 ──
    const h1 = makeHost()
    apply(h1.ctx, { dshHome: home })

    // P0-3 启动读盘：GET /config 必须反映磁盘值
    const cfg1 = await call(h1, '/config')
    assert.equal(cfg1.body.config.budget.dailyCNY, 5, '启动时 config.json 必须进入内存 cfg')

    // P1-4 探测 id 归一到源 id
    const models = await call(h1, '/models')
    const kiloSource = models.body.sources.find((s) => s.id === 'kilo-free')
    assert.ok(kiloSource.probed, 'kilo-free 的 probed 必须命中（探测 id=kilo）')
    assert.equal(kiloSource.probeId, 'kilo')

    // P1-5 渠道模型清单来源
    const cm = await call(h1, '/channels/models')
    assert.equal(cm.body.byChannel.codearts.source, 'builtin')
    assert.equal(cm.body.models[0].source, 'builtin')
    assert.equal(cm.body.models[0].id, 'codearts/deepseek-v4-pro')

    // P0-3 热更新：POST 后同一进程立刻读到新值
    const postCfg = await call(h1, '/config', { method: 'POST', body: { budget: { dailyCNY: 7 } } })
    assert.equal(postCfg.body.ok, true)
    const cfg2 = await call(h1, '/config')
    assert.equal(cfg2.body.config.budget.dailyCNY, 7, 'POST /config 必须热更新内存 cfg')
    const st = await call(h1, '/state')
    assert.equal(st.body.config.budget.dailyCNY, 7, '/state 必须与 /config 同源')

    // P0-2 链保存后 adapter 立即换链
    const postChain = await call(h1, '/chain', {
      method: 'POST',
      body: { chain: [
        { provider: 'kilo-free', model: 'kilo-auto/free', tier: 1 },   // 别名 → 归一为 kilo
        { provider: 'ovh', model: 'Qwen3.5-397B-A17B', tier: 2 },
      ] },
    })
    assert.equal(postChain.body.ok, true)
    assert.equal(postChain.body.applied, true, 'POST /chain 必须回报 applied')
    assert.equal(h1.registered.adapter.getChain().overrides.length, 2, 'adapter 必须真的换链了')
    assert.equal(h1.registered.adapter.getChain().overrides[0].provider, 'kilo', '别名必须归一再入链')

    const getChain = await call(h1, '/chain')
    assert.deepEqual(
      getChain.body.effective.map((e) => `${e.provider}/${e.model}`),
      h1.registered.adapter.getChain().effective.map((e) => `${e.provider}/${e.model}`),
      'GET /chain 与 adapter 实际链必须一致',
    )

    // P0-1 AK:SK 保存（用 buddy：无 models 端点 ⇒ 不会触发网络请求）
    const save = await call(h1, '/channels/save', {
      method: 'POST',
      body: { provider: 'buddy', credential: 'AKIDtest123456:SKsecret7890123456' },
    })
    assert.equal(save.body.ok, true, 'AK:SK 形态必须被接受（P0-1）：' + JSON.stringify(save.body))
    assert.equal(save.body.kind, 'aksk')
    // 结构化字段提交（签名型渠道的正式形态）
    const save2 = await call(h1, '/channels/save', {
      method: 'POST',
      body: { provider: 'buddy', ak: 'AKIDtest1234567890', sk: 'SKsecret1234567890123456789012345678901234' },
    })
    assert.equal(save2.body.ok, true)
    const onlyAk = await call(h1, '/channels/save', { method: 'POST', body: { provider: 'buddy', ak: 'AKIDtest1234567890' } })
    assert.equal(onlyAk.body.ok, false, '只有 AK 必须拒绝（说明还缺 SK）')

    // ── 第二次启动（模拟重启）：配置与链都必须从磁盘恢复 ──
    const h2 = makeHost()
    apply(h2.ctx, { dshHome: home })
    const cfg3 = await call(h2, '/config')
    assert.equal(cfg3.body.config.budget.dailyCNY, 7, '重启后配置必须仍是新值')
    const chain2 = await call(h2, '/chain')
    assert.equal(chain2.body.overrides.length, 2, '重启后覆盖层必须仍在')
    assert.deepEqual(
      chain2.body.effective.map((e) => `${e.provider}/${e.model}`),
      h1.registered.adapter.getChain().effective.map((e) => `${e.provider}/${e.model}`),
      '重启后的生效链必须与重启前一致',
    )
    assert.equal(h2.registered.adapter.getChain().overrides.length, 2, '重启后 adapter 必须用磁盘上的覆盖层')
  })
})
