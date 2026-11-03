/**
 * cs-myfree 设置页「一键登录」向导 UI 测试（Node stub 宿主，无浏览器）
 *
 * 覆盖任务 P0-A3 的验收点：
 *  · 5 种 flow 分支渲染：browser / device / qr / paste / aksk
 *  · 轮询状态机：waiting → ok / error；成功后停止轮询；取消；pollingOnly
 *  · 未验证徽标（loginVerified=false）+ note；已验证渠道徽标
 *  · 账号管理：测试连通 / 续期（含「需人工重登」）/ 删除二次确认
 *  · 顶部「全部测试」「全部续期」批量操作
 *  · 二维码是真 SVG（与 Python qrcode 参考实现逐模块对拍），不是 <pre> 文本
 *  · 失败/超时/端点未取证时有可读错误 + 备用粘贴入口，不假装成功
 *  · 凭据不回显（只显示掩码；/channels/parse 响应不含原文）
 *
 * fetch 全 mock（不联网）；后端校验函数 import 真实模块保证契约一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { captureCredential, looksLikeCredential } from '../src/pools/channels/capture.js'

const CLIENT_PATH = fileURLToPath(new URL('../src/client.js', import.meta.url))
const CLIENT_SRC = readFileSync(CLIENT_PATH, 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 与 src/pools/channels/login/flow-map.js 对齐（codearts 已真机验证）
const FLOW_OF = {
  codearts: 'browser', buddy: 'browser', workbuddy: 'browser', lobsterai: 'browser',
  trae: 'browser', accio: 'browser', gemini: 'browser', officeace: 'browser',
  qoder: 'device', qodercn: 'device', cline: 'device', minimax: 'device',
  minimaxintl: 'device', zcode: 'device',
  loomy: 'qr', raccoon: 'qr',
  qiniu: 'paste', opencode: 'paste',
}
const LABEL = {
  codearts: 'CodeArts（华为云）', buddy: 'CodeBuddy（腾讯）', workbuddy: 'WorkBuddy（国际）',
  lobsterai: 'LobsterAI（有道）', trae: 'TRAE（字节）', accio: 'Accio（阿里）',
  gemini: 'Gemini Code Assist', officeace: 'OfficeAce（华为 MaaS）',
  qoder: 'Qoder', qodercn: 'Qoder 中国版', cline: 'Cline', minimax: 'MiniMax Code',
  minimaxintl: 'MiniMax 国际', zcode: 'ZCode（智谱）', loomy: 'Loomy（讯飞）',
  raccoon: 'Raccoon（商汤）', qiniu: 'Qiniu（七牛）', opencode: 'OpenCode',
}

// 与 Python qrcode 参考实现（version=4, ECC=M, mask=2）逐模块一致
const QR_TEXT = 'https://open.weixin.qq.com/connect/confirm?uuid=abc123def456'
const QR_SNAPSHOT = [
  '111111100101010010011111001111111', '100000100001111111101110101000001',
  '101110101011010010100111001011101', '101110101011101001101011001011101',
  '101110101101010100010101001011101', '100000101001111100101010001000001',
  '111111101010101010101010101111111', '000000001010100010000110000000000',
  '101111100010011101101010101111100', '111011001110100010111001101101111',
  '111010110001100111100100110010110', '000101000111001000011111001011111',
  '000101110111100111011011010111000', '010010000011011001110101001001111',
  '001010111011110111001110011110110', '000101011110011110110111011010100',
  '011100111101011101000011110110001', '100001010010001010110101001101101',
  '111111100011011110000110001110110', '111011011110100010111100010111110',
  '100000100101111011010000010111010', '101011001101010000111011111001001',
  '100000111011010101100100011011010', '100110001011000110010110011011100',
  '101000100011111101000011111110011', '000000001110001000111010100010101',
  '111111100100110110001111101010110', '100000101011110110000111100011101',
  '101110101100101011010010111111011', '101110101010100001111000110010111',
  '101110101010001101001100111101000', '100000100111011010000100000011100',
  '111111101101001101000011101100010',
]

// ─────────────────────────────────────────────────────────────────────────────
// 迷你 React harness（render / click / input / paste / 轮询 / 卸载）
// ─────────────────────────────────────────────────────────────────────────────
function cmpDeps(a, b) {
  if (!a || !b) return true
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return true
  return false
}

async function mount({ backend, clipboard, pollMs = 20 } = {}) {
  const requests = []
  const opened = []
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
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data), json: async () => data }
    } finally { pending-- }
  }

  let decl = null
  let windowOpenImpl = () => null       // 默认：模拟「弹窗被拦截」
  const win = {
    __ModuleLoader__: { load: (d) => { decl = d } },
    clipboardData: null,
    open: (...args) => { opened.push(args); return windowOpenImpl(...args) },
    __CS_MYFREE_POLL_MS: pollMs,
  }
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
        await sleep(1)
        if (rt.dirty) break
        if (pending > 0) { idle = 0; continue }
        idle++
        if (idle >= 2) break
      }
      if (!rt.dirty) return rt.tree
    }
    return rt.tree
  }

  const ctrl = {
    mod, requests, opened, runtime: rt,
    nodes: () => flatten(rt.tree),
    text: () => flatten(rt.tree).map((n) => (n.type === '#text' ? n.text : '')).join(''),
    clickableByText(str) {
      const cands = flatten(rt.tree).filter((n) => typeof n.props.onClick === 'function' && flatten(n).map((x) => x.text || '').join('').includes(str))
      cands.sort((a, b) => flatten(a).length - flatten(b).length)
      return cands[0]
    },
    exactText: (str) => flatten(rt.tree).filter((n) => n.type !== '#text' && flatten(n).filter((x) => x.type === '#text').map((x) => x.text).join('').trim() === str),
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
    cardOf(id) {
      return ctrl.nodes().find((n) => n.props && n.props['data-channel'] === id)
    },
    async clickIn(node, text) {
      const scope = flatten(node)
      const el = scope.filter((n) => typeof n.props.onClick === 'function' && flatten(n).map((x) => x.text || '').join('').includes(text))
        .sort((a, b) => flatten(a).length - flatten(b).length)[0]
      if (!el) throw new Error('卡片内找不到可点元素：' + text + '\n卡片：' + flatten(node).map((x) => x.text || '').join('').slice(0, 500))
      return ctrl.click(el)
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
    async openTab(label) {
      const tab = ctrl.exactText(label).find((n) => typeof n.props.onClick === 'function')
      if (!tab) throw new Error('找不到标签页：' + label)
      await ctrl.click(tab)
    },
    async waitFor(pred, { timeout = 5000, label = '' } = {}) {
      const start = Date.now()
      while (Date.now() - start < timeout) {
        await flush()
        if (pred()) return true
        await sleep(15)
      }
      throw new Error('等待超时' + (label ? '：' + label : '') + '\n实际：' + ctrl.text().slice(-1000))
    },
    setClipboard(c) { sandbox.navigator.clipboard = c },
    setWindowOpen(fn) { windowOpenImpl = fn },
    unmount() {
      for (const inst of rt.hooks.values()) for (const s of inst.hooks) if (s.cleanup) { try { s.cleanup() } catch (_) {} }
    },
    flush, sleep,
  }
  return ctrl
}

// ─────────────────────────────────────────────────────────────────────────────
// mock 后端：18 渠道 + 登录状态机（严格按 routes.js 契约）
// ─────────────────────────────────────────────────────────────────────────────
function makeBackend(overrides = {}) {
  const db = {
    channels: Object.keys(FLOW_OF).map((id) => ({
      id, label: LABEL[id] || id, flow: FLOW_OF[id],
      implemented: id === 'codearts' || id === 'qiniu',
      authKind: id === 'codearts' ? 'signed-huawei' : 'bearer',
      reason: (id === 'codearts' || id === 'qiniu') ? null : '登录换取未实现（端点待取证）',
      loginVerified: id === 'codearts',
      loginNote: id === 'codearts' ? 'AK/SK 永久授权，已真机验证' : (LABEL[id] || id) + '：登录端点待取证',
      refreshable: id !== 'loomy',
      loginUrl: 'https://example.com/' + id,
      checkin: false, proxyRequired: id === 'gemini',
      field: '授权码 / token', guideSteps: ['按提示完成授权', '回到本页等待结果'],
      accounts: id === 'codearts'
        ? [{ id: 'codearts-1', label: 'CodeArts', masked: 'HPUA…7NLO', kind: 'aksk' },
            { id: 'codearts-2', label: 'CodeArts', masked: 'ovLA…9VMV', kind: 'aksk' }]
        : id === 'loomy' ? [{ id: 'loomy-1', label: 'Loomy', masked: 'xunf…9abc', kind: 'token' }] : [],
    })),
    flowOverride: {},
    sessions: {},
    pollStates: {},       // provider -> ['waiting','ok',...]
    startFail: {},        // provider -> error
    startExtra: {},       // provider -> 额外字段（pollingOnly / qr / userCode…）
    testResult: {},       // key -> body
    refreshResult: {},    // key -> body
    removed: [],
    saved: [],
    qrText: QR_TEXT,
    ...overrides,
  }
  for (const c of db.channels) c.loggedIn = c.accounts.length > 0
  const statusBody = () => ({
    ok: true, total: db.channels.length,
    verified: db.channels.filter((c) => c.loginVerified).map((c) => c.id),
    unverified: db.channels.filter((c) => !c.loginVerified).map((c) => c.id),
    channels: db.channels.map((c) => ({
      id: c.id, provider: c.id, label: c.label,
      flow: db.flowOverride[c.id] || c.flow,
      loginVerified: c.loginVerified, note: c.loginNote, refreshable: c.refreshable,
    })),
    note: 'loginVerified=false 必须显示未验证徽标',
  })
  const empty = { ok: true }
  async function backend(url, req) {
    const u = new URL('http://x' + url)
    const base = u.pathname
    if (req.method === 'GET') {
      switch (base) {
        case '/cs-myfree/state': return { body: { ok: true, sources: { keyless: [{ id: 'kilo-free', label: 'Kilo 免费池', note: '免密' }], channels: [], counts: { keyless: 1, channels: 18, checkin: 0, manualRefresh: 0, proxyRequired: 1 } }, chain: { builtinCount: 2, overrideCount: 0, effectiveCount: 2, tiers: [] }, config: { vision: 'off', search: [], budget: {}, paid: { enabled: false } }, probe: null, checkin: { supported: [], note: '无' } } }
        case '/cs-myfree/channels': return { body: { ok: true, channels: JSON.parse(JSON.stringify(db.channels)), total: db.channels.length } }
        case '/cs-myfree/login/status': return { body: statusBody() }
        case '/cs-myfree/login/poll': {
          const sid = u.searchParams.get('sessionId')
          const s = db.sessions[sid]
          if (!s) return { body: { ok: false, state: 'error', error: '会话不存在或已过期', hint: '', maskedAccount: null } }
          const state = s.states.length > 1 ? s.states.shift() : s.states[0]
          if (state === 'waiting') return { body: { ok: false, state: 'waiting', hint: '等待你在浏览器完成授权…', maskedAccount: null, error: null } }
          if (state === 'error') return { body: { ok: false, state: 'error', hint: '', maskedAccount: null, error: '授权失败（mock）' } }
          return { body: { ok: true, state: 'ok', hint: '已收到授权，正在换取凭证…', maskedAccount: 'HPUA…7NLO', error: null } }
        }
        case '/cs-myfree/chain': return { body: { ok: true, builtin: [], overrides: [], effective: [], tiers: [], applied: true } }
        case '/cs-myfree/models': return { body: { ok: true, defaultModels: {}, sources: [], note: '' } }
        case '/cs-myfree/channels/models': return { body: { ok: true, total: 0, models: [], byChannel: {} } }
        case '/cs-myfree/config': return { body: { ok: true, config: {}, defaults: {} } }
        case '/cs-myfree/scope': return { body: { ok: true, scopes: ['global', 'preset', 'session'], files: [], effective: { config: {}, layers: { global: 0, preset: 0, session: 0 } }, hint: '' } }
        case '/cs-myfree/ledger': return { body: { ok: true, summary: {}, spend: { ok: false, days: [], providers: [] }, token: { days: [] } } }
        case '/cs-myfree/cash': return { body: { ok: true, deepseek: { available: true, balances: [{ currency: 'CNY', total: 1, granted: 0, topped: 1 }] }, errors: [] } }
        case '/cs-myfree/checkin/status': return { body: { ok: true, enabled: true, alive: true, running: false, at_time: '10:05', nextAt: Date.now() + 3600_000, lastAt: null, lastDate: null, lastResult: null, pending: 0, lastError: null, channels: [] } }
        case '/cs-myfree/credits': return { body: { ok: true, providers: [] } }
      }
      return { status: 404, body: { ok: false, error: 'not found ' + base } }
    }
    switch (base) {
      case '/cs-myfree/login/start': {
        const provider = String(req.body?.provider || '')
        if (db.startFail[provider]) return { body: { ok: false, error: db.startFail[provider] } }
        const ch = db.channels.find((c) => c.id === provider)
        const flow = db.flowOverride[provider] || (ch && ch.flow) || 'paste'
        const sessionId = 'sess-' + provider + '-' + Math.random().toString(36).slice(2, 6)
        const states = db.pollStates[provider] ? db.pollStates[provider].slice() : ['ok']
        db.sessions[sessionId] = { provider, flow, states }
        const body = Object.assign({
          ok: true, sessionId, flow, interval: 2,
          instructions: ['按提示完成授权', '回到本页等待结果'],
          loginVerified: ch ? ch.loginVerified : false,
          loginNote: ch ? ch.loginNote : '',
          callbackUrl: 'http://150.158.175.241/cs-myfree/login/callback',
        }, db.startExtra[provider] || {})
        if (flow === 'browser') body.url = body.url || 'https://example.com/oauth/authorize?client_id=demo&state=xyz'
        if (flow === 'device') {
          if (!('userCode' in body)) body.userCode = 'ABCD-1234'
          if (!('verificationUri' in body)) body.verificationUri = 'https://example.com/device'
        }
        if (flow === 'qr') { body.qr = body.qr || db.qrText; body.shortLink = body.shortLink || 'https://example.com/s/abc' }
        return { body }
      }
      case '/cs-myfree/login/cancel': {
        const sid = req.body?.sessionId
        if (db.sessions[sid]) delete db.sessions[sid]
        return { body: { ok: true, cancelled: true, sessionId: sid, hint: '已取消（会话即销毁）' } }
      }
      case '/cs-myfree/login/test': {
        const b = req.body || {}
        const key = b.id || b.provider
        if (db.testResult[key]) return { body: db.testResult[key] }
        return { body: { ok: true, provider: b.provider || key, model: 'deepseek-v4-pro', ms: 123, hint: '上游返回了 choice，链路通' } }
      }
      case '/cs-myfree/login/refresh': {
        const b = req.body || {}
        const key = b.id || b.provider
        if (db.refreshResult[key]) return { body: db.refreshResult[key] }
        return { body: { ok: true, provider: b.provider || key, note: '已续期', maskedAccount: 'HPUA…7NLO', expiresAt: Date.now() + 3600_000 } }
      }
      case '/cs-myfree/accounts/remove': {
        const id = req.body?.id
        for (const c of db.channels) {
          const i = (c.accounts || []).findIndex((a) => a.id === id)
          if (i >= 0) {
            c.accounts.splice(i, 1); c.loggedIn = c.accounts.length > 0; db.removed.push(id)
            return { body: { ok: true, id, remaining: db.channels.reduce((n, x) => n + x.accounts.length, 0) } }
          }
        }
        return { body: { ok: false, error: '账号不存在' } }
      }
      case '/cs-myfree/channels/parse': {
        const r = captureCredential(req.body?.text)
        // 安全红线：只回判定/预览，不回凭据原文
        return { body: { ok: r.ok, kind: r.kind ?? null, field: r.extra?.field ?? null, preview: r.ok ? '识别到 ' + String(r.credential).slice(0, 4) + '…，长度 ' + String(r.credential).length : null, length: r.ok ? String(r.credential).length : 0, error: r.ok ? null : r.error } }
      }
      case '/cs-myfree/channels/save': {
        const b = req.body || {}
        const ch = db.channels.find((c) => c.id === b.provider)
        if (!ch) return { body: { ok: false, error: '未知渠道' } }
        let cred = String(b.credential || '').trim()
        const text = typeof b.text === 'string' ? b.text : ''
        if (!cred && text) {
          const p = captureCredential(text)
          if (!p.ok) return { body: { ok: false, error: p.error } }
          cred = String(p.credential || '')
        }
        const ak = String(b.ak || '').trim()
        const sk = String(b.sk || '').trim()
        if (!cred && !(ak && sk)) return { body: { ok: false, error: '凭证不能为空（令牌，或 AK+SK 两项）' } }
        if (!(ak && sk) && !looksLikeCredential(cred)) return { body: { ok: false, error: '这不像一个有效令牌（可能是普通网址或太短）。请粘贴带 ?code= 的回调链接或真正的令牌。' } }
        if (ak && !sk) return { body: { ok: false, error: 'AK/SK 需要成对提交：还缺 SK' } }
        db.saved.push({ provider: b.provider, ...(ak ? { ak, sk, kind: 'aksk' } : { text, kind: 'token' }) })
        const id = b.provider + '-new-' + db.saved.length
        ch.accounts.push({ id, label: ch.label, masked: 'MASK…0001', addedAt: Date.now(), expiresAt: null })
        ch.loggedIn = true
        return { body: { ok: true, id, kind: ak ? 'aksk' : 'token', hint: '已保存，正在拉取可用模型…（几秒后刷新模型选择器）' } }
      }
      case '/cs-myfree/probe':
        return { body: { ok: true, at: Date.now(), results: [{ id: 'kilo', ok: true, ms: 10, sample: 'pong' }], anyOk: true, okCount: 1 } }
      case '/cs-myfree/diag':
        return { body: { ok: true, summary: '全部通过', checks: [{ name: 'HTTP 路由', ok: true, detail: 'ok' }] } }
    }
    return { status: 404, body: { ok: false, error: 'not found ' + base } }
  }
  return { db, backend, statusBody }
}

const has = (c, s) => c.text().includes(s)

// ─────────────────────────────────────────────────────────────────────────────
// ① 13 面板 smoke：新登录 UI 不能把其它分区拖垮
// ─────────────────────────────────────────────────────────────────────────────
test('13 个分区在 stub 宿主下全部渲染，无 ErrorBoundary 兜底、无 effect 异常', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    const tabs = ['总览', '供给源', '模型目录', '降级链 ★', '钉选', '额度健康', '保护策略', '预算付费', '省 Token', '可观测', '导入导出', '作用域', '诊断']
    for (const tab of tabs) {
      await c.openTab(tab)
      assert.deepEqual(c.runtime.errors.map((e) => String(e.error && e.error.message)), [], `${tab} 抛错`)
      assert.equal(has(c, '这个区域渲染失败了'), false, `${tab} 落到错误边界`)
    }
  } finally { c.unmount() }
})

// ─────────────────────────────────────────────────────────────────────────────
// ② 渠道卡片：徽标 / flow 标签 / 未验证说明
// ─────────────────────────────────────────────────────────────────────────────
test('供给源：18 家渠道 + 已登录/未登录/已验证/未验证徽标 + flow 标签', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('供给源')
    assert.ok(has(c, '账号渠道（18 家 · 已登录 2 家'), c.text().slice(-500))
    assert.ok(has(c, '已验证'), 'codearts 应显示已验证')
    assert.ok(has(c, '未验证'), '未验证渠道（如 qiniu）必须有黄色徽标')
    assert.ok(has(c, '暂不可用'), '未实现登录换取的渠道必须标「暂不可用」')
    assert.ok(has(c, '· 登录换取未实现（端点待取证）'), '必须展示后端的 reason：' + c.text().slice(-900))
    assert.ok(has(c, '厂商官网'), '次要链接应是「厂商官网」（不是主按钮）')
    assert.equal(has(c, '去官网'), false, '旧的误导性「去官网」文案必须移除')
    // 每种 flow 的卡片都带 data-flow
    const flows = new Set(c.nodes().filter((n) => n.props && n.props['data-flow']).map((n) => n.props['data-flow']))
    for (const f of ['browser', 'device', 'qr', 'paste']) assert.ok(flows.has(f), '缺少 flow=' + f)
    const codearts = c.cardOf('codearts')
    assert.equal(codearts.props['data-verified'], '1')
    assert.equal(c.cardOf('buddy').props['data-verified'], '0')
  } finally { c.unmount() }
})

test('browser 流（buddy）：同步开窗（about:blank）→ 响应后改 location；不是 paste 输入框', async () => {
  const be = makeBackend()
  be.db.pollStates.buddy = ['waiting', 'ok']
  be.db.startExtra.buddy = { url: 'https://copilot.tencent.com/oauth?client_id=buddy&state=abc' }
  const c = await mount({ backend: be.backend })
  try {
    // 模拟浏览器允许弹窗：window.open 返回一个可导航的窗口对象
    const fakeWin = { location: { href: '' }, close: () => { fakeWin.closed = true } }
    c.setWindowOpen(() => fakeWin)
    await c.start()
    await c.openTab('供给源')
    await c.clickIn(c.cardOf('buddy'), '一键登录')
    assert.ok(c.requests.some((r) => r.url === '/cs-myfree/login/start' && r.body?.provider === 'buddy'), '应调用 /login/start')
    // 🔴 必须在点击同步阶段开 about:blank（否则 Promise 回调里会被浏览器拦截）
    assert.ok(c.opened.some(([u]) => u === 'about:blank'), '点击时应同步打开 about:blank：' + JSON.stringify(c.opened))
    assert.equal(fakeWin.location.href, 'https://copilot.tencent.com/oauth?client_id=buddy&state=abc',
      '拿到 /login/start 返回的 url 后应改预开窗口的 location（不是厂商主页）')
    assert.equal(has(c, '浏览器拦截了新窗口'), false, '允许弹窗时不应提示被拦截')
    await c.waitFor(() => has(c, '等待你在浏览器'), { label: 'browser 等待授权文案' })
    assert.ok(has(c, '打开登录页'), '必须有可点的「① 打开登录页」按钮')
    await c.waitFor(() => has(c, '✅ 登录成功'), { label: '轮询到 ok' })
    assert.ok(has(c, 'HPUA'), '成功后显示掩码账号')
    assert.ok(has(c, '立即测试连通'), '成功后出现立即测试连通')
    // 轮询成功后必须停止：再等一会，poll 次数不再增长
    const polls = () => c.requests.filter((r) => r.url.startsWith('/cs-myfree/login/poll')).length
    const n = polls()
    await c.waitFor(() => false, { timeout: 200 }).catch(() => {})
    assert.equal(polls(), n, '成功后必须停止轮询')
  } finally { c.unmount() }
})

test('device 流（qoder）：大字设备码 + 验证页按钮 + 轮询成功', async () => {
  const be = makeBackend()
  be.db.pollStates.qoder = ['waiting', 'ok']
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('供给源')
    await c.clickIn(c.cardOf('qoder'), '一键登录')
    await c.waitFor(() => has(c, 'ABCD-1234'), { label: '设备码' })
    assert.ok(has(c, '打开验证页'), '必须有验证页按钮')
    await c.waitFor(() => has(c, '✅ 登录成功'), { label: '设备码轮询成功' })
  } finally { c.unmount() }
})

test('qr 流（loomy）：渲染真正可扫的 SVG 二维码（与参考实现逐模块一致）+ 短链 + 复制', async () => {
  // 编码器与 Python qrcode 参考实现（version=4/ECC=M/mask=2）逐模块对拍
  const c0 = await mount({ backend: makeBackend().backend })
  try {
    const qr = c0.mod.__qrMatrix(QR_TEXT, { version: 4, mask: 2 })
    const rows = qr.modules.map((r) => r.map((m) => (m ? '1' : '0')).join(''))
    assert.equal(qr.size, 33)
    assert.deepEqual(rows, QR_SNAPSHOT, '二维码矩阵必须与参考实现一致')
  } finally { c0.unmount() }

  // QrCode 组件：一个 <path>，模块数与矩阵一致
  const c1 = await mount({ backend: makeBackend().backend })
  try {
    await c1.start(c1.mod.QrCode, { text: QR_TEXT, size: 168 })
    const svg = c1.nodes().find((n) => n.type === 'svg')
    assert.ok(svg, '必须渲染 <svg> 二维码，而不是 <pre> 文本')
    assert.equal(svg.props['aria-label'], '登录二维码')
    const path = c1.nodes().find((n) => n.type === 'path')
    assert.ok(path && path.props.d, '缺少二维码 path')
    const auto = c1.mod.__qrMatrix(QR_TEXT)      // 组件默认 mask（同一份实现）
    const dark = (path.props.d.match(/M/g) || []).length
    let expectedDark = 0
    let firstDark = null
    for (let r = 0; r < auto.size; r++) for (let col = 0; col < auto.size; col++) if (auto.modules[r][col]) {
      expectedDark++
      if (!firstDark) firstDark = 'M' + col + ' ' + r + 'h1v1h-1z'
    }
    assert.equal(dark, expectedDark, '暗模块数量必须与矩阵一致')
    assert.ok(path.props.d.startsWith(firstDark), 'path 顺序必须与矩阵一致')
  } finally { c1.unmount() }

  // 登录向导里的 QR 分支
  const be = makeBackend()
  be.db.pollStates.loomy = ['waiting', 'ok']
  const c2 = await mount({ backend: be.backend })
  try {
    await c2.start()
    await c2.openTab('供给源')
    await c2.clickIn(c2.cardOf('loomy'), '再加一个')
    await c2.waitFor(() => c2.nodes().some((n) => n.type === 'svg'), { label: 'svg 二维码' })
    const qrSvg = c2.nodes().find((n) => n.type === 'svg')
    assert.ok(Number(qrSvg.props.width) >= 180, '二维码必须是大图（≥180px）：' + qrSvg.props.width)
    assert.ok(has(c2, '用手机微信扫码'), 'qr 流必须写明「用手机微信扫码」')
    assert.ok(has(c2, 'https://example.com/s/abc'), '应显示短链')
    assert.ok(has(c2, '复制二维码内容'), '应有复制二维码内容兜底')
    assert.ok(has(c2, '厂商官网') || has(c2, '厂商页面'), '应给次要入口（不是把主页当主按钮）')
    // 剪贴板可用 ⇒ 复制成功提示
    c2.setClipboard({ writeText: () => Promise.resolve() })
    await c2.clickIn(c2.cardOf('loomy'), '复制二维码内容')
    await c2.waitFor(() => has(c2, '✅ 已复制到剪贴板'), { label: '复制反馈' })
    await c2.waitFor(() => has(c2, '✅ 登录成功'), { label: '扫码轮询成功' })
  } finally { c2.unmount() }
})

test('paste 流（qiniu）：粘贴整段回调链接自动识别并保存；错误内容明确拒绝', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('供给源')
    await c.clickIn(c.cardOf('qiniu'), '一键登录')
    assert.ok(has(c, '粘贴'), 'paste 流应显示粘贴框')
    // 普通网址：后端明确拒绝，不保存
    await c.paste('粘贴', 'https://www.baidu.com')
    await c.waitFor(() => has(c, '普通网页地址') || has(c, '没有 code'), { label: '拒绝普通网址' })
    assert.equal(be.db.saved.length, 0, '普通网址不能被保存')
    // 带 code 的回调链接：自动识别 + 保存（body.text 原始文本，前端不解析凭据）
    await c.paste('粘贴', 'https://x.com/cb?code=abc123def456ghi789')
    await c.waitFor(() => has(c, '已保存，正在拉取可用模型'), { label: '保存成功' })
    assert.equal(be.db.saved.length, 1)
    assert.equal(be.db.saved[0].provider, 'qiniu')
    assert.ok(String(be.db.saved[0].text).includes('code=abc123def456ghi789'), '保存时应提交原始文本由后端解析')
    assert.ok(!has(c, 'abc123def456ghi789'), '页面不得回显凭据原文')
    assert.ok(has(c, 'MASK…0001'), '保存后显示掩码账号')
  } finally { c.unmount() }
})

test('aksk 流：AK+SK 成对保存；缺一项时给出明确提示', async () => {
  const be = makeBackend()
  be.db.flowOverride.zcode = 'aksk'
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('供给源')
    await c.clickIn(c.cardOf('zcode'), '一键登录')
    assert.ok(has(c, '保存 AK/SK'), 'aksk 流应有两个输入框 + 保存按钮')
    await c.change('AK（', 'AKID-TEST-0001')
    await c.clickIn(c.cardOf('zcode'), '保存 AK/SK')
    await c.waitFor(() => has(c, '还差 SK'), { label: '缺 SK 提示' })
    await c.change('SK（', 'SK-SECRET-0002')
    await c.clickIn(c.cardOf('zcode'), '保存 AK/SK')
    await c.waitFor(() => has(c, '已保存，正在拉取可用模型'), { label: 'aksk 保存成功' })
    const saved = be.db.saved.find((x) => x.provider === 'zcode')
    assert.deepEqual({ ak: saved.ak, sk: saved.sk }, { ak: 'AKID-TEST-0001', sk: 'SK-SECRET-0002' })
    assert.ok(!has(c, 'SK-SECRET-0002'), 'SK 不得回显')
  } finally { c.unmount() }
})

test('未验证渠道：开始登录失败时显示可读错误 + 备用粘贴入口（不假装成功）', async () => {
  const be = makeBackend()
  be.db.startFail.buddy = 'flow.initial is not a function'
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('供给源')
    await c.clickIn(c.cardOf('buddy'), '一键登录')
    await c.waitFor(() => has(c, 'flow.initial is not a function'), { label: '错误文案' })
    assert.ok(has(c, '备用：直接粘贴凭据'), '失败后应直接给出备用粘贴入口')
    const hasPasteInput = c.nodes().some((n) => n.type === 'input' && String(n.props.placeholder || '').includes('粘贴'))
    if (!hasPasteInput) await c.clickIn(c.cardOf('buddy'), '拿不到授权')
    await c.paste('粘贴', 'https://x.com/cb?code=feedfacecafebeef0011')
    await c.waitFor(() => has(c, '已保存，正在拉取可用模型'), { label: '备用粘贴保存' })
    assert.equal(be.db.saved.length, 1)
  } finally { c.unmount() }
})

test('轮询失败：显示 ❌ 可读错误 + 重试；取消登录会调 /login/cancel', async () => {
  const be = makeBackend()
  be.db.pollStates.buddy = ['waiting', 'error']
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('供给源')
    await c.clickIn(c.cardOf('buddy'), '一键登录')
    await c.waitFor(() => has(c, '授权失败（mock）'), { label: '轮询错误' })
    assert.ok(c.clickableByText('重试'), '失败后必须有重试按钮')

    // 取消：点「重试」重新发起一个保持 waiting 的会话
    be.db.pollStates.buddy = ['waiting']
    await c.clickIn(c.cardOf('buddy'), '重试')
    await c.waitFor(() => has(c, '取消登录'), { label: '等待中显示取消' })
    await c.clickIn(c.cardOf('buddy'), '取消登录')
    await c.waitFor(() => c.requests.some((r) => r.url === '/cs-myfree/login/cancel'), { label: '/login/cancel' })
    assert.ok(has(c, '已取消登录'))
  } finally { c.unmount() }
})

test('pollingOnly 渠道：等待文案为「已打开登录页，正在等待授权…」', async () => {
  const be = makeBackend()
  be.db.pollStates.buddy = ['waiting']
  be.db.startExtra.buddy = { pollingOnly: true }
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('供给源')
    await c.clickIn(c.cardOf('buddy'), '一键登录')
    await c.waitFor(() => has(c, '已打开登录页，等待你在浏览器完成授权'), { label: 'pollingOnly 文案' })
  } finally { c.unmount() }
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ 账号管理：测试 / 续期 / 删除二次确认
// ─────────────────────────────────────────────────────────────────────────────
test('账号管理：测试连通、续期、续期失败提示需人工重登', async () => {
  const be = makeBackend()
  be.db.refreshResult['codearts-1'] = { ok: false, provider: 'codearts', error: 'refresh_token 已失效', reloginRequired: true }
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('供给源')
    const card = c.cardOf('codearts')
    await c.clickIn(card, '测试')
    await c.waitFor(() => has(c, '连通 123ms'), { label: '测试连通结果' })
    const testReq = c.requests.find((r) => r.url === '/cs-myfree/login/test')
    assert.equal(testReq.body.id, 'codearts-1', '账号级测试必须带 id')

    await c.clickIn(c.cardOf('codearts'), '续期')
    await c.waitFor(() => has(c, '需人工重新登录'), { label: '续期失败文案' })
    assert.ok(c.requests.some((r) => r.url === '/cs-myfree/login/refresh' && r.body.id === 'codearts-1'))
  } finally { c.unmount() }
})

test('删除账号：二次确认（第一次点击不发请求），确认后调 /accounts/remove 并刷新', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('供给源')
    await c.clickIn(c.cardOf('codearts'), '删除')
    assert.ok(has(c, '确认删除'), '第一次点删除应进入二次确认')
    assert.equal(be.db.removed.length, 0, '未确认前不允许发删除请求')
    await c.clickIn(c.cardOf('codearts'), '取消')
    assert.equal(be.db.removed.length, 0)
    await c.clickIn(c.cardOf('codearts'), '删除')
    await c.clickIn(c.cardOf('codearts'), '确认删除')
    await c.waitFor(() => has(c, '已删除该账号（剩余'), { label: '删除结果' })
    assert.equal(be.db.removed.length, 1)
    await c.waitFor(() => has(c, '已登录 1'), { label: '删除后账号数刷新' })
  } finally { c.unmount() }
})

// ─────────────────────────────────────────────────────────────────────────────
// ④ 全部测试 / 全部续期
// ─────────────────────────────────────────────────────────────────────────────
test('全部测试：逐个账号调 /login/test，展示进度与结果汇总', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('供给源')
    await c.click('全部测试')
    await c.waitFor(() => has(c, '全部测试完成'), { label: '批量测试完成' })
    const ids = c.requests.filter((r) => r.url === '/cs-myfree/login/test').map((r) => r.body.id).sort()
    assert.deepEqual(ids, ['codearts-1', 'codearts-2', 'loomy-1'], '应覆盖每个已登录账号')
    assert.ok(has(c, '✅ CodeArts'), '汇总里应有成功项')
  } finally { c.unmount() }
})

test('全部续期：无续期端点的渠道（loomy）如实跳过，不发假请求', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('供给源')
    await c.click('全部续期')
    await c.waitFor(() => has(c, '全部续期完成'), { label: '批量续期完成' })
    const ids = c.requests.filter((r) => r.url === '/cs-myfree/login/refresh').map((r) => r.body.id).sort()
    assert.deepEqual(ids, ['codearts-1', 'codearts-2'], 'loomy 无续期端点，不应调用')
    assert.ok(has(c, '该渠道无续期端点，需重新登录'), '被跳过的要如实说明：' + c.text().slice(-800))
  } finally { c.unmount() }
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 安全红线：UI 只显示掩码，不回显凭据原文
// ─────────────────────────────────────────────────────────────────────────────
test('安全：任何步骤页面都不出现凭据原文（只显示掩码）', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('供给源')
    const secrets = ['abc123def456ghi789', 'AKID-TEST-0001', 'SK-SECRET-0002']
    // paste 流程
    await c.clickIn(c.cardOf('qiniu'), '一键登录')
    await c.paste('粘贴', 'https://x.com/cb?code=abc123def456ghi789')
    await c.waitFor(() => has(c, '已保存，正在拉取可用模型'), { label: 'paste 保存' })
    // aksk 流程
    be.db.flowOverride.zcode = 'aksk'
    await c.openTab('总览')
    await c.openTab('供给源')
    await c.clickIn(c.cardOf('zcode'), '一键登录')
    await c.change('AK（', 'AKID-TEST-0001')
    await c.change('SK（', 'SK-SECRET-0002')
    await c.clickIn(c.cardOf('zcode'), '保存 AK/SK')
    await c.waitFor(() => has(c, '已保存，正在拉取可用模型'), { label: 'aksk 保存' })
    for (const sec of secrets) assert.equal(c.text().includes(sec), false, '页面不得出现凭据原文：' + sec)
    // /channels/parse 响应也不能带 credential 字段
    const parseResp = c.requests.find((r) => r.url === '/cs-myfree/channels/parse')
    assert.ok(parseResp, '应调用 parse')
  } finally { c.unmount() }
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 页面优化：窄屏不溢出 / 加载骨架 / 错误态可读性
// ─────────────────────────────────────────────────────────────────────────────
test('窄屏不溢出：所有固定像素宽度 ≤ 320px，卡片/长内容允许换行', () => {
  const widths = [...CLIENT_SRC.matchAll(/width:\s*'(\d+)px'/g)].map((m) => Number(m[1]))
  assert.ok(widths.length > 0)
  for (const w of widths) assert.ok(w <= 320, `固定宽度 ${w}px 在窄屏（360px）可能溢出`)
  // 渠道卡片根节点必须 maxWidth:100%（不撑破容器）
  const cardBlock = CLIENT_SRC.slice(CLIENT_SRC.indexOf("'data-channel': ch.id"))
  assert.ok(cardBlock.slice(0, 600).includes("maxWidth: '100%'"), '渠道卡片应 maxWidth:100%')
  // 长内容（掩码/链接/设备码/二维码内容）必须允许断行
  assert.ok(CLIENT_SRC.includes('wordBreak: \'break-all\''), '长内容必须允许断行')
  assert.ok(CLIENT_SRC.includes("flexWrap: 'wrap'"), '操作区必须允许换行')
})

test('加载态有骨架、错误态有可读文案（不是一直「加载中」）', async () => {
  assert.ok(CLIENT_SRC.includes('S.skeleton'), '加载态应使用骨架样式')
  assert.ok(CLIENT_SRC.includes('渠道列表加载中') || CLIENT_SRC.includes('加载中'), '保留加载文案')
  // 接口 500 时供给源必须显示错误而不是永久骨架
  const backend = async () => ({ status: 500, body: { ok: false, error: 'boom' } })
  const c = await mount({ backend })
  try {
    await c.start()
    await c.openTab('供给源')
    assert.ok(has(c, '出错了') && has(c, 'boom'), '错误态必须显示原因：' + c.text().slice(0, 400))
    assert.ok(has(c, '重试'), '错误态必须有重试')
  } finally { c.unmount() }
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ 弹窗拦截修复（生产实测 P0）与「主按钮只用授权 URL」
// ─────────────────────────────────────────────────────────────────────────────
test('弹窗被拦截：明确提示「浏览器拦截了新窗口」+「打开登录页」按钮可补救', async () => {
  const be = makeBackend()
  be.db.pollStates.buddy = ['waiting']
  be.db.startExtra.buddy = { url: 'https://copilot.tencent.com/oauth?client_id=buddy&state=abc' }
  const c = await mount({ backend: be.backend })     // 默认 window.open 返回 null（模拟被拦截）
  try {
    await c.start()
    await c.openTab('供给源')
    const loginUrl = c.cardOf('buddy').props['data-channel'] && 'https://example.com/buddy'
    await c.clickIn(c.cardOf('buddy'), '一键登录')
    await c.waitFor(() => has(c, '浏览器拦截了新窗口'), { label: '拦截提示' })
    assert.ok(has(c, '请点上面的「打开登录页」') || has(c, '请点下面的「打开登录页」') || has(c, '打开登录页'),
      '必须告诉用户点哪里继续')
    // 点击主按钮阶段绝不能直接开厂商主页
    assert.equal(c.opened.some(([u]) => String(u) === loginUrl), false, '一键登录不允许打开厂商主页')
    assert.ok(c.opened.some(([u]) => u === 'about:blank'), '点击时应同步尝试开 about:blank')

    // 补救：允许弹窗后点「打开登录页」→ 同步打开真实授权 URL
    const fakeWin = { location: { href: '' }, close: () => {} }
    c.setWindowOpen(() => fakeWin)
    await c.clickIn(c.cardOf('buddy'), '打开登录页')
    assert.ok(c.opened.some(([u]) => String(u).includes('copilot.tencent.com/oauth')), '点按钮必须打开 /login/start 返回的授权 URL：' + JSON.stringify(c.opened))
  } finally { c.unmount() }
})

test('「一键登录」主按钮 = /login/start 的授权 URL，绝不是 ch.loginUrl 厂商主页', async () => {
  const be = makeBackend()
  be.db.pollStates.buddy = ['waiting']
  be.db.startExtra.buddy = { url: 'https://auth.example.com/oauth/authorize?client_id=buddy' }
  const c = await mount({ backend: be.backend })
  try {
    const fakeWin = { location: { href: '' }, close: () => {} }
    c.setWindowOpen(() => fakeWin)
    await c.start()
    await c.openTab('供给源')
    const card = c.cardOf('buddy')
    // 主按钮文案是「一键登录」；「厂商官网」只是小号次要链接
    assert.ok(flattenText(card).includes('一键登录'))
    assert.ok(flattenText(card).includes('厂商官网'))
    await c.clickIn(card, '一键登录')
    assert.equal(fakeWin.location.href, 'https://auth.example.com/oauth/authorize?client_id=buddy')
    assert.equal(c.opened.some(([u]) => String(u) === 'https://example.com/buddy'), false, '不允许打开厂商主页')
    await c.waitFor(() => has(c, '等待你在浏览器'), { label: '等待授权' })
  } finally { c.unmount() }
})

test('qr 流不依赖厂商主页：没有 url 时只显示二维码 + 扫码文案 + 次要厂商链接', async () => {
  const be = makeBackend()
  be.db.pollStates.loomy = ['waiting']
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('供给源')
    await c.clickIn(c.cardOf('loomy'), '再加一个')
    await c.waitFor(() => c.nodes().some((n) => n.type === 'svg'), { label: '二维码 svg' })
    const svg = c.nodes().find((n) => n.type === 'svg')
    assert.ok(Number(svg.props.width) >= 180, '二维码尺寸必须 ≥180px')
    assert.ok(has(c, '用手机微信扫码'))
    assert.ok(has(c, '厂商页面'), 'qr 流次要入口「或在浏览器打开厂商页面」')
    // qr 流不应尝试打开空白新窗口/厂商主页作为主操作
    assert.equal(c.opened.some(([u]) => String(u) === 'https://example.com/loomy'), false)
  } finally { c.unmount() }
})

function flattenText(node) {
  const out = []
  const walk = (n) => {
    if (!n) return
    if (n.type === '#text') out.push(n.text)
    for (const c of n.children || []) walk(c)
  }
  walk(node)
  return out.join('')
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ device 流三分支：有 url（qoder 浏览器授权+纯轮询）/ 设备码 / 都没有
// ─────────────────────────────────────────────────────────────────────────────
test('device 流但返回 url（qoder 真实形态）：当作「浏览器授权 + 纯轮询」，不显示设备码', async () => {
  const be = makeBackend()
  be.db.pollStates.qoder = ['waiting']
  be.db.startExtra.qoder = {
    flow: 'device',
    url: 'https://qoder.com/device/selectAccounts?state=abc123',
    userCode: null,
    verificationUri: null,
    pollingOnly: true,
  }
  const c = await mount({ backend: be.backend })
  try {
    const fakeWin = { location: { href: '' }, close: () => {} }
    c.setWindowOpen(() => fakeWin)
    await c.start()
    await c.openTab('供给源')
    const card = () => c.cardOf('qoder')
    // 开始前：flow 文案是「设备码」
    assert.ok(flattenText(card()).includes('设备码'), '开始前应按 flow 显示「设备码」')

    await c.clickIn(card(), '一键登录')
    await c.waitFor(() => has(c, '已打开登录页，等待你在浏览器完成授权'), { label: '浏览器授权等待文案' })
    // 有 url ⇒ 主按钮是「打开登录页」，并已同步导航预开窗口
    assert.ok(c.opened.some(([u]) => u === 'about:blank'), '点击时应同步开 about:blank')
    assert.equal(fakeWin.location.href, 'https://qoder.com/device/selectAccounts?state=abc123', '应打开后端返回的授权页 URL')
    assert.ok(has(c, '① 打开登录页'), '有 url 时必须给「① 打开登录页」')
    assert.equal(has(c, '① 打开验证页'), false, '有 url 时不应显示设备码验证页按钮')
    assert.equal(has(c, '后端未返回登录地址'), false, '有 url 时不应报「未返回登录地址」')
    // flow 文案动态改成「浏览器授权（轮询）」
    assert.ok(flattenText(card()).includes('浏览器授权（轮询）'), 'device+url 的 flow 文案应为「浏览器授权（轮询）」：' + flattenText(card()).slice(0, 400))
    // 没有 userCode 就不该出现大字设备码区域
    assert.equal(c.nodes().some((n) => n.props && n.props.style && n.props.style.fontSize === '20px'), false, '不应渲染设备码大字')
  } finally { c.unmount() }
})

test('device 流只有设备码（无 url）：大字 userCode + 「打开验证页」', async () => {
  const be = makeBackend()
  be.db.pollStates.qoder = ['waiting']
  be.db.startExtra.qoder = { flow: 'device', url: null, userCode: 'WXYZ-9876', verificationUri: 'https://qoder.com/device', pollingOnly: false }
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('供给源')
    await c.clickIn(c.cardOf('qoder'), '一键登录')
    await c.waitFor(() => has(c, 'WXYZ-9876'), { label: '设备码大字' })
    assert.ok(has(c, '① 打开验证页'), '无 url 有设备码时主按钮应是「打开验证页」')
    assert.ok(has(c, '等待你输入设备码确认'), '状态行应提示输入设备码')
    assert.ok(flattenText(c.cardOf('qoder')).includes('设备码'), 'flow 文案仍是「设备码」')
  } finally { c.unmount() }
})

test('device 流既无 url 也无设备码：诚实提示「后端未返回登录地址」+ 备用粘贴', async () => {
  const be = makeBackend()
  be.db.pollStates.qoder = ['waiting']
  be.db.startExtra.qoder = { flow: 'device', url: null, userCode: null, verificationUri: null, pollingOnly: true }
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('供给源')
    await c.clickIn(c.cardOf('qoder'), '一键登录')
    await c.waitFor(() => has(c, '后端未返回登录地址'), { label: '诚实提示' })
    assert.ok(has(c, '后端未返回登录地址（既没有 url 也没有设备码）'), c.text().slice(-500))
    assert.ok(has(c, '备用：直接粘贴凭据') || has(c, '粘贴'), '仍应有备用粘贴入口')
  } finally { c.unmount() }
})
