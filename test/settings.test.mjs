/**
 * 设置页四层作用域 + 权限 meta + settings API + T3a/T3b 测试
 *
 * 覆盖（design/19 DoD#2）：
 *   · 四层合并优先级（global → workspace → session → team 后覆盖前）
 *   · _meta.owner 锁定语义（admin 写的层非 admin 只读）
 *   · patch 删字段恢复继承（{path:null}）+ 数组整体替换
 *   · settings API 读写往返（注入 deps + 临时目录）
 *   · 敏感字段拦截（顶层 + 嵌套）与读取剥离
 *   · queryArkBalance 三分支（无 key → error / 账本估算 → estimated / 注入 → live）
 *   · /models 自定义渠道 error 透传（T3b）
 *   · effective.config 不含 _meta（P4）、listScopes 识别五类、recent 读 ledger.jsonl
 *
 * 需求 #6（渠道「是否可用 / 是否展示 / 状态」表格 + 展示开关）：
 *   · 默认可见集合 = deepseek 系 + 自加 API + 免费可用 + 华为云（其它渠道包默认隐藏）
 *   · hidden 生效但**与 disabled 严格分开**（隐藏 ≠ 禁用：路由链/自动切换仍可用）
 *   · PATCH /settings { sources: { hidden: [...] } } 往返 + null 恢复默认
 *   · 非法值被拒（非数组 / 非字符串 / 空 id / 超长 / 非法字符）且不落盘
 *   · 渠道表格每行字段齐全（id/name/group/available/loginVerified/status/hidden/reason）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SCOPE, scopeFile, readScope, writeScope, effectiveConfig, listScopes, ownerOf,
} from '../src/config/scope.js'
import { applyPatch, readSettings, updateSettings, channelStatusList, readRecentRecords } from '../src/web/settings.js'
import { queryArkBalance, queryCash } from '../src/web/cash.js'
import {
  findSensitiveKey, stripSensitive, DEFAULTS,
  DEFAULT_HIDDEN_SOURCES, DEFAULT_VISIBLE_SOURCES,
  CHANNEL_GROUP, CHANNEL_GROUP_LABELS,
  resolveHiddenSources, isHiddenByDefault, isSourceHidden, channelGroupOf,
  normalizeSourceId, validateHiddenSources,
} from '../src/config/store.js'
import { filterVisibleCatalog, visibleCatalog, visibilitySummary, createRoutingSnapshot, dedupeModelsVisible } from '../src/web/routing.js'
import { SOURCES } from '../src/pools/registry.js'
import { CHANNELS } from '../src/pools/channels/protocols.js'
import { registerRoutes, PREFIX } from '../src/web/routes.js'

/** 临时 dshHome（每用例独立目录） */
function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'cs-myfree-st-'))
  mkdirSync(join(dir, 'cs-myfree'), { recursive: true })
  return dir
}
function cleanup(home) {
  rmSync(home, { recursive: true, force: true })
}

/** 隔离 ARK_API_KEY 环境变量（用例内调用，finally 恢复） */
function withoutArkKey() {
  const saved = process.env.ARK_API_KEY
  delete process.env.ARK_API_KEY
  return () => { if (saved === undefined) delete process.env.ARK_API_KEY; else process.env.ARK_API_KEY = saved }
}

// ── 四层合并优先级 ─────────────────────────────────────────────────────────
test('四层合并：global ← workspace ← session ← team（后覆盖前）', async () => {
  const home = makeHome()
  try {
    await writeScope(home, SCOPE.GLOBAL, undefined, { model: { default: 'g-model' }, budget: { perCallCNY: 1 }, sources: { disabled: ['a'] } })
    await writeScope(home, SCOPE.WORKSPACE, 'dev', { model: { default: 'w-model' }, budget: { perCallCNY: 2 } })
    await writeScope(home, SCOPE.SESSION, 's1', { budget: { dailyCNY: 5 } })
    await writeScope(home, SCOPE.TEAM, 't1', { budget: { perCallCNY: 9 } })
    const eff = await effectiveConfig({ dshHome: home, workspaceId: 'dev', sessionId: 's1', teamId: 't1' })
    assert.equal(eff.config.model.default, 'w-model', 'workspace 覆盖 global')
    assert.equal(eff.config.budget.perCallCNY, 9, 'team 最窄最优先')
    assert.equal(eff.config.budget.dailyCNY, 5, 'session 覆盖')
    assert.equal(eff.config.sources.disabled[0], 'a', 'global 未被覆盖的字段保留')
    // 无 workspace 时回落 global
    const eff2 = await effectiveConfig({ dshHome: home, sessionId: 's1', teamId: 't1' })
    assert.equal(eff2.config.model.default, 'g-model')
    // 无任何窄层时 = global
    const eff3 = await effectiveConfig({ dshHome: home })
    assert.equal(eff3.config.model.default, 'g-model')
    assert.equal(eff3.config.budget.perCallCNY, 1)
  } finally { cleanup(home) }
})

test('preset 保留读取兼容（合并链里仍在 workspace 前）', async () => {
  const home = makeHome()
  try {
    await writeScope(home, SCOPE.GLOBAL, undefined, { model: { default: 'g' } })
    await writeScope(home, SCOPE.PRESET, 'p1', { model: { default: 'p' }, budget: { perCallCNY: 7 } })
    await writeScope(home, SCOPE.WORKSPACE, 'dev', { budget: { perCallCNY: 8 } })
    const eff = await effectiveConfig({ dshHome: home, presetId: 'p1', workspaceId: 'dev' })
    assert.equal(eff.config.model.default, 'p', 'preset 覆盖 global')
    assert.equal(eff.config.budget.perCallCNY, 8, 'workspace 覆盖 preset')
  } finally { cleanup(home) }
})

test('effective.config 不含 _meta（P4）；byLayer 保留 owner', async () => {
  const home = makeHome()
  try {
    await writeScope(home, SCOPE.GLOBAL, undefined, { model: { default: 'g' } }, { owner: 'admin', updatedAt: 1 })
    const eff = await effectiveConfig({ dshHome: home })
    assert.equal('_meta' in eff.config, false, 'config 里不得混入 _meta')
    assert.equal(eff.byLayer.global._meta.owner, 'admin', 'byLayer 保留 _meta 供 owner 判定')
  } finally { cleanup(home) }
})

test('listScopes 识别全部五类文件', async () => {
  const home = makeHome()
  try {
    await writeScope(home, SCOPE.GLOBAL, undefined, { a: 1 })
    await writeScope(home, SCOPE.WORKSPACE, 'dev', { a: 1 })
    await writeScope(home, SCOPE.SESSION, 's1', { a: 1 })
    await writeScope(home, SCOPE.TEAM, 't1', { a: 1 })
    await writeScope(home, SCOPE.PRESET, 'p1', { a: 1 })
    const list = await listScopes(home)
    assert.ok(list.some((x) => x.scope === 'global'))
    assert.ok(list.some((x) => x.scope === 'workspace' && x.id === 'dev'), 'workspace 文件识别')
    assert.ok(list.some((x) => x.scope === 'session' && x.id === 's1'))
    assert.ok(list.some((x) => x.scope === 'team' && x.id === 't1'), 'team 文件识别')
    assert.ok(list.some((x) => x.scope === 'preset' && x.id === 'p1'))
  } finally { cleanup(home) }
})

// ── applyPatch：删字段恢复继承 + 数组整体替换 ───────────────────────────────
test('applyPatch：对象递归合并 + 数组整体替换 + null 删除', () => {
  const base = { a: { x: 1, y: 2 }, list: ['a'], s: 'old', keep: 1 }
  const out = applyPatch(base, { a: { y: 3, z: 4 }, list: ['b'], s: null, absent: null })
  assert.deepEqual(out, { a: { x: 1, y: 3, z: 4 }, list: ['b'], keep: 1 })
})

test('patch 删字段恢复继承（workspace 删 model.default ⇒ 回 global）', async () => {
  const home = makeHome()
  try {
    await writeScope(home, SCOPE.GLOBAL, undefined, { model: { default: 'g' }, budget: { perCallCNY: 1 } })
    await writeScope(home, SCOPE.WORKSPACE, 'dev', { model: { default: 'w' } })
    // 删除 workspace 层该字段
    const merged = applyPatch({ model: { default: 'w' } }, { model: { default: null } })
    assert.deepEqual(merged, {})
    await writeScope(home, SCOPE.WORKSPACE, 'dev', merged)
    const eff = await effectiveConfig({ dshHome: home, workspaceId: 'dev' })
    assert.equal(eff.config.model.default, 'g', '删除后恢复继承 global')
  } finally { cleanup(home) }
})

// ── owner 锁定语义 ─────────────────────────────────────────────────────────
test('owner 锁定：user 可写可再改 → admin 覆盖 → user 被拒 locked:true', async () => {
  const home = makeHome()
  try {
    const deps = { dshHome: home, isAdmin: () => false, now: () => 1000 }
    // user 写
    const r1 = await updateSettings(deps, { scope: 'global', patch: { budget: { perCallCNY: 2 } } })
    assert.equal(r1.ok, true)
    assert.equal(r1.owner, 'user')
    // user 可再改自己的层
    const r2 = await updateSettings(deps, { scope: 'global', patch: { budget: { dailyCNY: 3 } } })
    assert.equal(r2.ok, true)
    assert.equal(r2.effective.config.budget.perCallCNY, 2, 'patch 只写给定字段')
    // admin 覆盖 ⇒ owner 变 admin
    const r3 = await updateSettings({ dshHome: home, isAdmin: () => true, now: () => 1002 }, { scope: 'global', patch: { budget: { monthlyCNY: 4 } } })
    assert.equal(r3.ok, true)
    assert.equal(r3.owner, 'admin')
    // user 再改 ⇒ 拒绝 + locked
    const r4 = await updateSettings(deps, { scope: 'global', patch: { budget: { perCallCNY: 9 } } })
    assert.equal(r4.ok, false)
    assert.equal(r4.locked, true)
    assert.match(r4.error, /管理员统一管理/)
    // admin 可覆盖
    const r5 = await updateSettings({ dshHome: home, isAdmin: () => true }, { scope: 'global', patch: { budget: { perCallCNY: 8 } } })
    assert.equal(r5.ok, true)
    // 层 owner 已落盘
    const disk = await readScope(home, SCOPE.GLOBAL)
    assert.equal(ownerOf(disk), 'admin')
  } finally { cleanup(home) }
})

// ── 敏感字段拦截 + 读取剥离 ─────────────────────────────────────────────────
test('敏感字段拦截：顶层 apiKey / 嵌套 transportHeaders.authorization', async () => {
  const home = makeHome()
  try {
    const deps = { dshHome: home, isAdmin: () => true }
    const r1 = await updateSettings(deps, { scope: 'global', patch: { apiKey: 'x' } })
    assert.equal(r1.ok, false)
    assert.match(r1.error, /敏感/)
    const r2 = await updateSettings(deps, { scope: 'global', patch: { transportHeaders: { authorization: 'Bearer x' } } })
    assert.equal(r2.ok, false)
    assert.match(r2.error, /transportHeaders.authorization/)
    // 直接 writeScope 也拦（红线保持）
    await assert.rejects(writeScope(home, SCOPE.GLOBAL, undefined, { cookie: 'x' }), /敏感/)
    // 拦截时不落盘
    const eff = await effectiveConfig({ dshHome: home })
    assert.deepEqual(eff.config, {})
  } finally { cleanup(home) }
})

test('读取路径剥离磁盘脏数据（apiKey/嵌套 token 不回给 UI）', async () => {
  const home = makeHome()
  try {
    const file = scopeFile(home, SCOPE.GLOBAL)
    writeFileSync(file, JSON.stringify({ budget: { perCallCNY: 1 }, apiKey: 'SECRET1', nested: { token: 'SECRET2' } }))
    const eff = await effectiveConfig({ dshHome: home })
    assert.equal(JSON.stringify(eff.config).includes('SECRET'), false, '读路径必须剥离')
    assert.equal(eff.config.budget.perCallCNY, 1)
  } finally { cleanup(home) }
})

// ── settings API 读写往返（注入 deps）──────────────────────────────────────
test('settings 读写往返：写 global → 读 → team 覆盖 → 删字段恢复', async () => {
  const home = makeHome()
  try {
    const deps = {
      dshHome: home,
      isAdmin: () => true,
      getContext: () => ({ workspaceId: 'dev', sessionId: 's1', teamId: 't1' }),
      modelCatalog: async () => ([{ kind: 'channel', provider: 'codearts', label: 'CodeArts', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek' }] }]),
      routingSnapshot: () => ({ gate: { kilo: { coolingMs: 0 } }, blacklist: [] }),
      ledger: async () => ({ failures: { byCode: {}, byProvider: {} } }),
      channels: async () => ([{ id: 'kilo', label: 'Kilo' }]),
      now: () => 12345,
    }
    // 写 global
    const w = await updateSettings(deps, { scope: 'global', patch: { model: { default: 'deepseek-v4.1-flash' }, budget: { perCallCNY: 3 } } })
    assert.equal(w.ok, true)
    // 读
    const g = await readSettings(deps, new URLSearchParams())
    assert.equal(g.ok, true)
    assert.deepEqual(g.layers.map((l) => l.scope), ['global', 'workspace', 'session', 'team'], '四层清单')
    const gLayer = g.layers.find((l) => l.scope === 'global')
    assert.equal(gLayer.owner, 'admin')
    assert.equal(gLayer.setKeys, 2)
    assert.equal(gLayer.config.model.default, 'deepseek-v4.1-flash')
    assert.equal(g.effective.config.budget.perCallCNY, 3)
    assert.equal(g.meta.isAdmin, true)
    assert.equal(g.meta.context.workspaceId, 'dev')
    assert.equal(g.channels.length, 1)
    assert.equal(g.models[0].models[0].id, 'deepseek-v4.1-flash')
    // 写 team 覆盖
    await updateSettings(deps, { scope: 'team', id: 't1', patch: { budget: { perCallCNY: 9 } } })
    const g2 = await readSettings(deps, new URLSearchParams())
    assert.equal(g2.effective.config.budget.perCallCNY, 9, 'team 覆盖 global')
    // 删 team 字段 ⇒ 恢复 global
    await updateSettings(deps, { scope: 'team', id: 't1', patch: { budget: { perCallCNY: null } } })
    const g3 = await readSettings(deps, new URLSearchParams())
    assert.equal(g3.effective.config.budget.perCallCNY, 3, '删除后恢复继承')
    // query 参数覆盖 context
    const g4 = await readSettings(deps, new URLSearchParams({ workspaceId: 'other', sessionId: 's9', teamId: 't9' }))
    assert.equal(g4.layers.find((l) => l.scope === 'workspace').id, 'other')
    assert.equal(g4.layers.find((l) => l.scope === 'team').id, 't9')
  } finally { cleanup(home) }
})

test('updateSettings：未知作用域 / 缺 id / 空 patch / 非对象 patch', async () => {
  const home = makeHome()
  try {
    const deps = { dshHome: home, isAdmin: () => true }
    assert.equal((await updateSettings(deps, { scope: 'nope', patch: {} })).ok, false)
    assert.equal((await updateSettings(deps, { scope: 'workspace', patch: {} })).ok, false, '非 global 缺 id')
    assert.equal((await updateSettings(deps, { scope: 'global', patch: {} })).ok, false, '空 patch')
    assert.equal((await updateSettings(deps, { scope: 'global', patch: null })).ok, false)
    const ok = await updateSettings(deps, { scope: 'global', patch: { a: 1 } })
    assert.equal(ok.ok, true)
    assert.equal(ok.hint, '已保存，下次请求生效')
  } finally { cleanup(home) }
})

// ── 渠道状态聚合 ───────────────────────────────────────────────────────────
test('渠道状态：正常/冷却/失败N次/拉黑 + usable 开关', () => {
  const routing = { gate: { kilo: { coolingMs: 5000 } }, blacklist: [{ provider: 'buddy', kind: 'AUTH', until: 1, remainMs: 3600000 }] }
  const ledger = { failures: { byProvider: { qoder: 3 } } }
  const eff = { sources: { disabled: ['trae'] } }
  const list = channelStatusList(
    [{ id: 'kilo', label: 'Kilo' }, { id: 'buddy', label: 'Buddy' }, { id: 'qoder', label: 'Qoder' }, { id: 'trae', label: 'Trae' }],
    routing, ledger, eff,
  )
  assert.equal(list[0].state, 'cooling')
  assert.equal(list[1].state, 'failed')
  assert.equal(list[1].blacklisted, true)
  assert.equal(list[1].blacklistKind, 'AUTH')
  assert.equal(list[2].state, 'failed')
  assert.equal(list[2].failCount, 3)
  assert.equal(list[3].usable, false, 'disabled 清单里的渠道开关 off')
  assert.equal(list[0].usable, true)
})

// ── recent：读真实账本 ledger.jsonl（P1）───────────────────────────────────
test('recent 从 ledger.jsonl 读最后 N 条（不是 spend.jsonl）', async () => {
  const home = makeHome()
  try {
    const dir = join(home, 'cs-myfree')
    for (let i = 1; i <= 7; i++) {
      writeFileSync(join(dir, 'ledger.jsonl'),
        JSON.stringify({ at: 1000 + i, day: '2026-11-05', provider: 'kilo', model: 'm' + i, ms: 10 * i, ok: i % 2 === 0, code: i % 2 === 0 ? null : 'AUTH' }) + '\n',
        { flag: 'a' })
    }
    const rec = await readRecentRecords({ dshHome: home, limit: 5 })
    assert.equal(rec.length, 5)
    assert.equal(rec[0].model, 'm3', '取最后 5 条')
    assert.equal(rec[4].at, 1007)
    assert.equal(rec[4].ok, false)
    assert.equal(rec[4].code, 'AUTH')
    assert.equal(rec[4].ms, 70)
  } finally { cleanup(home) }
})

// ── T3a：ark 余额三分支 ────────────────────────────────────────────────────
test('ark 余额：无 key → error（中文原因）', async () => {
  const restore = withoutArkKey()
  try {
    const r = await queryArkBalance({}, {})
    assert.equal(r.provider, 'ark')
    assert.equal(r.source, 'error')
    assert.equal(r.total, null)
    assert.match(r.error, /ARK_API_KEY/)
  } finally { restore() }
})

test('ark 余额：有 key 无主账号 AK/SK → estimated（诚实标注）', async () => {
  const restore = withoutArkKey()
  try {
    const home = makeHome()
    const ctx = { get: () => ({ resolve: async () => ({ value: 'ark-probe-key-123' }) }) }
    const r = await queryArkBalance(ctx, { dshHome: home })
    assert.equal(r.source, 'estimated')
    assert.equal(r.currency, 'CNY')
    assert.ok(r.note, '必须带估算说明')
    assert.match(r.note, /估算|AK\/SK/)
    cleanup(home)
  } finally { restore() }
})

test('ark 余额：注入 volcBalance（主账号 AK/SK）→ live；失败 → error 透传', async () => {
  const restore = withoutArkKey()
  try {
    const ok = await queryArkBalance({}, { volcBalance: async () => ({ ok: true, total: 12.34, currency: 'CNY' }) })
    assert.equal(ok.source, 'live')
    assert.equal(ok.total, 12.34)
    assert.equal(ok.currency, 'CNY')
    const bad = await queryArkBalance({}, { volcBalance: async () => ({ ok: false, error: 'AK/SK 签名失败' }) })
    assert.equal(bad.source, 'error')
    assert.match(bad.error, /签名失败/)
  } finally { restore() }
})

test('queryCash 返回 deepseek + ark（ark 独立于 deepseek 成败）', async () => {
  const restore = withoutArkKey()
  try {
    const ctx = { get: () => ({ resolve: async (k) => ({ value: k === 'DEEPSEEK_API_KEY' ? 'sk-x' : 'ark-y' }) }) }
    const r = await queryCash(ctx, {
      fetchImpl: async () => ({ ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '8.88' }] }) }),
      dshHome: makeHome(),
    })
    assert.equal(r.deepseek.balances[0].total, 8.88)
    assert.equal(r.ark.provider, 'ark')
    assert.ok(['estimated', 'error', 'live'].includes(r.ark.source))
    // 无 deepseek key 时 ark 仍给出（独立）
    const r2 = await queryCash({}, { fetchImpl: async () => { throw new Error('不应调用') }, dshHome: makeHome() })
    assert.equal(r2.deepseek, null)
    assert.equal(r2.ark.provider, 'ark')
  } finally { restore() }
})

// ── T3b：/models 渠道 error 透传（routes 集成）──────────────────────────────
function makeServer() {
  const routes = new Map()
  return {
    register: (r) => routes.set(r.path.replace(PREFIX, ''), r),
    get: (p) => routes.get(p),
  }
}
async function call(server, path, { method = 'GET', body, headers = {}, remote = '127.0.0.1' } = {}) {
  const r = server.get(path)
  if (!r) throw new Error('no route ' + path)
  const res = {
    writeHead: (s, h) => { res._status = s; res._headers = h },
    end: (b) => { try { res._body = JSON.parse(b) } catch { res._body = b } },
  }
  const req = {
    method, url: PREFIX + path,
    headers: Object.assign({ host: 'localhost:3080' }, headers),
    socket: { remoteAddress: remote },
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

test('/models 透传渠道 error（T3b：mock 缓存带 error）', async () => {
  const home = makeHome()
  try {
    writeFileSync(join(home, 'cs-myfree', 'channel-models.json'), JSON.stringify({
      codearts: { ok: false, error: 'HTTP 401', source: 'builtin-after-http-error', at: Date.now(), models: [] },
      kilo: { ok: true, error: null, source: 'remote', at: Date.now(), models: [{ id: 'm1', name: 'M1' }] },
    }))
    const srv = makeServer()
    registerRoutes(srv, { state: makeState(), version: 'test', trustedHosts: [], dshHome: home, getChain: () => [], getConfig: () => ({}) })
    const r = await call(srv, '/models')
    assert.equal(r.status, 200)
    const ch = r.body.channels
    const ca = ch.find((c) => c.id === 'codearts')
    assert.equal(ca.ok, false)
    assert.equal(ca.error, 'HTTP 401', '错误必须透传，不静默回落')
    assert.equal(ca.source, 'builtin-after-http-error')
    const ki = ch.find((c) => c.id === 'kilo')
    assert.equal(ki.ok, true)
    assert.equal(ki.error, null)
  } finally { cleanup(home) }
})

test('settings 路由挂载 + 读写往返（routes 层）', async () => {
  const home = makeHome()
  try {
    const srv = makeServer()
    registerRoutes(srv, {
      state: makeState(), version: 'test', trustedHosts: [], dshHome: home,
      getChain: () => [], getConfig: () => ({}),
      isAdmin: () => true,
      getSettingsContext: () => ({ workspaceId: 'dev' }),
    })
    // GET
    const g = await call(srv, '/settings')
    assert.equal(g.status, 200)
    assert.equal(g.body.ok, true)
    assert.deepEqual(g.body.layers.map((l) => l.scope), ['global', 'workspace', 'session', 'team'])
    assert.equal(g.body.meta.isAdmin, true)
    // POST 写
    const w = await call(srv, '/settings', { method: 'POST', body: { scope: 'global', patch: { model: { default: 'kilo-auto/free' } } } })
    assert.equal(w.status, 200)
    assert.equal(w.body.ok, true)
    // 再读（往返）
    const g2 = await call(srv, '/settings')
    assert.equal(g2.body.effective.config.model.default, 'kilo-auto/free')
    // 敏感拦截过 API
    const bad = await call(srv, '/settings', { method: 'POST', body: { scope: 'global', patch: { apiKey: 'x' } } })
    assert.equal(bad.body.ok, false)
    assert.match(bad.body.error, /敏感/)
  } finally { cleanup(home) }
})

// ══════════════════════════════════════════════════════════════════════════
// 需求 #6：渠道「是否可用 / 是否展示 / 状态」表格 + 展示开关（hidden）
// ══════════════════════════════════════════════════════════════════════════

// ── 默认可见集合 ───────────────────────────────────────────────────────────
test('展示开关：DEFAULTS 里 hidden 与 disabled 是两个键（空数组，零回归）', () => {
  assert.deepEqual(DEFAULTS.sources.hidden, [], 'schema 默认空数组')
  assert.deepEqual(DEFAULTS.sources.disabled, [], '停用清单另有一份，不得混用')
  assert.notEqual('hidden' in DEFAULTS.sources, false)
  // 语义说明（写死成断言，防后人"合并"两个键）：
  assert.equal(
    resolveHiddenSources({}).explicit, false,
    '没写 hidden ⇒ 走默认可见集合（不是"全部展示"）',
  )
  assert.deepEqual(
    resolveHiddenSources({ sources: { hidden: [] } }).list, [],
    '显式空数组 ⇒ 全部展示',
  )
})

test('默认可见集合：deepseek 系 / 自加 API / 免费可用 / 华为云 可见，其它渠道包默认隐藏', () => {
  const r = resolveHiddenSources({})
  assert.equal(r.explicit, false)
  assert.equal(r.source, 'default')
  for (const id of ['deepseek-official', 'ark', 'kilo', 'kilo-free', 'ovh', 'ovh-vision', 'pollinations', 'codearts', 'officeace']) {
    assert.equal(r.set.has(normalizeSourceId(id)), false, `${id} 默认应可见`)
  }
  for (const id of ['buddy', 'workbuddy', 'qoder', 'qodercn', 'trae', 'loomy', 'gemini', 'minimax', 'zcode']) {
    assert.equal(r.set.has(id), true, `${id} 默认应隐藏`)
  }
  // 分组口径
  assert.equal(channelGroupOf('codearts'), CHANNEL_GROUP.HUAWEI)
  assert.equal(channelGroupOf('officeace'), CHANNEL_GROUP.HUAWEI)
  assert.equal(channelGroupOf('deepseek-official'), CHANNEL_GROUP.DEEPSEEK)
  assert.equal(channelGroupOf('ark'), CHANNEL_GROUP.SELFAPI)
  assert.equal(channelGroupOf('kilo-free'), CHANNEL_GROUP.FREE)
  assert.equal(channelGroupOf('buddy'), CHANNEL_GROUP.CHANNEL)
  assert.equal(channelGroupOf('some-user-added-id'), CHANNEL_GROUP.OTHER, '认不出来的（用户自加）不默认藏')
  assert.equal(CHANNEL_GROUP_LABELS[CHANNEL_GROUP.HUAWEI], '华为云')
})

test('漂移哨兵：registry/protocols 里的每个渠道 id 都必须被分类（新增渠道忘了分类会红）', () => {
  const registryIds = SOURCES.map((s) => normalizeSourceId(s.id))
  const channelIds = Object.keys(CHANNELS).map(normalizeSourceId)
  const all = [...new Set([...registryIds, ...channelIds])]
  for (const id of all) {
    const g = channelGroupOf(id)
    assert.notEqual(g, CHANNEL_GROUP.OTHER, `渠道 ${id} 没有归组/默认可视性登记（改 store.js 的 DEFAULT_HIDDEN_SOURCES）`)
    if (g === CHANNEL_GROUP.CHANNEL) assert.equal(isHiddenByDefault(id), true, `${id} 属其它渠道包 ⇒ 应默认隐藏`)
    else assert.equal(isHiddenByDefault(id), false, `${id} 属 ${g} ⇒ 应默认可见`)
  }
  // 默认隐藏清单里不许出现已不存在的 id（改名后忘删）
  for (const id of DEFAULT_HIDDEN_SOURCES) {
    assert.ok(all.includes(normalizeSourceId(id)), `DEFAULT_HIDDEN_SOURCES 里的 ${id} 已不存在`)
  }
  for (const id of DEFAULT_VISIBLE_SOURCES) {
    assert.equal(all.includes(normalizeSourceId(id)), true, `DEFAULT_VISIBLE_SOURCES 里的 ${id} 已不存在`)
    assert.equal(isHiddenByDefault(id), false)
  }
  // 两个集合不许重叠
  const overlap = DEFAULT_HIDDEN_SOURCES.filter((id) => DEFAULT_VISIBLE_SOURCES.includes(id))
  assert.deepEqual(overlap, [], '默认隐藏 / 默认可见 不许有交集')
})

test('hidden 解析口径：显式清单为准、别名归一到同一渠道（kilo-free ≡ kilo）', () => {
  const r = resolveHiddenSources({ sources: { hidden: [' Buddy ', 'kilo-free'] } })
  assert.equal(r.explicit, true)
  assert.deepEqual(r.list, ['buddy', 'kilo'])
  assert.equal(isSourceHidden('buddy', { sources: { hidden: ['Buddy'] } }), true)
  assert.equal(isSourceHidden('KILO-FREE', { sources: { hidden: ['kilo'] } }), true)
  assert.equal(isSourceHidden('codearts', { sources: { hidden: ['buddy'] } }), false)
})

// ── hidden 生效 + 与 disabled 分清（隐藏 ≠ 禁用）────────────────────────────
test('渠道表格：hidden 生效，但与 disabled 严格分开（同一行可 available=true + hidden=true）', () => {
  const channels = [
    { id: 'codearts', label: 'CodeArts（华为云）', login: 'device-code', loggedIn: true, loginVerified: true, implemented: true },
    { id: 'buddy', label: 'CodeBuddy（腾讯）', login: 'browser-callback', loggedIn: true, loginVerified: true, implemented: true },
  ]
  const rows = channelStatusList(channels, { gate: {}, blacklist: [] }, { failures: { byProvider: {} } }, { sources: { hidden: ['buddy'] } })
  const [ca, bu] = rows
  assert.equal(bu.hidden, true, 'hidden 清单里的渠道 hidden=true')
  assert.equal(bu.defaultHidden, true, '默认也是隐藏')
  assert.equal(bu.available, true, '🔴 隐藏 ≠ 禁用：渠道依然可用')
  assert.equal(ca.hidden, false, '华为云默认可见')
  assert.equal(ca.available, true)
  // disabled 才是真停用
  const rows2 = channelStatusList(channels, { gate: {}, blacklist: [] }, { failures: { byProvider: {} } }, { sources: { disabled: ['buddy'] } })
  assert.equal(rows2[1].usable, false)
  assert.equal(rows2[1].available, false, 'disabled ⇒ 不可用')
  assert.equal(rows2[1].reasonCode, 'disabled')
  assert.equal(rows2[1].hidden, true, '未设 hidden ⇒ 仍按默认集合（buddy 属渠道包）')
})

test('渠道表格：每行字段齐全（id/name/group/available/loginVerified/status/hidden/reason）', async () => {
  const home = makeHome()
  try {
    const deps = {
      dshHome: home,
      isAdmin: () => true,
      getContext: () => ({}),
      channels: async () => ([
        { id: 'codearts', label: 'CodeArts（华为云）', login: 'device-code', loggedIn: true, loginVerified: true, implemented: true },
        { id: 'officeace', label: 'OfficeAce（华为 MaaS）', login: 'device-code', loggedIn: false, loginVerified: false, implemented: true },
        { id: 'qoder', label: 'Qoder', login: 'device-code', loggedIn: true, loginVerified: false, implemented: false, reason: '推理链路需 WASM 加密签名，暂不支持' },
        { id: 'buddy', label: 'CodeBuddy（腾讯）', login: 'browser-callback', loggedIn: true, loginVerified: true, implemented: true },
      ]),
      routingSnapshot: () => ({ gate: {}, blacklist: [] }),
      ledger: async () => ({ failures: { byProvider: {} } }),
      modelCatalog: async () => ([
        { kind: 'channel', provider: 'codearts', label: 'CodeArts', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek' }] },
        { kind: 'channel', provider: 'buddy', label: 'Buddy', models: [{ id: 'b1', name: 'B1' }] },
      ]),
      now: () => 1,
    }
    const g = await readSettings(deps, new URLSearchParams())
    const byId = Object.fromEntries(g.channels.map((c) => [c.id, c]))
    for (const c of g.channels) {
      for (const k of ['id', 'name', 'group', 'available', 'loginVerified', 'status', 'hidden', 'reason']) {
        assert.ok(k in c, `行 ${c.id} 缺字段 ${k}`)
      }
      assert.equal(typeof c.available, 'boolean')
      assert.equal(typeof c.hidden, 'boolean')
      assert.equal(typeof c.loginVerified, 'boolean')
      assert.equal(typeof c.status, 'string')
      assert.ok(c.reason === null || typeof c.reason === 'string')
    }
    // 华为云可见
    assert.equal(byId.codearts.hidden, false)
    assert.equal(byId.codearts.group, 'huawei')
    assert.equal(byId.codearts.status, '正常')
    assert.equal(byId.officeace.hidden, false)
    assert.equal(byId.officeace.available, false)
    assert.equal(byId.officeace.reasonCode, 'not-logged-in')
    assert.match(byId.officeace.reason, /登录/)
    assert.equal(byId.officeace.status, '未登录')
    // 其它渠道包默认隐藏
    assert.equal(byId.buddy.hidden, true)
    assert.equal(byId.qoder.hidden, true)
    // 不可用要如实说原因（不假装可用）
    assert.equal(byId.qoder.available, false)
    assert.equal(byId.qoder.reasonCode, 'unimplemented')
    assert.match(byId.qoder.status, /暂不可用/)
    assert.match(byId.qoder.reason, /WASM/)
    // 展示开关实况 + 选择器目录（已过滤 hidden）
    assert.equal(g.visibility.explicit, false)
    assert.equal(g.visibility.source, 'default')
    // 没设显式清单 ⇒ visibility.hidden = 整个默认隐藏集合（表格里逐行标 hidden）
    assert.deepEqual(g.visibility.hidden.slice().sort(), DEFAULT_HIDDEN_SOURCES.slice().sort())
    assert.equal(g.visibility.hidden.includes('codearts'), false)
    assert.equal(g.visibility.hidden.includes('officeace'), false)
    assert.deepEqual(g.modelsVisible.map((m) => m.provider), ['codearts'], '对话选择器目录里没有 buddy')
    assert.deepEqual(g.models.map((m) => m.provider), ['codearts', 'buddy'], '设置页目录仍给全量')
  } finally { cleanup(home) }
})

test('🔴 hidden 不影响路由链与自动切换（隐藏 ≠ 禁用）', () => {
  // 假 adapter：链里有被隐藏的 buddy，准入也把它选进来了
  const adapter = {
    chainSnapshot: () => ([
      { provider: 'buddy', model: 'buddy/m1', tier: 1 },
      { provider: 'codearts', model: 'deepseek-v4.1-flash', tier: 1 },
    ]),
    admissionSnapshot: () => ({ at: 1, stats: { total: 2, kept: 2 }, excluded: [], eligible: ['buddy', 'codearts'] }),
    blacklistSnapshot: () => [],
    routingConfigSnapshot: () => ({}),
    switchSnapshot: () => null,
  }
  const snap = createRoutingSnapshot({ adapterOf: () => adapter, now: () => 7 })()
  const catalog = [
    { provider: 'buddy', label: 'Buddy', models: [{ id: 'b1', name: 'B1' }] },
    { provider: 'codearts', label: 'CodeArts', models: [{ id: 'deepseek-v4.1-flash', name: 'D' }] },
  ]
  const cfg = { sources: { hidden: ['buddy'] } }

  // ① catalog（对话选择器）里没了
  const filtered = filterVisibleCatalog(catalog, cfg)
  assert.deepEqual(filtered.sources.map((s) => s.provider), ['codearts'])
  assert.deepEqual(filtered.dropped, ['buddy'])
  // ② 路由链 / 准入 / 降级候选里还在（同一个快照就是自动切换的依据）
  assert.deepEqual(snap.chain.map((e) => e.provider), ['buddy', 'codearts'], '路由链仍含被隐藏的渠道')
  assert.deepEqual(snap.lastAdmission.eligible, ['buddy', 'codearts'], '准入仍把它当候选')
  // ③ hidden 没有偷偷变成 disabled（配置层面）
  assert.equal(cfg.sources.disabled, undefined, 'hidden 不得写进 disabled')
  // ④ 非破坏性：过滤不改入参（链用的数组可能与 catalog 同引用）
  assert.equal(catalog.length, 2, '入参不许被就地裁剪')
  assert.deepEqual(visibleCatalog(catalog, cfg).map((s) => s.provider), ['codearts'])
})

test('hidden 写入后路由链不变（updateSettings 往返 + 快照对照）', async () => {
  const home = makeHome()
  try {
    const deps = { dshHome: home, isAdmin: () => true, now: () => 1 }
    const w = await updateSettings(deps, { scope: 'global', patch: { sources: { hidden: ['buddy'] } } })
    assert.equal(w.ok, true)
    assert.deepEqual(w.visibility.hidden, ['buddy'])
    // 生效配置里只有 hidden，没有 disabled（隐藏 ≠ 禁用）
    const eff = await effectiveConfig({ dshHome: home })
    assert.deepEqual(eff.config.sources.hidden, ['buddy'])
    assert.equal(eff.config.sources.disabled, undefined)
    // 表格：hidden=true 且 available=true
    const rows = channelStatusList(
      [{ id: 'buddy', label: 'CodeBuddy', login: 'browser-callback', loggedIn: true, loginVerified: true, implemented: true }],
      { gate: {}, blacklist: [] }, { failures: { byProvider: {} } }, eff.config,
    )
    assert.equal(rows[0].hidden, true)
    assert.equal(rows[0].available, true)
    assert.equal(visibilitySummary([{ id: 'buddy' }, { id: 'codearts' }], eff.config).rows[0].hidden, true)
  } finally { cleanup(home) }
})

// ── 非法值被拒 ─────────────────────────────────────────────────────────────
test('validateHiddenSources：非数组 / 非字符串 / 空 id / 超长 / 非法字符 一律拒，null=恢复默认', () => {
  for (const bad of ['buddy', 3, { a: 1 }, [1], [null], [''], ['   '], ['a'.repeat(80)], ['bad id!'], [true]]) {
    const r = validateHiddenSources(bad)
    assert.equal(r.ok, false, `应拒：${JSON.stringify(bad)}`)
    assert.ok(r.errors.length > 0, '必须给原因')
  }
  const tooMany = Array.from({ length: 201 }, (_, i) => 'c' + i)
  assert.equal(validateHiddenSources(tooMany).ok, false)
  assert.equal(validateHiddenSources(null).ok, true)
  assert.equal(validateHiddenSources(null).value, null)
  const ok = validateHiddenSources([' Buddy ', 'buddy', 'Kilo-Free'])
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.value, ['buddy', 'kilo'], '归一 + 去重 + 排序')
})

test('PATCH { sources: { hidden } }：非法值被拒且不落盘，合法值往返，null 恢复默认', async () => {
  const home = makeHome()
  try {
    const deps = { dshHome: home, isAdmin: () => true, now: () => 1 }
    const bad = await updateSettings(deps, { scope: 'global', patch: { sources: { hidden: 'buddy' } } })
    assert.equal(bad.ok, false)
    assert.equal(bad.field, 'sources.hidden')
    assert.match(bad.error, /sources\.hidden/)
    assert.deepEqual(await readScope(home, SCOPE.GLOBAL), {}, '被拒的值不得落盘')
    const bad2 = await updateSettings(deps, { scope: 'global', patch: { sources: { hidden: [1] } } })
    assert.equal(bad2.ok, false)
    assert.deepEqual(await readScope(home, SCOPE.GLOBAL), {})

    const ok = await updateSettings(deps, { scope: 'global', patch: { sources: { hidden: ['Buddy', 'qoder'] } } })
    assert.equal(ok.ok, true)
    assert.deepEqual((await readScope(home, SCOPE.GLOBAL)).sources.hidden, ['buddy', 'qoder'], '归一后落盘')

    const back = await updateSettings(deps, { scope: 'global', patch: { sources: { hidden: null } } })
    assert.equal(back.ok, true)
    assert.equal(back.visibility.explicit, false, 'null ⇒ 删除该键 ⇒ 恢复默认可见集合')
    const eff = await effectiveConfig({ dshHome: home })
    assert.equal(eff.config.sources, undefined)
    assert.equal(isSourceHidden('buddy', eff.config), true, '恢复默认后 buddy 仍默认隐藏')
  } finally { cleanup(home) }
})

test('渠道表格：黑名单/冷却/未登录 各状态的人话与原因（新列不改旧字段）', () => {
  const routing = {
    gate: { kilo: { coolingMs: 15000 } },
    blacklist: [{ provider: 'buddy', kind: 'AUTH', until: 1, remainMs: 3600000 }],
  }
  const rows = channelStatusList(
    [
      { id: 'kilo', label: 'Kilo', implemented: true },
      { id: 'buddy', label: 'Buddy', login: 'browser-callback', loggedIn: true, loginVerified: true, implemented: true },
      { id: 'officeace', label: 'OfficeAce', login: 'device-code', loggedIn: false, implemented: true },
    ],
    routing, { failures: { byProvider: {} } }, {},
  )
  assert.equal(rows[0].statusCode, 'cooling')
  assert.match(rows[0].status, /冷却中/)
  assert.match(rows[0].reason, /15 秒/)
  assert.equal(rows[0].available, false, '冷却中 = 此刻不可用')
  assert.equal(rows[1].statusCode, 'blacklisted')
  assert.match(rows[1].status, /已暂停：登录失效/)
  assert.equal(rows[1].available, false)
  assert.equal(rows[2].statusCode, 'not-logged-in')
  // 旧字段仍在（旧 UI 不炸）
  for (const k of ['label', 'state', 'failCount', 'coolingMs', 'blacklisted', 'blacklistKind', 'blacklistRemainMs', 'usable', 'loggedIn']) {
    assert.ok(k in rows[0], `兼容字段 ${k} 丢了`)
  }
})

test('/settings 路由层：写 hidden 生效并回 visibility（POST 前端契约）', async () => {
  const home = makeHome()
  try {
    const srv = makeServer()
    registerRoutes(srv, {
      state: makeState(), version: 'test', trustedHosts: [], dshHome: home,
      getChain: () => [], getConfig: () => ({}), isAdmin: () => true,
    })
    const p = await call(srv, '/settings', { method: 'POST', body: { scope: 'global', patch: { sources: { hidden: ['buddy', 'qoder'] } } } })
    assert.equal(p.status, 200)
    assert.equal(p.body.ok, true)
    assert.deepEqual(p.body.visibility.hidden, ['buddy', 'qoder'])
    assert.equal(p.body.visibility.explicit, true)
    // 读回来一致
    const g = await call(srv, '/settings')
    assert.equal(g.status, 200)
    assert.equal(g.body.visibility.explicit, true)
    assert.deepEqual(g.body.visibility.hidden, ['buddy', 'qoder'])
    assert.equal(g.body.channels.find((c) => c.id === 'buddy').hidden, true)
    // 非法值经路由也被拒（不落盘）
    const bad = await call(srv, '/settings', { method: 'POST', body: { scope: 'global', patch: { sources: { hidden: 'buddy' } } } })
    assert.equal(bad.body.ok, false)
    assert.equal(bad.body.field, 'sources.hidden')
    // ⚠️ PATCH：装配层已放行 body 解析（routes.js 的写类方法白名单）。
    //    这里直接断言 PATCH 往返，证明「写类方法都会读 body」没被改回只认 POST。
  } finally { cleanup(home) }
})

test('🔴 PATCH /settings 真的能写（写类方法必须解析 body，否则静默当 GET）', async () => {
  const home = makeHome()
  try {
    const srv = makeServer()
    registerRoutes(srv, {
      state: makeState(), version: 'test', trustedHosts: [], dshHome: home,
      getChain: () => [], getConfig: () => ({}), isAdmin: () => true,
    })
    const p = await call(srv, '/settings', { method: 'PATCH', body: { scope: 'global', patch: { sources: { hidden: ['qoder'] } } } })
    assert.equal(p.status, 200)
    // 🔴 证伪点：若包装器只对 POST 解析 body，PATCH 会拿到 body=undefined
    //    ⇒ 走 readSettings 分支，回的是设置对象（没有 ok/patch 语义，写盘根本没发生）。
    assert.equal(p.body.ok, true, 'PATCH 不能退化成 GET：' + JSON.stringify(p.body).slice(0, 300))
    assert.deepEqual(p.body.visibility.hidden, ['qoder'], 'PATCH 必须真的落盘')
    const g = await call(srv, '/settings')
    assert.deepEqual(g.body.visibility.hidden, ['qoder'], 'PATCH 后读回来一致')
    // POST 路径不能被 PATCH 的改动搞坏
    const post = await call(srv, '/settings', { method: 'POST', body: { scope: 'global', patch: { sources: { hidden: ['buddy'] } } } })
    assert.equal(post.body.ok, true)
    assert.deepEqual((await call(srv, '/settings')).body.visibility.hidden, ['buddy'])
  } finally { cleanup(home) }
})

test('/chain/catalog 按 sources.hidden 过滤（选择器目录），但链路与其他目录不受影响', async () => {
  const home = makeHome()
  try {
    const srv = makeServer()
    registerRoutes(srv, {
      state: makeState(), version: 'test', trustedHosts: [], dshHome: home,
      getChain: () => [], getConfig: () => ({}), isAdmin: () => true,
    })
    const before = await call(srv, '/chain/catalog')
    assert.equal(before.status, 200)
    const idsBefore = (before.body.sources || []).map((s) => s.provider)
    assert.ok(idsBefore.length > 0, '目录不该为空：' + JSON.stringify(before.body).slice(0, 200))

    await call(srv, '/settings', { method: 'POST', body: { scope: 'global', patch: { sources: { hidden: ['codearts'] } } } })
    const after = await call(srv, '/chain/catalog')
    const idsAfter = (after.body.sources || []).map((s) => s.provider)
    assert.equal(idsAfter.includes('codearts'), false, '隐藏的渠道不能出现在选择器目录：' + JSON.stringify(idsAfter))
    assert.ok(after.body.hidden.includes('codearts'), '要如实回报隐藏清单')
    // 其余渠道仍在（隐藏 ≠ 只留一个）
    for (const id of idsBefore.filter((x) => x !== 'codearts')) {
      assert.ok(idsAfter.includes(id), '非隐藏渠道不该被顺带删掉：' + id)
    }
  } finally { cleanup(home) }
})

// ══════════════════════════════════════════════════════════════════════════
// 模型去重（用户口径 2026-11-06）
//
// 「每次选择模型的时候，除了 deepseek 的付费 api 和自行添加的模型，
//   其他的模型只带出一个可用的渠道。」
//
// 背景：实测同模型跨渠道重复严重 —— deepseek-v4.1-flash 同时挂在
//       codearts / buddy / workbuddy / lobsterai / cline 五家。
// ══════════════════════════════════════════════════════════════════════════

test('🟥 渠道包同模型只留一个渠道，且优先「已验证 + 可用」的那家', () => {
  const groups = [
    { provider: 'buddy', label: 'CodeBuddy', kind: 'channel', models: [{ id: 'X', name: 'X' }] },
    { provider: 'codearts', label: 'CodeArts', kind: 'channel', models: [{ id: 'X', name: 'X' }] },
  ]
  // codearts 已验证；buddy 未验证 ⇒ 应留 codearts
  const channels = [
    { id: 'buddy', loggedIn: true, loginVerified: false, implemented: true, usable: true, hidden: false },
    { id: 'codearts', loggedIn: true, loginVerified: true, implemented: true, usable: true, hidden: false },
  ]
  const out = dedupeModelsVisible(groups, channels)
  const flat = out.flatMap((g) => g.models.map((m) => ({ p: g.provider, id: m.id })))
  assert.equal(flat.filter((x) => x.id === 'X').length, 1, '同名模型必须只剩一个：' + JSON.stringify(flat))
  assert.equal(flat.find((x) => x.id === 'X').p, 'codearts', '应留已验证的那家：' + JSON.stringify(flat))
})

test('🟥 自加 API（deepseek/ark）**不参与**去重，与渠道包里的同名模型并存', () => {
  const groups = [
    { provider: 'codearts', label: 'CodeArts', kind: 'channel', models: [{ id: 'X', name: 'X' }] },
    { provider: 'deepseek', label: 'DeepSeek 官方', kind: 'channel', models: [{ id: 'X', name: 'X' }] },
    { provider: 'ark', label: '火山方舟', kind: 'channel', models: [{ id: 'X', name: 'X' }] },
  ]
  const channels = [
    { id: 'codearts', loggedIn: true, loginVerified: true, implemented: true, usable: true, hidden: false },
    { id: 'deepseek', loggedIn: true, loginVerified: true, implemented: true, usable: true, hidden: false },
    { id: 'ark', loggedIn: true, loginVerified: false, implemented: true, usable: true, hidden: false },
  ]
  const out = dedupeModelsVisible(groups, channels)
  const providers = out.flatMap((g) => g.models.filter((m) => m.id === 'X').map(() => g.provider))
  assert.equal(providers.length, 3, '自加 API 必须各自保留一行：' + JSON.stringify(providers))
  for (const p of ['codearts', 'deepseek', 'ark']) assert.ok(providers.includes(p), '缺 ' + p)
})

test('🟥 不可用的渠道排在可用之后：有可用渠道时不会留未登录的那家', () => {
  const groups = [
    { provider: 'workbuddy', label: 'WorkBuddy', kind: 'channel', models: [{ id: 'X', name: 'X' }] },
    { provider: 'buddy', label: 'CodeBuddy', kind: 'channel', models: [{ id: 'X', name: 'X' }] },
  ]
  const channels = [
    { id: 'workbuddy', loggedIn: false, implemented: true, usable: true, hidden: false },
    { id: 'buddy', loggedIn: true, loginVerified: false, implemented: true, usable: true, hidden: false },
  ]
  const out = dedupeModelsVisible(groups, channels)
  const kept = out.flatMap((g) => g.models.filter((m) => m.id === 'X').map(() => g.provider))
  assert.equal(kept[0], 'buddy', '已登录的优先于未登录的：' + JSON.stringify(kept))
})

test('去重不误伤：不同模型各自保留', () => {
  const groups = [
    { provider: 'codearts', label: 'C', kind: 'channel', models: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }] },
  ]
  const channels = [{ id: 'codearts', loggedIn: true, loginVerified: true, implemented: true, usable: true, hidden: false }]
  const out = dedupeModelsVisible(groups, channels)
  const ids = out.flatMap((g) => g.models.map((m) => m.id)).sort()
  assert.deepEqual(ids, ['A', 'B'])
})

test('空输入不抛（选择器永不因目录为空而崩）', () => {
  assert.deepEqual(dedupeModelsVisible([], []), [])
  assert.deepEqual(dedupeModelsVisible(null, null), [])
})
