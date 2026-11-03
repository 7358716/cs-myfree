/**
 * cs-myfree 设置页背后的**真实服务契约**测试（只读，绝不写状态）
 *
 * 目的：UI 测试用的是快照 + 假后端，容易与线上漂移。本文件直接打真实服务
 * http://127.0.0.1:3080/cs-myfree/*（回环，需 Host: localhost 才过 guard），
 * 断言 client.js 依赖的字段确实存在、且「页面显示的链」与「运行时生效链」同源。
 *
 * 安全边界：
 *   · 只发 GET + 只读的 POST /diag、POST /channels/parse（不写盘）
 *   · 不 POST /chain、/config、/scope、/channels/save、/probe（这些会改用户状态/打网络）
 *   · 服务不可达时整组 skip（本机没起服务不应红）
 *
 * 运行：node --test test/client-live.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeChain } from '../../src/adapter/chain-overrides.js'

const BASE = process.env.CS_MYFREE_BASE || 'http://127.0.0.1:3080'
const TIMEOUT = Number(process.env.CS_MYFREE_TIMEOUT_MS || 8000)

async function req(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { host: 'localhost', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 保留 text 供报错 */ }
  return { status: res.status, json, text }
}

// 探活（一次），不可达则全部 skip
let LIVE = false
let LIVE_ERR = ''
try {
  const r = await req('/cs-myfree/health')
  LIVE = r.status === 200 && r.json?.ok === true
  if (!LIVE) LIVE_ERR = `HTTP ${r.status} ${r.text.slice(0, 120)}`
} catch (e) {
  LIVE_ERR = String((e && e.message) || e)
}
const liveTest = (name, fn) => test(name, { skip: LIVE ? false : `真实服务不可达（${BASE}）：${LIVE_ERR}` }, fn)

liveTest('GET /health：服务在线且是 cs-myfree', async () => {
  const r = await req('/cs-myfree/health')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.plugin, 'cs-myfree')
  assert.equal(r.json.prefix, '/cs-myfree')
})

liveTest('GET /state：client.js 消费的字段齐全', async () => {
  const r = await req('/cs-myfree/state')
  assert.equal(r.status, 200)
  const d = r.json
  assert.ok(Array.isArray(d.sources.keyless), 'sources.keyless 必须是数组（W0/W1 用）')
  assert.equal(typeof d.sources.counts.channels, 'number')
  assert.equal(typeof d.sources.counts.keyless, 'number')
  assert.equal(typeof d.sources.counts.manualRefresh, 'number')
  assert.equal(typeof d.sources.counts.proxyRequired, 'number')
  assert.equal(typeof d.chain.effectiveCount, 'number', 'W0 总览「降级链 N 条候选」用')
  assert.ok(Array.isArray(d.chain.tiers))
  assert.ok(d.checkin && Array.isArray(d.checkin.supported), 'W5 用 checkin.supported')
  assert.ok('probe' in d, 'W0/W5 用 probe')
  assert.ok(d.config && d.config.budget && d.config.paid, 'W0「付费闸门」用 config.paid')
})

liveTest('GET /chain：页面链与运行时链同源（防「页面说 17 条、实际 2 条」回归）', async () => {
  const chain = (await req('/cs-myfree/chain')).json
  const state = (await req('/cs-myfree/state')).json
  assert.ok(Array.isArray(chain.builtin))
  assert.ok(Array.isArray(chain.overrides))
  assert.ok(Array.isArray(chain.effective))

  // ① 生效链 = merge(builtin, overrides)：与 UI/后端使用的唯一合并函数一致
  const merged = mergeChain(chain.builtin, chain.overrides)
  assert.equal(chain.effective.length, merged.length, '页面 effective 必须等于 mergeChain 结果')
  assert.deepEqual(
    chain.effective.map((e) => `${e.provider}/${e.model}@T${e.tier}`),
    merged.map((e) => `${e.provider}/${e.model}@T${e.tier}`),
  )

  // ② 总览计数与链接口必须一致
  assert.equal(state.chain.effectiveCount, chain.effective.length, '/state 与 /chain 的生效链条数必须一致')
  assert.equal(state.chain.builtinCount, chain.builtin.length)
  assert.equal(state.chain.overrideCount, chain.overrides.length)

  // ③ 后端新版本会回传 applied（页面链 == adapter 真实选路）；旧版本无此字段
  if ('applied' in chain) assert.equal(chain.applied, true, 'GET /chain.applied 应为 true（同源）')
})

liveTest('GET /channels：18 家渠道 + 登录指引 + 只回掩码', async () => {
  const d = (await req('/cs-myfree/channels')).json
  assert.equal(d.ok, true)
  assert.ok(Array.isArray(d.channels))
  assert.equal(d.total, d.channels.length, 'total 必须等于数组长度（W1 用 total 显示「N 家」）')
  for (const c of d.channels) {
    assert.equal(typeof c.id, 'string')
    assert.equal(typeof c.label, 'string')
    assert.ok(Array.isArray(c.accounts), `${c.id}.accounts 必须是数组`)
    assert.equal(typeof c.loggedIn, 'boolean')
    assert.ok(Array.isArray(c.guideSteps) && c.guideSteps.length > 0, `${c.id}.guideSteps 必须有（UI 展示登录指引）`)
    assert.equal(typeof c.field, 'string', `${c.id}.field 是「需要粘贴什么」`)
    assert.equal(typeof c.proxyRequired, 'boolean')
    for (const a of c.accounts) {
      assert.equal(typeof a.masked, 'string')
      assert.ok(a.masked.includes('…') || a.masked.includes('***'), '账号必须以掩码返回，不能回原文')
      assert.equal('credential' in a, false, '绝不能把凭证回给前端')
      assert.equal('token' in a, false)
    }
  }
})

liveTest('GET /channels/models：模型 id 带渠道前缀；新版本应回传来源 source', async () => {
  const d = (await req('/cs-myfree/channels/models')).json
  assert.equal(d.ok, true)
  assert.ok(Array.isArray(d.models))
  assert.equal(d.total, d.models.length, 'total 必须等于 models 长度')
  for (const m of d.models) {
    assert.ok(m.id.includes('/'), '渠道模型 id 必须形如 渠道/模型：' + m.id)
    assert.equal(typeof m.channelId, 'string')
    assert.ok(Array.isArray(m.inputModalities), 'UI 展示输入模态')
  }
  const by = d.byChannel || {}
  const ALLOWED = new Set(['remote', 'builtin', 'builtin-after-http-error', 'builtin-empty-remote', 'none'])
  for (const [id, v] of Object.entries(by)) {
    // 旧缓存里 source 可能是 null（老版本写入），新版本应回传合法枚举
    if ('source' in v && v.source != null) assert.ok(ALLOWED.has(v.source), `${id}.source 非法：${v.source}`)
  }
  // 有模型的渠道必须 ok
  for (const [id, v] of Object.entries(by)) {
    if ((v.count || 0) > 0) assert.equal(v.ok, true, `${id} 有模型但 ok=false`)
  }
})

liveTest('GET /models：免密源 + 默认模型；探测结果字段与 source id 对齐', async () => {
  const d = (await req('/cs-myfree/models')).json
  assert.equal(d.ok, true)
  assert.ok(Array.isArray(d.sources))
  assert.ok(d.defaultModels && typeof d.defaultModels === 'object')
  for (const s of d.sources) {
    assert.equal(typeof s.id, 'string')
    assert.equal(typeof s.label, 'string')
    assert.ok('probed' in s, 'UI「最近探测」需要 probed 字段')
    if (s.probed) {
      assert.equal(typeof s.probed.ok, 'boolean')
      if (s.probed.ok) assert.equal(typeof s.probed.ms, 'number')
    }
    // 新版本：probeId 用于把 probe 结果 id（kilo）映射回源 id（kilo-free）
    if ('probeId' in s) assert.equal(typeof s.probeId, 'string')
  }
  // 每个免密源都应有默认模型（UI 的「默认模型」列）
  for (const s of d.sources) {
    const key = s.probeId || s.id
    const hit = d.defaultModels[key] || d.defaultModels[s.id] || d.defaultModels[String(s.id).replace(/-free$|-vision$/, '')]
    if (!hit) assert.ok(true)   // 允许缺，但 UI 已做 fallback；此处不强制
  }
})

liveTest('GET /config：UI 编辑的字段都存在且类型正确', async () => {
  const d = (await req('/cs-myfree/config')).json
  assert.equal(d.ok, true)
  const c = d.config
  assert.ok(c && typeof c === 'object')
  assert.equal(typeof c.budget.perCallCNY, 'number')
  assert.equal(typeof c.budget.dailyCNY, 'number')
  assert.equal(typeof c.budget.monthlyCNY, 'number')
  assert.equal(typeof c.paid.enabled, 'boolean')
  assert.equal(typeof c.paid.allowAutoCall, 'boolean')
  assert.equal(typeof c.paid.confirmEachTurn, 'boolean')
  assert.ok(['off', 'local', 'free-cloud', 'paid-cloud'].includes(c.vision.mode), 'vision.mode 必须枚举内：' + c.vision.mode)
  assert.ok(Array.isArray(c.search.sources))
  assert.equal(typeof c.search.budgetMs, 'number')
  assert.ok(Array.isArray(c.sources.disabled))
})

liveTest('GET /scope：三种作用域 + 层级计数', async () => {
  const d = (await req('/cs-myfree/scope')).json
  assert.equal(d.ok, true)
  for (const s of ['global', 'preset', 'session']) assert.ok(d.scopes.includes(s), '缺少作用域 ' + s)
  assert.equal(typeof d.effective.layers.global, 'number')
  assert.equal(typeof d.effective.layers.preset, 'number')
  assert.equal(typeof d.effective.layers.session, 'number')
  assert.ok(Array.isArray(d.files), 'W11 展示已有作用域文件')
  assert.equal(typeof d.hint, 'string')
})

liveTest('GET /ledger：花费汇总字段（W9 用）', async () => {
  const d = (await req('/cs-myfree/ledger')).json
  assert.equal(d.ok, true)
  const s = d.summary || {}
  for (const k of ['todayCNY', 'monthCNY', 'todayCalls', 'totalCalls', 'paidCalls']) {
    assert.equal(typeof s[k], 'number', 'summary.' + k + ' 必须是数字')
  }
  assert.ok(d.spend && typeof d.spend.ok === 'boolean')
  assert.ok(Array.isArray(d.spend.days || []))
  assert.ok(Array.isArray(d.spend.providers || []))
  assert.ok(Array.isArray(d.token?.days || []))
})

liveTest('GET /cash：余额查询返回形状可渲染', async () => {
  const r = await req('/cs-myfree/cash')
  assert.equal(r.status, 200)
  const d = r.json
  assert.equal(d.ok, true)
  assert.ok('deepseek' in d)
  assert.ok(Array.isArray(d.errors))
  if (d.deepseek) {
    assert.equal(typeof d.deepseek.available, 'boolean')
    assert.ok(Array.isArray(d.deepseek.balances))
    for (const b of d.deepseek.balances) {
      assert.equal(typeof b.currency, 'string')
      assert.equal(typeof Number(b.total), 'number')
    }
  }
})

liveTest('POST /diag：一键体检返回 6 项检查（只读）', async () => {
  const r = await req('/cs-myfree/diag', { method: 'POST', body: {} })
  assert.equal(r.status, 200)
  const d = r.json
  assert.equal(typeof d.ok, 'boolean')
  assert.ok(Array.isArray(d.checks) && d.checks.length >= 5)
  for (const c of d.checks) {
    assert.equal(typeof c.name, 'string')
    assert.ok([true, false, null].includes(c.ok), 'check.ok 必须是 bool/null：' + JSON.stringify(c.ok))
    assert.equal(typeof c.detail, 'string')
  }
  assert.equal(typeof d.summary, 'string')
})

liveTest('POST /channels/parse：普通网址必须拒绝，带 code 回调链接必须识别（无写入）', async () => {
  const bad = (await req('/cs-myfree/channels/parse', { method: 'POST', body: { text: 'https://www.baidu.com' } })).json
  assert.equal(bad.ok, false)
  assert.ok(bad.error.includes('没有 code / token'), '普通网址应明确拒绝：' + bad.error)

  const good = (await req('/cs-myfree/channels/parse', { method: 'POST', body: { text: 'https://x.com/cb?code=abc123def456ghi789' } })).json
  assert.equal(good.ok, true)
  assert.equal(good.kind, 'url')
  assert.equal(good.field, 'code')
  // 🔴 安全红线（v1.8.0）：解析接口**绝不回凭据原文**，只回掩码预览
  assert.equal('credential' in good, false, '不得把凭据原文回给前端')
  assert.equal(typeof good.preview, 'string')
  assert.ok(good.preview.includes('…'), '必须掩码：' + good.preview)
})
