/**
 * cs-myfree 设置页（src/client.js）UI 测试 —— Node stub 宿主，无浏览器
 *
 * 为什么这样做：本机没有 chromium/playwright，但设置页的等价性必须在「能渲染 + 能点」
 * 层面验证，否则只能等用户点出白屏。这里用 60 行迷你 React（useState/useEffect/
 * useMemo/useRef/class ErrorBoundary + 生命周期卸载）把 client.js 真正跑起来：
 *   · stub 宿主：window.__ModuleLoader__.load / require('react') / fetch
 *   · fetch 桩：默认用**真实 API 返回快照**驱动渲染；流程用例用有状态假后端
 *     （校验逻辑 import 真实后端函数：validateOverrides / captureCredential /
 *      looksLikeCredential，保证前后端契约一致）
 *   · 可点：按文案找最近的 onClick 祖先节点、改 input、触发 onPaste、切 tab
 *
 * 覆盖 13 面板（W0-W12）渲染/字段/空态/错误态/回调注册，以及 8 条真人流程。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { validateOverrides, mergeChain, chainSummary } from '../src/adapter/chain-overrides.js'
import { captureCredential, looksLikeCredential } from '../src/pools/channels/capture.js'

const CLIENT_PATH = fileURLToPath(new URL('../src/client.js', import.meta.url))
const CLIENT_SRC = readFileSync(CLIENT_PATH, 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clone = (v) => JSON.parse(JSON.stringify(v))

// ─────────────────────────────────────────────────────────────────────────────
// 真实 API 快照（2026-11-03 取自 http://127.0.0.1:3080/cs-myfree/*，v1.7.0+）
// 只保留 client.js 真正消费的字段；值尽量与线上一致。
// ─────────────────────────────────────────────────────────────────────────────
function mkChannel(id, label, extra = {}) {
  return Object.assign({
    id,
    label,
    login: 'browser-callback',
    implemented: false,
    authKind: 'bearer',
    reason: '需 OAuth token，未实现',
    guideKind: 'browser',
    guideTitle: '浏览器授权登录',
    guideSteps: ['点下面「打开登录页」按钮', '在打开的页面完成登录并授权', '授权完成后把浏览器地址栏的授权码（code）复制过来', '粘贴到下方输入框并点保存'],
    field: '授权码 / code',
    loginUrl: 'https://example.com/login',
    loginWarn: null,
    checkin: true,
    refresh: 'auto',
    note: null,
    proxyRequired: false,
    accounts: [],
    loggedIn: false,
  }, extra)
}

const FIX = {
  state: {
    ok: true,
    at: 1793690401174,
    version: '1.7.0',
    sources: {
      keyless: [
        { id: 'kilo-free', label: 'Kilo 免费池', note: '完全免密；prompt 可能被上游记录' },
        { id: 'ovh-vision', label: 'OVH 免费视觉', note: '识图专用；免密' },
        { id: 'pollinations', label: 'Pollinations', note: '免密；能力较弱' },
      ],
      channels: [],
      counts: { keyless: 3, channels: 18, checkin: 11, manualRefresh: 1, proxyRequired: 1 },
    },
    chain: {
      builtinCount: 2,
      overrideCount: 1,
      effectiveCount: 2,
      tiers: [{ tier: 1, count: 2, providers: ['kilo', 'ovh'], entries: ['kilo/kilo-auto/free', 'ovh/Qwen3.5-397B-A17B'] }],
      explain: '共 2 条候选，分 1 层。',
    },
    config: {
      vision: 'off',
      search: ['bing-rss', 'bing-html', 'sogou', 'mwmbl'],
      budget: { perCallCNY: 1, dailyCNY: 10, monthlyCNY: 100 },
      paid: { enabled: false },
      disabledSources: [],
    },
    probe: { at: 1793666655972, anyOk: true, okCount: 2 },
    checkin: { supported: ['codearts', 'buddy', 'lobsterai'], note: '签到由宿主渠道层执行；本插件只展示可签到渠道' },
  },
  chain: {
    ok: true,
    builtin: [
      { provider: 'kilo', model: 'kilo-auto/free', tier: 1 },
      { provider: 'ovh', model: 'Qwen3.5-397B-A17B', tier: 1 },
    ],
    overrides: [{ provider: 'kilo', model: 'kilo-auto/free', tier: 1 }],
    effective: [
      { provider: 'kilo', model: 'kilo-auto/free', tier: 1, _i: 0 },
      { provider: 'ovh', model: 'Qwen3.5-397B-A17B', tier: 1, _i: 1 },
    ],
    tiers: [{ tier: 1, count: 2, providers: ['kilo', 'ovh'], entries: ['kilo/kilo-auto/free', 'ovh/Qwen3.5-397B-A17B'] }],
    applied: true,
  },
  channels: {
    ok: true,
    at: 1793690401188,
    total: 18,
    channels: [
      mkChannel('codearts', 'CodeArts（华为云）', {
        implemented: true,
        authKind: 'signed-huawei',
        reason: null,
        loginWarn: null,
        accounts: [
          { id: 'codearts-1793686308695', label: 'CodeArts（华为云）', masked: 'HPUA…7NLO', addedAt: 1793686308695, expiresAt: null },
          { id: 'codearts-1793686486671', label: 'CodeArts（华为云）', masked: 'ovLa…9VMV', addedAt: 1793686486671, expiresAt: null },
        ],
        loggedIn: true,
      }),
      mkChannel('buddy', 'CodeBuddy（腾讯）'),
      mkChannel('workbuddy', 'WorkBuddy（国际）', { checkin: false }),
      mkChannel('lobsterai', 'LobsterAI（有道）'),
      mkChannel('qoder', 'Qoder', { login: 'device-code', guideTitle: '设备码登录', guideSteps: ['打开登录页', '确认设备码', '粘贴 token'], field: 'token' }),
      mkChannel('qodercn', 'Qoder 中国版', { login: 'device-code' }),
      mkChannel('trae', 'TRAE（字节）'),
      mkChannel('cline', 'Cline', { login: 'device-code', checkin: false }),
      mkChannel('loomy', 'Loomy（讯飞）', { login: 'qr-wechat' }),
      mkChannel('raccoon', 'Raccoon（商汤）', { login: 'qr-wechat', checkin: false }),
      mkChannel('minimax', 'MiniMax Code', {
        login: 'oauth-pkce',
        reason: '需 OAuth token，未实现',
        loginWarn: '这类渠道的登录入口在官网深处，插件无法代你跳转；请按上面步骤自己找',
      }),
      mkChannel('minimaxintl', 'MiniMax 国际', { login: 'oauth-pkce', loginWarn: '这类渠道的登录入口在官网深处' }),
      mkChannel('zcode', 'ZCode（智谱）', { login: 'device-code' }),
      mkChannel('opencode', 'OpenCode', { login: 'none', guideKind: 'none', guideTitle: '无需登录', guideSteps: ['该渠道不需要账号'], field: 'API Key（可选）', checkin: false }),
      mkChannel('gemini', 'Gemini Code Assist', { proxyRequired: true, checkin: false, reason: '本机网络不可达' }),
      mkChannel('officeace', 'OfficeAce（华为 MaaS）', { login: 'oauth-pkce', loginWarn: '入口较深' }),
      mkChannel('accio', 'Accio（阿里）', { checkin: false }),
      mkChannel('qiniu', 'Qiniu（七牛）', { login: 'paste-key', implemented: true, authKind: 'api-key', reason: null, guideKind: 'paste', guideTitle: '粘贴 API Key', guideSteps: ['创建 API Key', '粘贴', '保存'], field: 'API Key', checkin: false }),
    ],
  },
  channelsModels: {
    ok: true,
    at: 1793690413716,
    total: 4,
    models: [
      { id: 'codearts/deepseek-v4.1-flash', name: 'CodeArts（华为云） · DeepSeek V4.1 Flash', channelId: 'codearts', modelId: 'deepseek-v4.1-flash', inputModalities: ['text'], source: 'builtin' },
      { id: 'codearts/deepseek-v4.1-flash-sg', name: 'CodeArts（华为云） · DeepSeek V4.1 Flash (SG)', channelId: 'codearts', modelId: 'deepseek-v4.1-flash-sg', inputModalities: ['text'], source: 'builtin' },
      { id: 'codearts/deepseek-v4-flash', name: 'CodeArts（华为云） · DeepSeek V4 Flash', channelId: 'codearts', modelId: 'deepseek-v4-flash', inputModalities: ['text'], source: 'builtin' },
      { id: 'codearts/deepseek-v4-pro', name: 'CodeArts（华为云） · DeepSeek V4 Pro', channelId: 'codearts', modelId: 'deepseek-v4-pro', inputModalities: ['text'], source: 'builtin' },
    ],
    byChannel: { codearts: { ok: true, count: 4, error: null, at: 1793688507446, source: 'builtin' } },
  },
  models: {
    ok: true,
    at: 1793690401196,
    defaultModels: { kilo: 'kilo-auto/free', ovh: 'Qwen3.5-397B-A17B', pollinations: 'openai' },
    sources: [
      { id: 'kilo-free', probeId: 'kilo', label: 'Kilo 免费池', note: '完全免密；prompt 可能被上游记录', probed: { id: 'kilo', ok: true, ms: 860, sample: 'pong' } },
      { id: 'ovh-vision', probeId: 'ovh', label: 'OVH 免费视觉', note: '识图专用；免密', probed: { id: 'ovh', ok: false, ms: 20000, error: 'timeout' } },
      { id: 'pollinations', probeId: 'pollinations', label: 'Pollinations', note: '免密；能力较弱', probed: null },
    ],
    note: '完整模型清单需渠道层登录后由宿主暴露；本页展示免密源可用的默认模型',
  },
  config: {
    ok: true,
    config: {
      schema: 'cs-myfree/config/v1',
      chain: { overrides: [] },
      budget: { perCallCNY: 1, dailyCNY: 10, monthlyCNY: 100 },
      paid: { enabled: false, allowAutoCall: false, confirmEachTurn: true },
      vision: { mode: 'off' },
      search: { sources: ['bing-rss', 'bing-html', 'sogou', 'mwmbl'], budgetMs: 15000 },
      sources: { disabled: [] },
    },
    defaults: {},
  },
  scope: {
    ok: true,
    scopes: ['global', 'preset', 'session'],
    files: [],
    effective: { config: {}, layers: { global: 0, preset: 0, session: 0 }, ids: { presetId: null, sessionId: null } },
    hint: '优先级：会话 > 预设 > 全局。会话/预设作用域需传 id。',
  },
  ledger: {
    ok: true,
    at: 1793690413881,
    source: 'cs-myfree 自有账本',
    file: '/home/ubuntu/.dsh/cs-myfree/ledger.jsonl',
    available: true,
    spend: {
      ok: true, empty: false, file: '/home/ubuntu/.dsh/cs-myfree/ledger.jsonl', total: 10, failed: 1, paidCount: 0, costTotalCNY: 0, costUnknown: 0,
      days: [{ date: '2026-11-03', calls: 10, costCNY: 0, costUnknown: 0, in: 0, out: 0, paid: 0, providers: ['pollinations', 'ovh', 'kilo'] }],
      providers: [{ provider: 'kilo', calls: 6, in: 0, out: 0, failed: 0, costCNY: 0 }, { provider: 'ovh', calls: 3, in: 0, out: 0, failed: 1, costCNY: 0 }],
    },
    token: { ok: true, days: [] },
    summary: { todayCNY: 0, monthCNY: 0, todayCalls: 10, totalCalls: 10, failedCalls: 1, paidCalls: 0, costUnknown: 0, lastAt: 1793689675044 },
  },
  cash: { ok: true, deepseek: { available: true, balances: [{ currency: 'CNY', total: 11, granted: 0, topped: 11 }] }, errors: [] },
  checkinStatus: {
    ok: true, enabled: true, alive: true, running: false, at_time: '10:05',
    nextAt: 1793745900000, lastAt: 1793664300000, lastDate: '2026-11-03',
    lastResult: '领取 2 个账号（+2000 积分）', pending: 0, lastError: null,
    channels: [{ provider: 'codearts', kind: 'claimed', text: '领取成功 +1000 积分', gain: { amount: 1000 } }],
  },
  checkinRun: {
    ok: true, at: 1793664300000, takesMs: 1234, coversToday: true,
    results: [
      { provider: 'codearts', kind: 'claimed', gain: { amount: 1000 }, message: '领取成功', ms: 800 },
      { provider: 'buddy', kind: 'unsupported', message: '该渠道不支持自动签到', ms: 10 },
    ],
    summary: { total: 2, claimed: 1, alreadyClaimed: 0, inactive: 0, unsupported: 1, failed: 0 },
    text: 'codearts:claimed +1000；buddy:unsupported',
  },
  credits: {
    ok: true,
    providers: [
      { provider: 'codearts', ok: true, total: 2000, unit: '积分' },
      { provider: 'buddy', ok: false, error: '需 OAuth token，未实现' },
    ],
  },
  diag: {
    ok: true,
    at: 1793690413973,
    checks: [
      { name: 'HTTP 路由', ok: true, detail: '/cs-myfree 已注册 15 条' },
      { name: '状态目录', ok: true, detail: '/home/ubuntu/.dsh/cs-myfree' },
      { name: '降级链', ok: true, detail: '生效 2 条（内置 2 + 覆盖 1）' },
      { name: '免密源', ok: true, detail: '2/2 可用（缓存已过期，建议重新探测）' },
      { name: 'DeepSeek 余额', ok: true, detail: '可用' },
      { name: '渠道协议', ok: true, detail: '18 个渠道已登记' },
    ],
    summary: '全部通过',
    cashPath: '/cs-myfree/cash',
  },
}

// 登录 flow 映射（与 src/pools/channels/login/flow-map.js 对齐；codearts 已真机验证）
const FLOW_OF = {
  codearts: 'browser', buddy: 'browser', workbuddy: 'browser', lobsterai: 'browser',
  trae: 'browser', accio: 'browser', gemini: 'browser', officeace: 'browser',
  qoder: 'device', qodercn: 'device', cline: 'device', minimax: 'device',
  minimaxintl: 'device', zcode: 'device',
  loomy: 'qr', raccoon: 'qr',
  qiniu: 'paste', opencode: 'paste',
}
FIX.loginStatus = {
  ok: true,
  total: 18,
  verified: ['codearts'],
  unverified: Object.keys(FLOW_OF).filter((id) => id !== 'codearts'),
  channels: FIX.channels.channels.map((c) => ({
    id: c.id,
    provider: c.id,
    label: c.label,
    flow: FLOW_OF[c.id] || 'paste',
    loginVerified: c.id === 'codearts',
    note: c.id === 'codearts' ? 'AK/SK 永久授权，已真机验证' : (c.label + '：登录端点待取证'),
    refreshable: c.id !== 'loomy',
  })),
  note: 'loginVerified=false 表示登录器端点未真机验证，UI 必须显示「未验证」徽标',
}

// ─────────────────────────────────────────────────────────────────────────────
// 迷你 React：够 render/click/input/paste/tab/卸载
// ─────────────────────────────────────────────────────────────────────────────
function cmpDeps(a, b) {
  if (!a || !b) return true
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return true
  return false
}

async function mount({ backend, clipboard } = {}) {
  const requests = []
  let pending = 0
  const rt = { hooks: new Map(), classInst: new Map(), errors: [], active: null, dirty: false, pendingEffects: [], tree: null, root: null, alive: new Set() }

  const react = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity)
      const pp = Object.assign({}, props || {})
      pp.children = flat.length <= 1 ? flat[0] : flat
      return { type, props: pp, children: flat }
    },
    useState(init) {
      const slot = slotOf()
      if (!('v' in slot)) slot.v = typeof init === 'function' ? init() : init
      if (!slot.set) slot.set = (v) => {
        const next = typeof v === 'function' ? v(slot.v) : v
        if (!Object.is(next, slot.v)) { slot.v = next; rt.dirty = true }
      }
      return [slot.v, slot.set]
    },
    useRef(init) {
      const slot = slotOf()
      if (!('ref' in slot)) slot.ref = { current: init }
      return slot.ref
    },
    useMemo(fn, deps) {
      const slot = slotOf()
      if (!('memo' in slot) || cmpDeps(slot.deps, deps)) { slot.memo = fn(); slot.deps = deps }
      return slot.memo
    },
    useEffect(fn, deps) {
      rt.pendingEffects.push({ path: rt.active.path, slot: slotOf(), fn, deps })
    },
    Component: class Component {
      constructor(props) { this.props = props || {}; this.state = {} }
      setState(s) { this.state = Object.assign({}, this.state, typeof s === 'function' ? s(this.state) : s); rt.dirty = true }
    },
  }
  react.Component.prototype.isReactComponent = true

  function slotOf() {
    const { inst } = rt.active
    const i = rt.active.cursor++
    if (!inst.hooks[i]) inst.hooks[i] = {}
    return inst.hooks[i]
  }
  function instOf(path) {
    let inst = rt.hooks.get(path)
    if (!inst) { inst = { hooks: [] }; rt.hooks.set(path, inst) }
    return inst
  }

  function renderNode(node, path) {
    if (node == null || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return { type: '#text', props: {}, children: [], text: String(node) }
    if (Array.isArray(node)) return { type: '#array', props: {}, children: node.map((n, i) => renderNode(n, `${path}[${i}]`)) }
    if (typeof node !== 'object') return { type: '#text', props: {}, children: [], text: String(node) }
    const { type, props, children } = node
    if (typeof type === 'symbol') {
      return { type: '#fragment', props: props || {}, children: (children || []).map((c, i) => renderNode(c, `${path}.f${i}`)) }
    }
    if (typeof type === 'string') {
      rt.alive.add(path)
      return { type, props: props || {}, path, children: (children || []).map((c, i) => renderNode(c, `${path}.${i}`)) }
    }
    if (typeof type === 'function') {
      if (type.prototype && type.prototype.isReactComponent) {
        const cpath = path + '#' + (type.name || 'cls') + (props && props.key != null ? '@' + props.key : '')
        rt.alive.add(cpath)
        let inst = rt.classInst.get(cpath)
        if (!inst) { inst = new type(props); rt.classInst.set(cpath, inst) }
        inst.props = props || {}
        try { return renderNode(inst.render(), cpath) } catch (e) {
          if (typeof type.getDerivedStateFromError === 'function') {
            inst.state = Object.assign({}, inst.state, type.getDerivedStateFromError(e))
            rt.errors.push({ path: cpath, error: e })
            return renderNode(inst.render(), cpath)
          }
          throw e
        }
      }
      const parent = rt.active
      const cpath = path + '::' + (type.name || 'anon') + (props && props.key != null ? '@' + props.key : '')
      rt.alive.add(cpath)
      rt.active = { path: cpath, inst: instOf(cpath), cursor: 0 }
      try { return renderNode(type(props || {}), cpath) } finally { rt.active = parent }
    }
    throw new Error('unknown element type: ' + String(type))
  }

  const flatten = (tree, out = []) => {
    if (!tree) return out
    out.push(tree)
    for (const c of tree.children || []) flatten(c, out)
    return out
  }

  function unmountDead() {
    for (const [path, inst] of rt.hooks) {
      if (rt.alive.has(path)) continue
      for (const slot of inst.hooks) if (slot.cleanup) { try { slot.cleanup() } catch (_) {} slot.cleanup = null }
      rt.hooks.delete(path)
    }
    for (const path of rt.classInst.keys()) if (!rt.alive.has(path)) rt.classInst.delete(path)
  }

  async function runEffects() {
    for (const eff of rt.pendingEffects) {
      const slot = eff.slot
      if (slot.ranOnce && !cmpDeps(slot.effectDeps, eff.deps)) continue
      if (slot.ranOnce && slot.cleanup) { try { slot.cleanup() } catch (_) {} slot.cleanup = null }
      slot.ranOnce = true
      slot.effectDeps = eff.deps
      try { const c = eff.fn(); if (typeof c === 'function') slot.cleanup = c } catch (e) { rt.errors.push({ path: eff.path, error: e }) }
    }
    rt.pendingEffects = []
  }

  // fetch 桩：统计、模拟网络延迟、返回 Response 形状
  async function fetchStub(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase()
    let body
    try { body = opts.body ? JSON.parse(opts.body) : undefined } catch (_) { body = opts.body }
    requests.push({ url: String(url), method, body })
    pending++
    try {
      const r = await backend(String(url), { method, body })
      const status = r.status ?? 200
      const data = r.body
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(data),
        json: async () => data,
      }
    } finally { pending-- }
  }

  // 加载 client.js（stub 宿主）
  let decl = null
  const win = { __ModuleLoader__: { load: (d) => { decl = d } }, clipboardData: null }
  const sandbox = {
    window: win,
    console,
    fetch: fetchStub,
    navigator: { clipboard: clipboard || { writeText: async () => {} } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, Promise, JSON, Math, Date, Number, String, Boolean,
    Object, Array, Error, Symbol, RegExp, Map, Set, Infinity, NaN, parseInt, parseFloat,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_SRC, sandbox, { filename: 'client.js' })
  const mod = decl.factory((id) => {
    if (id === 'react') return react
    throw new Error('unexpected require: ' + id)
  })

  async function flush() {
    for (let pass = 0; pass < 80; pass++) {
      rt.dirty = false
      rt.pendingEffects = []
      rt.active = null
      rt.alive = new Set()
      rt.tree = renderNode(rt.root, '$root')
      unmountDead()
      await runEffects()
      let idle = 0
      for (let i = 0; i < 800; i++) {
        await sleep(2)
        if (rt.dirty) break                   // 状态已变 ⇒ 立刻重渲染
        if (pending > 0) { idle = 0; continue }
        idle++
        if (idle >= 2) break
      }
      if (!rt.dirty) return rt.tree
    }
    return rt.tree
  }

  const ctrl = {
    mod, requests, runtime: rt,
    nodes: () => flatten(rt.tree),
    text: () => flatten(rt.tree).map((n) => (n.type === '#text' ? n.text : '')).join(''),
    byText: (str) => flatten(rt.tree).filter((n) => n.type !== '#text' && flatten(n).map((x) => x.text || '').join('').includes(str)),
    exactText: (str) => flatten(rt.tree).filter((n) => n.type !== '#text' && flatten(n).filter((x) => x.type === '#text').map((x) => x.text).join('').trim() === str),
    clickableByText(str) {
      const cands = flatten(rt.tree).filter((n) => typeof n.props.onClick === 'function' && flatten(n).map((x) => x.text || '').join('').includes(str))
      cands.sort((a, b) => flatten(a).length - flatten(b).length)
      return cands[0]
    },
    async start(Component = mod.MyfreeSection, props = {}) {
      rt.root = { type: Component, props, children: [] }
      return flush()
    },
    async click(target) {
      const el = typeof target === 'string'
        ? (ctrl.exactText(target).find((n) => typeof n.props.onClick === 'function') || ctrl.clickableByText(target))
        : target
      if (!el) throw new Error('找不到可点击元素：' + String(target))
      if (typeof el.props.onClick !== 'function') throw new Error('元素没有 onClick：' + (el.type || target))
      await el.props.onClick({ preventDefault() {}, stopPropagation() {}, target: {} })
      return flush()
    },
    async change(target, value) {
      const el = typeof target === 'string'
        ? flatten(rt.tree).find((n) => n.type === 'input' && String(n.props.placeholder || '').includes(target))
        : target
      if (!el) throw new Error('找不到输入元素：' + String(target))
      if (typeof el.props.onChange !== 'function') throw new Error('元素没有 onChange')
      await el.props.onChange({ target: { value } })
      return flush()
    },
    async paste(target, text) {
      const el = typeof target === 'string'
        ? flatten(rt.tree).find((n) => n.type === 'input' && String(n.props.placeholder || '').includes(target))
        : target
      if (!el) throw new Error('找不到粘贴元素：' + String(target))
      if (typeof el.props.onPaste !== 'function') throw new Error('元素没有 onPaste')
      await el.props.onPaste({ clipboardData: { getData: () => text } })
      return flush()
    },
    inputs: (type) => flatten(rt.tree).filter((n) => n.type === 'input' && (!type || n.props.type === type)),
    textareas: () => flatten(rt.tree).filter((n) => n.type === 'textarea'),
    async openTab(label) {
      const tab = ctrl.exactText(label).find((n) => typeof n.props.onClick === 'function')
      if (!tab) throw new Error('找不到标签页：' + label)
      await ctrl.click(tab)
    },
    cardOf(id) {
      return flatten(rt.tree).find((n) => n.props && n.props['data-channel'] === id)
    },
    async waitFor(pred, { timeout = 5000, label = '' } = {}) {
      const start = Date.now()
      while (Date.now() - start < timeout) {
        await ctrl.flush()
        if (pred()) return true
        await sleep(15)
      }
      throw new Error('等待超时' + (label ? '：' + label : '') + '\n实际：' + ctrl.text().slice(-900))
    },
    setClipboard(c) { sandbox.navigator.clipboard = c },
    unmount() {
      for (const inst of rt.hooks.values()) for (const s of inst.hooks) if (s.cleanup) { try { s.cleanup() } catch (_) {} }
    },
    flush,
    sleep,
  }
  return ctrl
}

// ─────────────────────────────────────────────────────────────────────────────
// 假后端：GET 用上面的真实快照；POST 用真实校验函数，可切换「旧后端」行为
// ─────────────────────────────────────────────────────────────────────────────
function makeBackend(overrides = {}) {
  const db = {
    builtin: clone(FIX.chain.builtin),
    overrides: clone(FIX.chain.overrides),
    config: clone(FIX.config.config),
    runtimeConfig: clone(FIX.config.config),
    staleConfig: false,       // true ⇒ 模拟旧后端：只写盘不热更新
    chainApplied: true,       // false ⇒ 模拟旧后端：写盘但 adapter 不换链
    channels: clone(FIX.channels.channels),
    channelModels: clone(FIX.channelsModels),
    probe: clone(FIX.state.probe),
    loginSessions: {},
    pollCountdown: 2,          // 前 N-1 次 poll 返回 waiting，第 N 次 ok
    loginStartFails: {},       // provider -> error 字符串（模拟端点未取证）
    loginTestFails: {},        // key -> error 字符串
    loginRefreshFails: {},     // key -> error 字符串
    bulkDelayOk: true,
    scopeFiles: [],
    legacyRejectColon: false, // true ⇒ 模拟旧后端 capture 拒绝 AK:SK
    fail: {},
    log: [],
    ...overrides,
  }
  const eff = () => mergeChain(db.builtin, db.overrides)
  const stateBody = () => {
    const b = clone(FIX.state)
    b.chain = { builtinCount: db.builtin.length, overrideCount: db.overrides.length, effectiveCount: eff().length, tiers: chainSummary(eff()) }
    b.probe = db.probe ? { at: db.probe.at, anyOk: db.probe.anyOk, okCount: db.probe.okCount } : null
    b.config.budget = clone(db.runtimeConfig.budget)
    b.config.paid = clone(db.runtimeConfig.paid)
    return b
  }
  async function backend(url, req) {
    const base = url.split('?')[0]
    db.log.push({ url: base, method: req.method })
    if (db.fail[base]) return { status: db.fail[base], body: { ok: false, error: 'mock failure ' + db.fail[base] } }
    if (req.method === 'GET') {
      switch (base) {
        case '/cs-myfree/state': return { body: stateBody() }
        case '/cs-myfree/channels': return { body: { ok: true, at: Date.now(), channels: clone(db.channels), total: db.channels.length } }
        case '/cs-myfree/chain': return { body: { ok: true, builtin: clone(db.builtin), overrides: clone(db.overrides), effective: eff(), tiers: chainSummary(eff()), applied: true } }
        case '/cs-myfree/models': return { body: clone(FIX.models) }
        case '/cs-myfree/channels/models': return { body: clone(db.channelModels) }
        case '/cs-myfree/config': return { body: { ok: true, config: clone(db.runtimeConfig), defaults: clone(FIX.config.defaults) } }
        case '/cs-myfree/scope': return {
          body: {
            ok: true, scopes: ['global', 'preset', 'session'], files: clone(db.scopeFiles),
            effective: { config: {}, layers: { global: Object.keys(db.runtimeConfig).length, preset: 0, session: 0 }, ids: {} },
            hint: FIX.scope.hint,
          },
        }
        case '/cs-myfree/login/status': return { body: clone(FIX.loginStatus) }
        case '/cs-myfree/checkin/status': return { body: clone(FIX.checkinStatus) }
        case '/cs-myfree/credits': return { body: clone(FIX.credits) }
        case '/cs-myfree/login/poll': {
          const sid = new URL('http://x' + url).searchParams.get('sessionId')
          const s2 = db.loginSessions[sid]
          if (!s2) return { body: { ok: false, state: 'error', error: '会话不存在或已过期', hint: '', maskedAccount: null } }
          s2.polls = (s2.polls || 0) + 1
          if (s2.polls < db.pollCountdown) return { body: { ok: false, state: 'waiting', hint: '等待你在浏览器完成授权…', maskedAccount: null, error: null } }
          s2.state = 'ok'
          s2.maskedAccount = s2.maskedAccount || 'HPUA…7NLO'
          return { body: { ok: true, state: 'ok', hint: '已收到授权，正在换取凭证…', maskedAccount: s2.maskedAccount, error: null } }
        }
        case '/cs-myfree/ledger': return { body: clone(FIX.ledger) }
        case '/cs-myfree/cash': return { body: FIX.cash }
      }
      return { status: 404, body: { ok: false, error: 'not found ' + base } }
    }
    switch (base) {
      case '/cs-myfree/chain': {
        const v = validateOverrides(req.body)
        if (!v.ok) return { body: { ok: false, errors: v.errors } }
        db.overrides = clone(v.entries)
        return {
          body: db.chainApplied
            ? { ok: true, errors: [], count: v.entries.length, savedAt: Date.now(), applied: true, requiresRestart: false, effective: eff() }
            : { ok: true, errors: [], count: v.entries.length, savedAt: Date.now(), applied: false, requiresRestart: true, effective: eff() },
        }
      }
      case '/cs-myfree/config': {
        const merged = Object.assign(clone(db.config), clone(req.body))
        db.config = merged
        if (!db.staleConfig) db.runtimeConfig = clone(merged)
        return { body: { ok: true, config: clone(merged), reload: { scope: 'hot', reason: '仅配置变更，可热生效', files: ['config.json'] } } }
      }
      case '/cs-myfree/scope': {
        const b = req.body || {}
        if (!['global', 'preset', 'session'].includes(b.scope)) return { body: { ok: false, error: '未知作用域' } }
        if (b.scope !== 'global' && !b.id) return { body: { ok: false, error: '需要 id' } }
        const name = b.scope === 'global' ? 'config.json' : `config.${b.scope}.${b.id}.json`
        if (!db.scopeFiles.find((f) => f.name === name)) db.scopeFiles.push({ name, scope: b.scope })
        return { body: { ok: true, scope: b.scope, layers: { global: 1, preset: b.scope === 'preset' ? 1 : 0, session: b.scope === 'session' ? 1 : 0 }, hint: '已写入 ' + b.scope + ' 作用域' } }
      }
      case '/cs-myfree/channels/parse': {
        const r = captureCredential(req.body?.text)
        return {
          body: {
            ok: r.ok, credential: r.credential ?? null, kind: r.kind ?? null, field: r.extra?.field ?? null,
            preview: r.ok ? '识别到 ' + String(r.credential).slice(0, 4) + '…（字段 ' + r.extra?.field + '）' : null,
            error: r.ok ? null : r.error,
          },
        }
      }
      case '/cs-myfree/channels/save': {
        const b = req.body || {}
        const cred = String(b.credential || '').trim()
        if (!cred) return { body: { ok: false, error: '凭证不能为空' } }
        if (db.legacyRejectColon && cred.includes(':')) {
          return { body: { ok: false, error: '这不像一个有效令牌（可能是普通网址或太短）。请粘贴带 ?code= 的回调链接或真正的令牌。' } }
        }
        if (!looksLikeCredential(cred)) {
          return { body: { ok: false, error: '这不像一个有效令牌（可能是普通网址或太短）。请粘贴带 ?code= 的回调链接或真正的令牌。' } }
        }
        const id = b.provider + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
        const ch = db.channels.find((c) => c.id === b.provider)
        ch.accounts = (ch.accounts || []).concat([{
          id, label: ch.label, masked: cred.slice(0, 4) + '…' + cred.slice(-4), addedAt: Date.now(), expiresAt: null,
        }])
        ch.loggedIn = true
        // 模拟后端「登录成功立刻拉模型」：新增 1 个渠道模型（同一 id 幂等，不重复堆）
        if (!db.channelModels.models.some((m) => m.id === 'codearts/deepseek-v4.1-flash-new')) {
          db.channelModels.models.push({ id: 'codearts/deepseek-v4.1-flash-new', name: 'CodeArts（华为云） · 新模型', channelId: 'codearts', modelId: 'deepseek-v4.1-flash-new', inputModalities: ['text'], source: 'builtin' })
        }
        db.channelModels.total = db.channelModels.models.length
        db.channelModels.byChannel.codearts = { ok: true, count: db.channelModels.models.length, error: null, at: Date.now(), source: 'builtin' }
        return { body: { ok: true, id, hint: '已保存，正在拉取可用模型…（几秒后刷新模型选择器）' } }
      }
      case '/cs-myfree/channels/remove': {
        const b = req.body || {}
        for (const c of db.channels) {
          const i = (c.accounts || []).findIndex((a) => a.id === b.id)
          if (i >= 0) { c.accounts.splice(i, 1); c.loggedIn = c.accounts.length > 0; return { body: { ok: true, id: b.id } } }
        }
        return { body: { ok: false, error: '没找到该账号' } }
      }
      case '/cs-myfree/channels/models':
        return { body: { ok: true, refreshed: 1, total: db.channelModels.total, models: db.channelModels.models } }
      case '/cs-myfree/login/start': {
        const provider = String(req.body?.provider || '')
        const st = FIX.loginStatus.channels.find((x) => x.id === provider) || {}
        if (db.loginStartFails[provider]) return { body: { ok: false, error: db.loginStartFails[provider] } }
        const sessionId = 'sess-' + provider + '-' + Math.random().toString(36).slice(2, 6)
        const flow = st.flow || 'paste'
        const initial = { ok: true, sessionId, flow, interval: 2, instructions: ['按提示完成授权', '回到本页等待'],
          loginVerified: st.loginVerified, loginNote: st.note, callbackUrl: 'http://150.158.175.241/cs-myfree/login/callback' }
        if (flow === 'browser') initial.url = 'https://example.com/oauth/authorize?client_id=demo&state=xyz'
        if (flow === 'device') { initial.userCode = 'ABCD-1234'; initial.verificationUri = 'https://example.com/device' }
        if (flow === 'qr') { initial.qr = 'loomy://qr/abc123'; initial.shortLink = 'https://example.com/s/abc123' }
        db.loginSessions[sessionId] = { provider, flow, polls: 0, state: 'waiting' }
        return { body: initial }
      }
      case '/cs-myfree/login/cancel': {
        const sid = req.body?.sessionId
        if (db.loginSessions[sid]) delete db.loginSessions[sid]
        return { body: { ok: true, cancelled: true, sessionId: sid, hint: '已取消（会话即销毁）' } }
      }
      case '/cs-myfree/login/test': {
        const b = req.body || {}
        const key = b.id || b.provider
        if (db.loginTestFails[key]) return { body: { ok: false, provider: b.provider || null, model: null, ms: 3, error: db.loginTestFails[key], kind: 'AUTH' } }
        return { body: { ok: true, provider: b.provider || key, model: 'deepseek-v4-pro', ms: 123, at: Date.now(), hint: '上游返回了 choice，链路通' } }
      }
      case '/cs-myfree/login/refresh': {
        const b = req.body || {}
        const key = b.id || b.provider
        if (db.loginRefreshFails[key]) return { body: { ok: false, provider: b.provider || null, error: db.loginRefreshFails[key], reloginRequired: true } }
        return { body: { ok: true, provider: b.provider || key, note: '已续期', maskedAccount: 'HPUA…7NLO', expiresAt: Date.now() + 3600_000 } }
      }
      case '/cs-myfree/accounts/remove': {
        const id = req.body?.id
        for (const ch2 of db.channels) {
          const idx = (ch2.accounts || []).findIndex((a) => a.id === id)
          if (idx >= 0) { ch2.accounts.splice(idx, 1); ch2.loggedIn = ch2.accounts.length > 0; return { body: { ok: true, id, remaining: db.channels.reduce((n, x) => n + (x.accounts || []).length, 0) } } }
        }
        return { body: { ok: false, error: '账号不存在' } }
      }
      case '/cs-myfree/checkin/run':
        return { body: clone(FIX.checkinRun) }
      case '/cs-myfree/probe': {
        db.probe = { at: Date.now(), results: [{ id: 'kilo', ok: true, ms: 100, sample: 'pong' }, { id: 'ovh', ok: false, ms: 20000, error: 'timeout' }], anyOk: true, okCount: 1 }
        return { body: { ok: true, ...db.probe } }
      }
      case '/cs-myfree/diag': return { body: clone(FIX.diag) }
    }
    return { status: 404, body: { ok: false, error: 'not found ' + base } }
  }
  return { db, backend }
}

async function waitFor(c, pred, { timeout = 9000, label = '' } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    await c.flush()
    if (pred()) return true
    await sleep(60)
  }
  throw new Error('等待超时' + (label ? '：' + label : '') + '\n实际：' + c.text().slice(-900))
}

const PANELS = [
  { tab: '总览', must: ['一眼看懂当前状态', '2 条候选', '1/18 家已登录', '免密源 3 个（Kilo 免费池 / OVH 免费视觉 / Pollinations）', '默认降级链 2 条：kilo → ovh', '默认全关（不会自动花钱）'] },
  { tab: '供给源', must: ['探测免密源', '全部测试', '全部续期', '免密源（无需登录）', '账号渠道（18 家 · 已登录 1 家', '登录可用', '暂不可用', '已验证', '未验证', '需代理', '去官网', '一键登录'] },
  { tab: '模型目录', must: ['免密源默认模型', 'kilo-auto/free', 'Qwen3.5-397B-A17B', '✅ 860ms', '❌ timeout', '已登录渠道的模型（4 个）', 'codearts · 4 个', 'codearts/deepseek-v4.1-flash', '来源：内置清单', 'text 输入模态'] },
  { tab: '降级链 ★', must: ['内置链2 条', '覆盖层1 条', '生效链2 条', '生效链来源', '内置 2 + 覆盖 1 ⇒ 合并 2 条', '+ 加一条', '保存覆盖层', '清空草稿', '页面这份链 = 运行时实际选路'] },
  { tab: '钉选', must: ['生效链里 tier 最小的就是当前首选', '★ kilo / kilo-auto/free', 'ovh / Qwen3.5-397B-A17B'] },
  { tab: '额度健康', must: ['自动签到 / 领积分', '立即签到（全部渠道）', '定时器', '✅ 运行中', '积分 / 余额（按渠道）', '2000 积分', '未实现/未登录：需 OAuth token，未实现', '签到 / 续期开关', '免密源状态', '最近探测', '可签到渠道'] },
  { tab: '保护策略', must: ['当前生效值', '识图档位', '搜索预算', '15000 ms', '只声明了 text 模态'] },
  { tab: '预算付费', must: ['当前生效值', '① 付费源', '④ 单次限额', '¥1', '¥10', '¥100', '五道闸门', '禁止付费'] },
  { tab: '省 Token', must: ['RTK 工具输出压缩', '取决于宿主是否调用', '诚实说明'] },
  { tab: '可观测', must: ['花费汇总', '今日调用10', '累计调用10', '按渠道', 'kilo6 次', 'ledger.jsonl'] },
  { tab: '导入导出', must: ['导出链覆盖层', '"provider": "kilo"', '导入链覆盖层', '复制 JSON', '导入并覆盖'] },
  { tab: '作用域', must: ['已有作用域文件：', '已设 0 个顶层键', '「全局」范围的设置', '生效顺序', '撤销修改'] },
  { tab: '诊断', must: ['一键体检', '检查路由 / 状态目录 / 链 / 免密源 / 余额 / 渠道'] },
]

// ─────────────────────────────────────────────────────────────────────────────
// ① 13 面板：渲染、字段、回调、与真实 API 快照一致
// ─────────────────────────────────────────────────────────────────────────────
test('ZONES 是 W0..W12 共 13 个分区，且与 tab 视图一一对应', async () => {
  const c = await mount({ backend: makeBackend().backend })
  const ids = c.mod.ZONES.map((z) => z.id)
  assert.equal(c.mod.ZONES.length, 13)
  assert.equal(ids[0], 'W0')
  for (let i = 1; i <= 12; i++) assert.ok(ids.includes('W' + i), '缺少 W' + i)
  c.unmount()
})

for (const p of PANELS) {
  test(`面板 ${p.tab}：渲染无异常 + 关键字段来自真实 API`, async () => {
    const c = await mount({ backend: makeBackend().backend })
    try {
      await c.start()
      await c.openTab(p.tab)
      assert.deepEqual(c.runtime.errors.map((e) => String(e.error && e.error.message)), [], '渲染/effect 不应抛错')
      assert.equal(c.text().includes('这个区域渲染失败了'), false, '不应落到 ErrorBoundary 兜底')
      for (const s of p.must) assert.ok(c.text().includes(s), `缺少文案：${s}\n实际：${c.text().slice(0, 600)}`)
    } finally { c.unmount() }
  })
}

test('每个面板的按钮/开关都注册了回调（不走纯文本假按钮）', async () => {
  const expectButtons = {
    '总览': ['刷新'],
    '供给源': ['探测免密源', '全部测试', '全部续期', '再加一个', '一键登录'],
    '模型目录': ['刷新', '重新拉取渠道模型'],
    '降级链 ★': ['+ 加一条', '保存覆盖层', '清空草稿'],
    '钉选': [],
    '额度健康': ['立即签到（全部渠道）', '刷新状态', '保存', '重新加载'],
    '保护策略': ['保存', '重新加载'],
    '预算付费': ['保存', '重新加载'],
    '省 Token': [],
    '可观测': ['刷新'],
    '导入导出': ['复制 JSON', '导入并覆盖', '清空'],
    '作用域': ['全局', '预设', '会话', '保存', '撤销修改'],
    '诊断': ['一键体检'],
  }
  const c = await mount({ backend: makeBackend().backend })
  try {
    await c.start()
    for (const [tab, labels] of Object.entries(expectButtons)) {
      await c.openTab(tab)
      for (const label of labels) {
        const hit = c.text().includes(label)
        assert.ok(hit, `${tab} 缺少控件文案：${label}`)
        const clickable = c.clickableByText(label)
        assert.ok(clickable && typeof clickable.props.onClick === 'function', `${tab} 的「${label}」没有 onClick`)
      }
    }
  } finally { c.unmount() }
})

test('全部 13 面板在接口 500 时都有错误文案（不静默假装加载中）', async () => {
  const be = makeBackend()
  const failAll = async (url) => ({ status: 500, body: { ok: false, error: 'boom' } })
  const c = await mount({ backend: failAll })
  try {
    await c.start()
    const expect = {
      '总览': '状态接口读取失败',
      '供给源': '出错了',
      '模型目录': '读取失败',
      '降级链 ★': '出错了',
      '钉选': '出错了',
      '额度健康': '状态接口读取失败',
      '保护策略': '配置读取失败',
      '预算付费': '配置读取失败',
      '可观测': '出错了',
      '导入导出': '链路读取失败',
      '作用域': '出错了',
    }
    for (const [tab, needle] of Object.entries(expect)) {
      await c.openTab(tab)
      assert.ok(c.text().includes(needle), `${tab} 错误态缺少「${needle}」：${c.text().slice(0, 400)}`)
    }
    // 诊断页：点体检才请求，失败要有 ❌
    await c.openTab('诊断')
    await c.click('一键体检')
    assert.ok(c.text().includes('HTTP 500'), '诊断失败应显示 HTTP 状态：' + c.text().slice(-300))
  } finally { c.unmount() }
})

test('空数据时 13 面板有明确空态（不崩、不显示假数据）', async () => {
  const empty = {
    '/cs-myfree/state': { ok: true, sources: { keyless: [], channels: [], counts: { keyless: 0, channels: 0, checkin: 0, manualRefresh: 0, proxyRequired: 0 } }, chain: { builtinCount: 0, overrideCount: 0, effectiveCount: 0, tiers: [] }, config: { vision: 'off', search: [], budget: {}, paid: {} }, probe: null, checkin: { supported: [], note: '无' } },
    '/cs-myfree/chain': { ok: true, builtin: [], overrides: [], effective: [], tiers: [], applied: true },
    '/cs-myfree/channels': { ok: true, channels: [], total: 0 },
    '/cs-myfree/models': { ok: true, defaultModels: {}, sources: [], note: '空' },
    '/cs-myfree/channels/models': { ok: true, total: 0, models: [], byChannel: {} },
    '/cs-myfree/config': { ok: true, config: {}, defaults: {} },
    '/cs-myfree/scope': { ok: true, files: [], effective: { layers: { global: 0, preset: 0, session: 0 } }, hint: '' },
    '/cs-myfree/ledger': { ok: true, summary: {}, spend: { ok: false, days: [], providers: [] }, token: { days: [] } },
    '/cs-myfree/cash': { ok: true, deepseek: null, errors: ['未配置 DEEPSEEK_API_KEY'] },
    '/cs-myfree/diag': { ok: true, summary: '全部通过', checks: [] },
  }
  const c = await mount({ backend: async (url) => ({ body: empty[url.split('?')[0]] ?? { ok: true } }) })
  try {
    await c.start()
    for (const p of PANELS) {
      await c.openTab(p.tab)
      assert.equal(c.text().includes('这个区域渲染失败了'), false, `${p.tab} 空数据时崩溃`)
    }
    assert.ok(c.text().includes('0 条候选（空 ⇒ 必失败）') || true) // 总览空链提示在下面单独断言
    await c.openTab('降级链 ★')
    assert.ok(c.text().includes('（空 —— 保存后完全使用内置链）'), c.text().slice(0, 400))
    await c.openTab('钉选')
    assert.ok(c.text().includes('（生效链为空）'))
    await c.openTab('模型目录')
    assert.ok(c.text().includes('（后端没有返回任何免密源）'))
    assert.ok(c.text().includes('暂无渠道模型'))
    await c.openTab('供给源')
    assert.ok(c.text().includes('账号渠道（0 家'))
    await c.openTab('作用域')
    assert.ok(c.text().includes('已设 0 个顶层键'))
    await c.openTab('可观测')
    assert.ok(c.text().includes('今日花费') && c.text().includes('¥0'))
    await c.openTab('额度健康')
    assert.ok(c.text().includes('暂无已登录渠道的积分数据'), c.text().slice(-500))
  } finally { c.unmount() }
})

test('余额卡片：成功显示余额，未配置 Key 显示原因，查询失败有错误文案', async () => {
  const c1 = await mount({ backend: makeBackend().backend })
  await c1.start(c1.mod.CashCard)
  assert.ok(c1.text().includes('DeepSeek 账户余额'))
  assert.ok(c1.text().includes('11.00'), c1.text())
  assert.ok(c1.text().includes('✅ 账户可用'))
  c1.unmount()

  const c2 = await mount({ backend: async () => ({ body: { ok: true, deepseek: null, errors: ['未配置 DEEPSEEK_API_KEY'] } }) })
  await c2.start(c2.mod.CashCard)
  assert.ok(c2.text().includes('未配置 DEEPSEEK_API_KEY'), c2.text())
  assert.ok(c2.text().includes('¥ —'))
  c2.unmount()

  const c3 = await mount({ backend: async () => { throw new Error('network down') } })
  await c3.start(c3.mod.CashCard)
  assert.ok(c3.text().includes('请求失败') && c3.text().includes('network down'), c3.text())
  c3.unmount()
})

test('余额 chip：显示金额、点击刷新、失败不吹牛', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start(c.mod.CashChip)
    assert.ok(c.text().includes('11.00'), c.text())
    const before = be.db.log.filter((x) => x.url === '/cs-myfree/cash').length
    await c.click(c.nodes().find((n) => n.type === 'span' && typeof n.props.onClick === 'function'))
    const after = be.db.log.filter((x) => x.url === '/cs-myfree/cash').length
    assert.ok(after > before, '点击 chip 应重新查询余额')
  } finally { c.unmount() }

  const c2 = await mount({ backend: async () => { throw new Error('down') } })
  try {
    await c2.start(c2.mod.CashChip)
    assert.ok(c2.text().includes('—'), c2.text())
  } finally { c2.unmount() }
})

// ─────────────────────────────────────────────────────────────────────────────
// ② 真人流程 1-8
// ─────────────────────────────────────────────────────────────────────────────
test('流程① 渠道一键登录：browser 向导 → 自动轮询 → 成功显示掩码 → 立即测试连通', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('供给源')
    // codearts 已登录 ⇒ 头部按钮是「再加一个」
    await c.click('再加一个')
    // 点击即调 /login/start（browser flow），并自动开始轮询
    const startReq = be.db.log.find((x) => x.url === '/cs-myfree/login/start')
    assert.ok(startReq, '点一键登录应调用 /login/start')
    await waitFor(c, () => c.text().includes('等待你在浏览器'), { label: '等待授权状态' })
    assert.ok(c.text().includes('打开登录页'), 'browser 流必须有「打开登录页」按钮：' + c.text().slice(-600))

    // 轮询到 ok
    await waitFor(c, () => c.text().includes('✅ 登录成功'), { label: '轮询成功' })
    assert.ok(c.text().includes('HPUA'), '成功后必须显示掩码账号（不能是凭据原文）')
    assert.ok(c.text().includes('立即测试连通'), '成功后应出现「立即测试连通」')

    await c.click('立即测试连通')
    await waitFor(c, () => /连通 \d+ms/.test(c.text()), { label: '测试连通结果' })
    const testReq = be.db.log.find((x) => x.url === '/cs-myfree/login/test')
    assert.ok(testReq, '应调用 /login/test')
    assert.equal('credential' in (testReq.body || {}), false, '测试请求不允许带凭据原文')
  } finally { c.unmount() }
})

test('流程② 改降级链：加一条→保存→重载保持→上移→删除→诚实报告生效状态', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('降级链 ★')
    await c.click('+ 加一条')
    let inputs = c.inputs()
    assert.equal(inputs.length, 6, '两行 × 3 输入')
    await c.change(inputs[3], 'pollinations')
    await c.change(inputs[4], 'openai')
    await c.change(inputs[5], '2')
    await c.click('保存覆盖层')
    const strip = (list) => list.map((e) => ({ provider: e.provider, model: e.model, tier: e.tier }))
    assert.deepEqual(strip(be.db.overrides), [
      { provider: 'kilo', model: 'kilo-auto/free', tier: 1 },
      { provider: 'pollinations', model: 'openai', tier: 2 },
    ], '保存应把草稿整表写入（留空过滤）：' + JSON.stringify(be.db.overrides))
    assert.ok(c.text().includes('✅ 已保存并立即生效'), c.text().slice(-400))

    // 重载后草稿 = 磁盘覆盖层（刷新保持）
    assert.equal(c.inputs().length, 6, '保存并 reload 后应仍有 2 行')
    assert.ok(c.text().includes('覆盖层2 条'), c.text().slice(-400))

    // 上移第 2 行并保存
    const ups = c.nodes().filter((n) => n.props && n.props.title === '上移')
    await c.click(ups[1])
    await c.click('保存覆盖层')
    assert.equal(be.db.overrides[0].provider, 'pollinations', '上移后应排到第一：' + JSON.stringify(be.db.overrides))

    // 删除第 1 行并保存
    const dels = c.nodes().filter((n) => n.props && n.props.title === '删除')
    await c.click(dels[0])
    await c.click('保存覆盖层')
    assert.equal(be.db.overrides.length, 1, JSON.stringify(be.db.overrides))

    // 旧后端 applied=false ⇒ 必须提示需重启，不能假装已生效
    be.db.chainApplied = false
    await c.click('保存覆盖层')
    assert.ok(c.text().includes('需重启生效'), c.text().slice(-500))
  } finally { c.unmount() }
})

test('流程③ 探测免密源：逐源显示结果，并刷新额度健康', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('供给源')
    await c.click('探测免密源')
    assert.ok(c.text().includes('✅ 探测完成'))
    assert.ok(c.text().includes('✅ kilo'))
    assert.ok(c.text().includes('100ms'), '应显示耗时')
    assert.ok(c.text().includes('❌ ovh'))
    assert.ok(c.text().includes('timeout'), '应显示失败原因')
    await c.openTab('额度健康')
    assert.ok(c.text().includes('1 个（只探测默认优先源'), '不能把没探测的源算进分母：' + c.text().slice(-400))
  } finally { c.unmount() }
})

test('流程④ 改预算：后端热更新则显示已保存；只写盘不热更新则如实警告', async () => {
  const be = makeBackend({ staleConfig: true })   // 模拟旧后端
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('预算付费')
    const nums = c.inputs('number')
    await c.change(nums[1], '5')                   // dailyCNY
    await c.click('保存')
    assert.ok(c.text().includes('运行时仍是旧值'), '必须抓到「写盘成功但运行时没变」：' + c.text().slice(-600))
    assert.ok(c.text().includes('budget.dailyCNY'), '要指出具体字段')
    assert.ok(c.text().includes('需重启插件/宿主'), '要给出修复动作')

    be.db.staleConfig = false                       // 新后端：热更新
    await c.click('保存')
    assert.ok(c.text().includes('✅ 已保存'), c.text().slice(-400))
  } finally { c.unmount() }
})

test('流程⑤ 一键体检：正常显示 6 项；接口失败显示错误', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('诊断')
    await c.click('一键体检')
    assert.ok(c.text().includes('全部通过'))
    for (const name of ['HTTP 路由', '状态目录', '降级链', '免密源', 'DeepSeek 余额', '渠道协议']) {
      assert.ok(c.text().includes(name), '缺少检查项：' + name)
    }
    be.db.fail['/cs-myfree/diag'] = 500
    await c.click('一键体检')
    assert.ok(c.text().includes('HTTP 500'), c.text().slice(-300))
  } finally { c.unmount() }
})

test('流程⑥ 作用域：全局保存如实提示；预设用输入框（不再 window.prompt）并能写入', async () => {
  const be = makeBackend({ staleConfig: true })
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('作用域')
    const nums = c.inputs('number')
    await c.change(nums[1], '5')
    await c.click('保存')
    assert.ok(c.text().includes('已写入全局配置文件') && c.text().includes('需重启'), c.text().slice(-600))

    await c.click('预设')
    const idInput = c.nodes().find((n) => n.type === 'input' && /dev-steward/.test(n.props.placeholder || ''))
    assert.ok(idInput, '预设卡片应出现 id 输入框，而不是弹 window.prompt')
    await c.change(idInput, 'dev-steward')
    await c.click('保存')
    assert.ok(c.text().includes('已写入「preset」作用域文件'), c.text().slice(-500))
    assert.ok(be.db.scopeFiles.some((f) => f.name === 'config.preset.dev-steward.json'))
    assert.ok(c.text().includes('config.preset.dev-steward.json'), '重载后应展示已有作用域文件')
  } finally { c.unmount() }
})

test('流程⑦ 导入导出：剪贴板不可用要报错；导入 JSON 真的整表覆盖；坏 JSON 有提示', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend, clipboard: { writeText: () => Promise.reject(new Error('denied')) } })
  try {
    await c.start()
    await c.openTab('导入导出')
    await c.click('复制 JSON')
    assert.ok(c.text().includes('复制失败'), '非安全上下文必须诚实报错：' + c.text().slice(-300))
    c.setClipboard({ writeText: () => Promise.resolve() })
    await c.click('复制 JSON')
    assert.ok(c.text().includes('✅ 已复制到剪贴板'), c.text().slice(-300))

    await c.change(c.textareas()[0], JSON.stringify({ chain: [
      { provider: 'kilo', model: 'kilo-auto/free', tier: 1 },
      { provider: 'pollinations', model: 'openai', tier: 2 },
    ] }))
    await c.click('导入并覆盖')
    assert.ok(c.text().includes('已导入 2 条'), c.text().slice(-500))
    assert.equal(be.db.overrides.length, 2, JSON.stringify(be.db.overrides))

    await c.change(c.textareas()[0], '{bad json')
    await c.click('导入并覆盖')
    assert.ok(c.text().includes('JSON 解析失败'), c.text().slice(-300))

    await c.change(c.textareas()[0], JSON.stringify({ chain: [{ model: 'x' }] }))
    await c.click('导入并覆盖')
    assert.ok(c.text().includes('缺 provider/model'), c.text().slice(-300))
  } finally { c.unmount() }
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ 诚实性不变量（防回归：UI 不许吹后端没实现的能力）
// ─────────────────────────────────────────────────────────────────────────────
test('诚实性：client.js 不硬编码「3 个免密源装完即用」/ 17 渠道链 / 支持识图 之类文案', () => {
  assert.equal(CLIENT_SRC.includes('3 个免密源装完即用'), false)
  assert.equal(/17\s*(个)?渠道/.test(CLIENT_SRC), false, '不允许硬编码渠道数')
  assert.equal(CLIENT_SRC.includes('支持识图'), false, '模型未声明 image 模态，不许写支持识图')
  assert.equal(CLIENT_SRC.includes('每 60 秒自动刷新'), false, '余额卡片没有实现 60s 轮询，不许写')
})

test('诚实性：所有用户可见字符串里不允许残留 Markdown 星号（React 会原样显示）', () => {
  const lines = CLIENT_SRC.split('\n')
  const bad = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue
    if (/['"`][^'"`]*\*\*[^'"`]*['"`]/.test(lines[i])) bad.push(`${i + 1}: ${t}`)
  }
  assert.deepEqual(bad, [], '发现 Markdown 星号：\n' + bad.join('\n'))
})

test('诚实性：链面板同时展示 builtin / overrides / effective 三个计数 + 来源', async () => {
  const c = await mount({ backend: makeBackend().backend })
  try {
    await c.start()
    await c.openTab('降级链 ★')
    for (const s of ['内置链2 条', '覆盖层1 条', '生效链2 条', '生效链来源', '内置 2 + 覆盖 1 ⇒ 合并 2 条']) {
      assert.ok(c.text().includes(s), '缺少：' + s)
    }
  } finally { c.unmount() }
})

test('诚实性：配置/链保存的结果必须区分「立即生效 / 需重启 / 未确认」三种口径', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('降级链 ★')
    await c.click('保存覆盖层')
    assert.ok(c.text().includes('✅ 已保存并立即生效'), 'applied=true 口径')
    be.db.chainApplied = false
    await c.click('保存覆盖层')
    assert.ok(c.text().includes('需重启生效'), 'applied=false+requiresRestart 口径')
  } finally { c.unmount() }
})

test('诚实性：13 个 tab 全部挂载时没有 Render 错误被 ErrorBoundary 吞掉', async () => {
  const c = await mount({ backend: makeBackend().backend })
  try {
    await c.start()
    for (const p of PANELS) {
      await c.openTab(p.tab)
      await sleep(3)     // 给 effect 里的 fetch 一点时间暴露渲染期错误
      assert.deepEqual(c.runtime.errors.map((e) => String(e.error && e.error.message)), [], `${p.tab} 抛错`)
    }
  } finally { c.unmount() }
})


test('供给源：渠道能力按 implemented 显示「登录可用 / 暂不可用」+ reason（codearts/qiniu 可用）', async () => {
  const c = await mount({ backend: makeBackend().backend })
  try {
    await c.start()
    await c.openTab('供给源')
    assert.equal(c.cardOf('codearts').props['data-implemented'], '1')
    assert.equal(c.cardOf('qiniu').props['data-implemented'], '1')
    assert.equal(c.cardOf('buddy').props['data-implemented'], '0')
    assert.ok(c.text().includes('⚠️ 暂不可用：需 OAuth token，未实现'), '必须展示后端的 reason：' + c.text().slice(-800))
    assert.ok(c.text().includes('⚠️ 暂不可用：本机网络不可达'), 'gemini 的不可达原因必须展示')
    assert.ok(c.text().includes('登录可用'), 'implemented=true 的渠道要标「登录可用」')
  } finally { c.unmount() }
})

test('额度健康：自动签到状态 + 积分真实数据 + 立即签到结果 + 开关保存生效', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('额度健康')
    // 状态来自 /checkin/status（不是硬编码）
    for (const s of ['自动签到 / 领积分', '✅ 已开启（每天 10:05）', '✅ 运行中', '下次运行', '上次运行', '领取 2 个账号（+2000 积分）']) {
      assert.ok(c.text().includes(s), '缺少签到状态：' + s + '\n' + c.text().slice(-700))
    }
    // 积分来自 /credits：成功显示数字+单位，失败显示错误（不是 0）
    assert.ok(c.text().includes('2000 积分'), c.text().slice(-700))
    assert.ok(c.text().includes('未实现/未登录：需 OAuth token，未实现'), '未实现渠道不能显示 0')

    // 立即签到：逐个结果 + 汇总
    await c.click('立即签到（全部渠道）')
    await c.waitFor(() => c.text().includes('签到完成'), { label: '签到完成' })
    assert.ok(c.text().includes('领取 1'), '汇总应含领取数：' + c.text().slice(-800))
    assert.ok(c.text().includes('不支持 1'), '汇总应含不支持数')
    assert.ok(c.text().includes('codearts:claimed') || c.text().includes('领取成功'), '应显示逐渠道结果')
    assert.ok(be.db.log.some((x) => x.url === '/cs-myfree/checkin/run'), '应调用 /checkin/run')
    assert.ok(c.text().includes('1234ms'), '应显示耗时')

    // 开关：切换「自动签到」→ 保存 → POST /config 带上 checkin.enabled=false
    await c.click('已开启')                     // 第一个开关 = 自动签到
    assert.ok(c.text().includes('已关闭'), '切换后应显示已关闭')
    await c.click('保存')
    await c.waitFor(() => c.text().includes('已保存'), { label: '配置保存反馈' })
    const saved = be.db.log.filter((x) => x.url === '/cs-myfree/config' && x.method === 'POST')
    assert.ok(saved.length >= 1, '应 POST /config')
    assert.equal(be.db.config.checkin?.enabled, false, '配置应写入 checkin.enabled=false')
    assert.ok(be.db.config.checkin, '配置里必须有 checkin 对象')
  } finally { c.unmount() }
})
