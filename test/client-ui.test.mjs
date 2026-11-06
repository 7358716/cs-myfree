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
 * 覆盖 14 面板（W13+W0-W12）渲染/字段/空态/错误态/回调注册，以及 8 条真人流程。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { validateOverrides, mergeChain, chainSummary } from '../src/adapter/chain-overrides.js'
import { captureCredential, looksLikeCredential } from '../src/pools/channels/capture.js'
import { applyPatch } from '../src/web/settings.js'

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
    // 契约 A/B：切换成功计量 + 复杂路由基本规则（后端 buildRoutingRules 的真实形状）
    routing: {
      gate: {
        codearts: { active: 1, limit: 2, ratio: 0.5, coolingMs: 0, streak429: 0, failRate: 0.1, failSamples: 10 },
        kilo: { active: 0, limit: 3, ratio: 0, coolingMs: 15000, streak429: 2, failRate: 0.5, failSamples: 4 },
      },
      switches: {
        at: 1793690401174,
        total: 4,
        byProvider: { kilo: 4 },
        byModel: { 'kilo/kilo-auto/free': 4 },
        attempts: { total: 6, byProvider: { kilo: 5, ovh: 1 } },
        switchSuccessRate: 0.6667,
        last: { at: 1793690401000, from: 'ovh', to: 'kilo' },
      },
      rules: {
        policy: 'free-first',
        policyOptions: [
          { id: 'free-first', label: '免费优先', desc: '先试免密源，再试付费渠道', active: true, evidence: '实测免密源成功率更高' },
          { id: 'balanced', label: '均衡', desc: '按拥挤度与失败率均衡打分' },
          { id: 'reliability-first', label: '稳定优先', desc: '优先历史成功率高的渠道' },
        ],
        order: ['impl', 'free', 'load', 'fail'],
        orderHuman: '先过严格过滤层，再过免费过滤层，然后比拥挤度，最后比失败率。',
        weights: { load: 0.6, fail: 0.4 },
        filters: [
          { id: 'impl', position: 1, label: '渠道已实现', strict: true, effect: '未实现的渠道直接剔除（空集也不放宽）' },
          { id: 'free', position: 2, label: '免费可见', strict: false, effect: '空集时放行付费渠道' },
        ],
        emptySetFallback: { note: '所有过滤都空时放开「免费可见」这一层', appliesTo: ['免费可见'], excludes: ['渠道已实现'] },
        cooldowns: { busyMs: 2000, rateMs: 60000, maxMs: 600000, note: '指数退避，封顶 10 分钟' },
        gate: {
          codearts: { active: 1, limit: 2, ratio: 0.5, coolingMs: 0, streak429: 0, failRate: 0.1, failSamples: 10 },
          // 冷却中的一家：验证「冷却中 Xs」+ 高亮（不只是冷冰冰一个秒数）
          kilo: { active: 0, limit: 3, ratio: 0, coolingMs: 15000, streak429: 2, failRate: 0.5, failSamples: 4 },
        },
        configurable: [
          { path: 'routing.priority', label: '优先策略', type: 'select', options: ['free-first', 'balanced', 'reliability-first'], value: 'free-first', source: 'default', effect: '决定排序时的权重偏向' },
          { path: 'routing.autoSwitch', label: '自动选路', type: 'bool', value: true, source: 'config', effect: '关掉后只按手动链逐个尝试' },
          { path: 'routing.cooldowns.rateMs', label: '被限流后冷却', type: 'number', unit: 'ms', value: 60000, source: 'default', effect: '命中 429 后等多久再试' },
          {
            path: 'sources.limits',
            paths: ['sources.limits.codearts', 'sources.limits.kilo'],
            label: '每家并发上限',
            type: 'number',
            value: { codearts: 2, kilo: 3 },
            source: 'config',
            effect: '同一家同时最多几个请求',
          },
        ],
      },
    },
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
      vision: { mode: 'off', consented: false, model: 'Qwen2.5-VL-72B-Instruct', cacheSize: 200, maxImagesPerTurn: 4, maxImageBytes: 5242880 },
      search: {
        enabled: true, sources: ['bing-rss', 'bing-html', 'sogou', 'mwmbl'],
        budgetMs: 15000, cacheTtlMs: 300000, ratePerMin: 20, maxResults: 8,
      },
      subagentRouting: { mode: 'auto', model: null, fallback: 'global' },
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
      providers: [
        {
          provider: 'kilo', calls: 6, in: 1200, out: 3400, failed: 0, costCNY: 0, switched: 2,
          models: {
            'kilo-auto/free': { model: 'kilo-auto/free', calls: 5, failed: 0, in: 1000, out: 3000, switched: 2 },
            'kilo-pro': { model: 'kilo-pro', calls: 1, failed: 0, in: 200, out: 400, switched: 0 },
          },
        },
        { provider: 'ovh', calls: 3, in: 0, out: 0, failed: 1, costCNY: 0, switched: 1 },
      ],
      // 契约 A：切换成功（口径 A，分母 = 真正发出请求的候选尝试）
      switches: { total: 3, byProvider: { kilo: 2, ovh: 1 }, byModel: { 'kilo/kilo-auto/free': 2 }, switchSuccessRate: 0.75 },
    },
    token: { ok: true, days: [] },
    summary: { todayCNY: 0, monthCNY: 0, todayCalls: 10, totalCalls: 10, failedCalls: 1, paidCalls: 0, costUnknown: 0, lastAt: 1793689675044 },
  },
  cash: {
    ok: true,
    deepseek: { available: true, balances: [{ currency: 'CNY', total: 11, granted: 0, topped: 11 }] },
    // 火山方舟三分支（live / estimated / error）：fixture 用 estimated，因为本机没配主账号 AK/SK
    ark: {
      provider: 'ark', total: 3.5, currency: 'CNY', source: 'estimated', error: null,
      fetchedAt: 1793690401174,
      period: { fromMs: 1791098400000, toMs: 1793690400000 },
      note: '真实账单需主账号 AK/SK 签名查询',
      basis: 'ledger-30d',
      billingQuery: null,
    },
    errors: [],
  },
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
    selects: () => flatten(rt.tree).filter((n) => n.type === 'select'),
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
    // 需求 #5/#6：作用域层夹具（key = `${scope}:${id||''}`）+ 可选模型/渠道清单
    settingsLayers: {},       // 各层已存配置（global 仍走 runtimeConfig）
    settingsContext: null,    // meta.context 覆盖（workspaceId / sessionId / teamId）
    settingsModels: null,     // /settings.models 覆盖（不给 ⇒ 用默认三条）
    settingsModelsVisible: null, // /settings.modelsVisible 覆盖（后端已去重的选择器口径）
    settingsChannels: null,   // /settings.channels 覆盖（不给 ⇒ 用默认两条）
    contextState: null,       // /context 覆盖（不给 ⇒ 尚无上报）
    rejectSettingsConj: null, // 形如 'PATCH' / 'POST'：模拟旧后端不支持该方法（405）
    fail: {},
    log: [],
    ...overrides,
  }
  const layerKey = (scope, id) => scope + ':' + (id || '')
  const layerCfg = (scope, id) => (scope === 'global'
    ? clone(db.runtimeConfig)
    : clone(db.settingsLayers[layerKey(scope, id)] || {}))
  const setLayerCfg = (scope, id, cfg) => {
    if (scope === 'global') db.runtimeConfig = clone(cfg)
    else if (Object.keys(cfg || {}).length === 0) delete db.settingsLayers[layerKey(scope, id)]
    else db.settingsLayers[layerKey(scope, id)] = clone(cfg)
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
    db.log.push({ url: base, method: req.method, body: req.body ? clone(req.body) : undefined })
    if (db.fail[base]) return { status: db.fail[base], body: { ok: false, error: 'mock failure ' + db.fail[base] } }
    if (req.method === 'GET') {
      switch (base) {
        case '/cs-myfree/state': return { body: stateBody() }
        case '/cs-myfree/channels': return { body: { ok: true, at: Date.now(), channels: clone(db.channels), total: db.channels.length } }
        case '/cs-myfree/chain': return { body: { ok: true, builtin: clone(db.builtin), overrides: clone(db.overrides), effective: eff(), tiers: chainSummary(eff()), applied: true } }
        case '/cs-myfree/chain/catalog': return {
          body: {
            ok: true, at: Date.now(),
            sources: [
              { kind: 'keyless', provider: 'kilo', label: 'Kilo 免费池', models: [{ id: 'kilo-auto/free', name: 'kilo-auto/free' }] },
              { kind: 'keyless', provider: 'ovh', label: 'OVH 免费视觉', models: [{ id: 'Qwen3.5-397B-A17B', name: 'Qwen3.5-397B-A17B' }] },
              { kind: 'channel', provider: 'codearts', label: 'CodeArts（华为云）', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }], accounts: 1 },
            ],
          },
        }
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
        case '/cs-myfree/settings': {
          const ctx = db.settingsContext || { workspaceId: null, sessionId: null, teamId: null }
          const layers = [
            { scope: 'global', id: null, owner: null, setKeys: Object.keys(db.runtimeConfig).length, config: clone(db.runtimeConfig) },
            { scope: 'workspace', id: ctx.workspaceId || null, owner: null, setKeys: Object.keys(layerCfg('workspace', ctx.workspaceId)).length, config: layerCfg('workspace', ctx.workspaceId) },
            { scope: 'session', id: ctx.sessionId || null, owner: null, setKeys: Object.keys(layerCfg('session', ctx.sessionId)).length, config: layerCfg('session', ctx.sessionId) },
            { scope: 'team', id: ctx.teamId || null, owner: null, setKeys: Object.keys(layerCfg('team', ctx.teamId)).length, config: layerCfg('team', ctx.teamId) },
          ]
          const scopes = db.scopes || { workspaces: [{ id: 'dev', label: 'dev' }, { id: 'pa', label: 'pa' }], teams: [{ id: 'room-0077fb14', label: 'test-room' }], session: { id: 's1', label: '测试会话' } }
          const byLayer = { global: clone(db.runtimeConfig) }
          for (const scope of ['workspace', 'session', 'team']) {
            const cfg = layerCfg(scope, ctx[scope + 'Id'])
            if (Object.keys(cfg).length > 0) byLayer[scope] = cfg
          }
          return {
            body: {
              ok: true, at: Date.now(),
              layers,
              effective: { config: clone(db.runtimeConfig), layers: { global: 1, workspace: 0, session: 0, team: 0 }, ids: {}, byLayer },
              scopes,
              meta: { isAdmin: true, context: ctx, note: 'isAdmin=false 时，owner=admin 的层只读' },
              modelsVisible: db.settingsModelsVisible || undefined,
              models: db.settingsModels || [
                { provider: 'kilo', label: 'Kilo 免费池', models: [{ id: 'kilo-auto/free', name: 'kilo-auto/free' }] },
                { provider: 'ovh', label: 'OVH 免费视觉', models: [{ id: 'Qwen3.5-397B-A17B', name: 'Qwen3.5-397B-A17B' }] },
                { provider: 'codearts', label: 'CodeArts（华为云）', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] },
              ],
              channels: db.settingsChannels || [
                { id: 'kilo', label: 'Kilo 免费池', loggedIn: false, state: 'ok', failCount: 0, coolingMs: 0, blacklisted: false, usable: true },
                { id: 'codearts', label: 'CodeArts（华为云）', loggedIn: true, state: 'ok', failCount: 0, coolingMs: 0, blacklisted: false, usable: true },
              ],
              recent: [],
              failures: null,
              hint: '优先级：全局 ← 工作区 ← 会话 ← 团队（团队最窄最优先）。',
            },
          }
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
        case '/cs-myfree/context': return { body: db.contextState || { ok: true, empty: true } }
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
      case '/cs-myfree/settings': {
        const b = req.body || {}
        // 旧后端兼容用例：显式拒绝某种方法（前端应降级到另一种）
        if (db.rejectSettingsConj && db.rejectSettingsConj === req.method) {
          return { status: 405, body: { ok: false, error: 'method not allowed' } }
        }
        if (!['global', 'workspace', 'session', 'team'].includes(b.scope)) return { body: { ok: false, error: '未知作用域：' + b.scope } }
        if (b.scope !== 'global' && !b.id) return { body: { ok: false, error: b.scope + ' 作用域需要 id' } }
        if (!b.patch || typeof b.patch !== 'object') return { body: { ok: false, error: '缺少 patch' } }
        // 真实语义（与 src/web/settings.js 一致）：patch 里 null ⇒ 删掉该层该键（恢复继承）
        const next = applyPatch(layerCfg(b.scope, b.id), b.patch)
        setLayerCfg(b.scope, b.id, next)
        return { body: { ok: true, scope: b.scope, id: b.id ?? null, owner: 'admin', setKeys: Object.keys(next).length, hint: '已保存，下次请求生效' } }
      }
      case '/cs-myfree/context': {
        if (req.method === 'DELETE') { db.contextState = null; return { body: { ok: true, cleared: true } } }
        return { body: { ok: false, error: 'unsupported' } }
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
      // 「测试搜索」：真联网端点（POST /search/run {q}）；这里返回多源 + 部分超时的真实形状
      case '/cs-myfree/search/run': {
        const q = (req.body && req.body.q) || ''
        if (db.searchDisabled) return { body: { ok: false, error: '搜索已关闭（设置里打开）', results: [], sources: [] } }
        return {
          body: {
            ok: true, q, at: Date.now(), total: 2, budgetMs: 15000, timedOut: true,
            results: [
              { title: 'DeepSeek Harness 文档', url: 'https://example.com/dsh', snippet: '插件与技能', source: 'bing-rss', rank: 1 },
              { title: 'Cordis 组合说明', url: 'https://example.com/cordis', snippet: 'bundle patch', source: 'mwmbl', rank: 2 },
            ],
            sources: [
              { id: 'bing-rss', ok: true, ms: 820, count: 1 },
              { id: 'bing-html', ok: false, ms: 15000, count: 0, error: 'timeout' },
              { id: 'sogou', ok: true, ms: 640, count: 0 },
              { id: 'mwmbl', ok: true, ms: 310, count: 1 },
            ],
          },
        }
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

// design/21 §1：5 Tab 信息架构 → 4 个可见 tab（W4 预留不占位）
const PANELS = [
  { tab: '总览', must: ['一眼看懂当前状态', '2 条候选', '1/18 家已登录', '现在能用什么', '一键体检', '检查路由 / 状态目录', '花费与用量', '花费汇总', '今日调用10', 'ledger.jsonl'] },
  { tab: '供给源', must: ['探测免密源', '全部测试', '全部续期', '免密源（无需登录）', '账号渠道（18 家 · 已登录 1 家', '暂不可用', '已验证', '未验证', '额度与签到', '自动签到 / 领积分', '2000 积分'] },
  { tab: '模型与路由', must: ['自动路由', '开（自动选路）', '优先顺序', '手动降级链（覆盖）', '内置链2 条', '渠道模型', '显示全部渠道', 'CodeArts（华为云）', 'kilo-auto/free', '正常'] },
  { tab: '设置', must: ['① 这些设置应用在', '所有对话（全局）', '这个工作区', '这个对话', '这个团队', '默认用哪个模型', '允许用付费模型吗', '哪些渠道可用', '最近 5 次请求', '火山方舟余额', '并发与冷却', '同时最多几个请求（按渠道）', '失败后等多久再试（秒）', '被限流后等多久（秒）', '保护策略', '预算与付费', '省 Token', '备份与恢复', '保存这一层'] },
]

// ─────────────────────────────────────────────────────────────────────────────
// ① 14 面板：渲染、字段、回调、与真实 API 快照一致
// ─────────────────────────────────────────────────────────────────────────────
test('ZONES 是 W0..W3 共 4 个分区（design/21 §1：总览/供给源/模型与路由/设置，W4 预留）', async () => {
  const c = await mount({ backend: makeBackend().backend })
  const ids = c.mod.ZONES.map((z) => z.id)
  assert.equal(c.mod.ZONES.length, 4)
  assert.equal(ids[0], 'W0')
  assert.equal(ids.join(','), 'W0,W1,W2,W3')
  assert.equal(c.mod.ZONES.map((z) => z.key).join(','), 'overview,sources,models,settings')
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
    '总览': ['刷新', '一键体检'],
    '供给源': ['探测免密源', '全部测试', '全部续期', '再加一个', '一键登录', '立即签到（全部渠道）', '刷新状态', '重新加载'],
    '模型与路由': ['+ 加一条', '保存覆盖层', '清空草稿', '显示全部渠道', '去「设置」页调整'],
    '设置': ['保存这一层', '复制 JSON', '导入并覆盖', '清空'],
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

test('全部 4 个面板在接口 500 时都有错误文案（不静默假装加载中）', async () => {
  const be = makeBackend()
  const failAll = async (url) => ({ status: 500, body: { ok: false, error: 'boom' } })
  const c = await mount({ backend: failAll })
  try {
    await c.start()
    const expect = {
      '总览': '状态接口读取失败',
      '供给源': '出错了',
      '模型与路由': '读取失败',
      '设置': '设置读取失败',
    }
    for (const [tab, needle] of Object.entries(expect)) {
      await c.openTab(tab)
      assert.ok(c.text().includes(needle), `${tab} 错误态缺少「${needle}」：${c.text().slice(0, 400)}`)
    }
  } finally { c.unmount() }
})

test('空数据时 4 个面板有明确空态（不崩、不显示假数据）', async () => {
  const empty = {
    '/cs-myfree/state': { ok: true, sources: { keyless: [], channels: [], counts: { keyless: 0, channels: 0, checkin: 0, manualRefresh: 0, proxyRequired: 0 } }, chain: { builtinCount: 0, overrideCount: 0, effectiveCount: 0, tiers: [] }, config: { vision: 'off', search: [], budget: {}, paid: {} }, probe: null, checkin: { supported: [], note: '无' } },
    '/cs-myfree/chain': { ok: true, builtin: [], overrides: [], effective: [], tiers: [], applied: true },
    '/cs-myfree/channels': { ok: true, channels: [], total: 0 },
    '/cs-myfree/models': { ok: true, defaultModels: {}, sources: [], note: '空' },
    '/cs-myfree/channels/models': { ok: true, total: 0, models: [], byChannel: {} },
    '/cs-myfree/config': { ok: true, config: {}, defaults: {} },
    '/cs-myfree/scope': { ok: true, files: [], effective: { layers: { global: 0, preset: 0, session: 0 } }, hint: '' },
    '/cs-myfree/settings': { ok: true, layers: [{ scope: 'global', id: null, owner: null, setKeys: 0, config: {} }, { scope: 'workspace', id: null, owner: null, setKeys: 0, config: {} }, { scope: 'session', id: null, owner: null, setKeys: 0, config: {} }, { scope: 'team', id: null, owner: null, setKeys: 0, config: {} }], effective: { config: {}, layers: {}, ids: {}, byLayer: {} }, scopes: { workspaces: [], teams: [], session: null }, meta: { isAdmin: true, context: {} }, models: [], channels: [], recent: [], failures: null, hint: '' },
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
    // 模型与路由：无渠道/无模型时的空态
    await c.openTab('模型与路由')
    assert.ok(c.text().includes('（没有可显示的模型数据）'), c.text().slice(0, 400))
    // 供给源：0 渠道 + 签到无数据
    await c.openTab('供给源')
    assert.ok(c.text().includes('账号渠道（0 家'))
    assert.ok(c.text().includes('暂无已登录渠道的积分数据'), c.text().slice(-500))
    // 总览：空链提示 + 花费 ¥0
    await c.openTab('总览')
    assert.ok(c.text().includes('0 条候选（空 ⇒ 必失败）'), c.text().slice(0, 400))
    assert.ok(c.text().includes('今日花费') && c.text().includes('¥0'), c.text().slice(0, 400))
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

test('流程② 改降级链：内置条目可见可删（禁用）→ 加一条 → 保存 → 重载保持 → 诚实报告', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('模型与路由')

    // 🔴 初始：覆盖层 1 条(kilo) + 内置里未被覆盖的 1 条(ovh) ⇒ 2 行可见
    // 每行 3 个下拉（平台 / 跨平台搜模型是 input / 模型 / 层）；末尾 1 个是「复杂路由基本规则」里的策略下拉
    assert.equal(c.selects().length, 7, '初始应显示 2 行（6 个下拉）+ 路由规则 1 个')
    // 内置条目必须可见（否则用户「删不掉」——这是用户实测的原始 bug）
    assert.ok(c.text().includes('Qwen3.5-397B-A17B'), '内置的 ovh 必须作为一行显示')
    assert.ok(c.text().includes('kilo-auto/free'), '覆盖层的 kilo 必须显示')

    // 加一条新行
    await c.click('+ 加一条')
    assert.equal(c.selects().length, 10, '3 行 × 3 下拉 + 路由规则 1 个')

    // 把新增行改成 codearts + 模型 + T2
    let sels = c.selects()
    await c.change(sels[6], 'codearts')
    sels = c.selects()
    await c.change(sels[7], 'deepseek-v4.1-flash')
    sels = c.selects()
    await c.change(sels[8], '2')
    await c.click('保存覆盖层')
    assert.ok(c.text().includes('✅ 已保存并立即生效'), c.text().slice(-400))

    // 覆盖层应含 3 条：kilo(覆盖) + ovh(内置显式化) + codearts(新增)
    const provs = be.db.overrides.map((e) => e.provider)
    assert.ok(provs.includes('codearts'), '新增的 codearts 必须写入')
    assert.ok(provs.includes('ovh'), '内置的 ovh 也必须作为覆盖条目保存（否则编辑会丢）')

    // 删除内置的 kilo 那一行（第 1 行）⇒ 必须写成 disabled 规则（否则它会回来）
    const dels = c.nodes().filter((n) => n.props && n.props.title && String(n.props.title).includes('移除'))
    assert.ok(dels.length >= 2, '两行都是内置链条目，都应有「移除」按钮（写 disabled）')
    await c.click(dels[0])
    await c.click('保存覆盖层')
    const disabled = (be.db.overrides || []).filter((e) => e.disabled === true)
    assert.ok(disabled.length >= 1, '删掉内置条目必须留下 disabled 规则：' + JSON.stringify(be.db.overrides))
    assert.equal(disabled[0].provider, 'kilo', '删掉的是第 1 行（kilo）')

    // 重载后 3 行（kilo 已禁用但作为规则保留 + ovh + codearts），每行 3 下拉
    const afterReload = c.selects().length
    assert.equal(afterReload, 10, '重载后应仍显示 3 行（每行 3 下拉）+ 路由规则 1 个：实际 ' + afterReload)

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
    // 额度健康并入供给源：切走再切回，HealthZone 重新挂载并读到探测后的范围（okCount=1，不含没探测的源）
    await c.openTab('总览')
    await c.openTab('供给源')
    await c.waitFor(() => c.text().includes('可用1 个（只探测默认优先源'), { label: '刷新后探测范围' })
    assert.ok(c.text().includes('只探测默认优先源 Kilo/OVH'), '不能把没探测的源算进分母：' + c.text().slice(-400))
  } finally { c.unmount() }
})

test('流程④ 改预算：后端热更新则显示已保存；只写盘不热更新则如实警告', async () => {
  const be = makeBackend({ staleConfig: true })   // 模拟旧后端
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('设置')
    // BudgetZone 的「⑤ 日限额 (¥)」：按 label 定位其后第一个数字输入（设置页内输入多，不能按顺序猜）
    const all = c.nodes()
    const labelIdx = all.findIndex((n) => n.props && n.props.children === '⑤ 日限额 (¥)')
    assert.ok(labelIdx >= 0, '设置页应包含 BudgetZone 的日限额 label：' + c.text().slice(0, 500))
    const daily = all.slice(labelIdx + 1).find((n) => n.type === 'input' && n.props.type === 'number')
    assert.ok(daily, '日限额 label 后应有数字输入')
    await c.change(daily, '5')
    // BudgetZone 自己的「保存」按钮（按组件 path 区分，避免点到保护策略的保存）
    const saveBtn = c.nodes().find((n) => n.type === 'button' && String(n.props.children).includes('保存') && n.path.includes('BudgetZone'))
    assert.ok(saveBtn, 'BudgetZone 应有保存按钮')
    await c.click(saveBtn)
    assert.ok(c.text().includes('运行时仍是旧值'), '必须抓到「写盘成功但运行时没变」：' + c.text().slice(-600))
    assert.ok(c.text().includes('budget.dailyCNY'), '要指出具体字段')
    assert.ok(c.text().includes('需重启插件/宿主'), '要给出修复动作')

    be.db.staleConfig = false                       // 新后端：热更新
    await c.click(saveBtn)
    assert.ok(c.text().includes('✅ 已保存'), c.text().slice(-400))
  } finally { c.unmount() }
})

test('流程⑤ 一键体检：正常显示 6 项；接口失败显示错误', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('总览')
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

test('流程⑥ 设置作用域：下拉选真实对象 → 保存对应层；枚举为空时手填兜底', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('设置')
    // 重渲染后 select 是新对象 ⇒ 一律按「选项内容」识别，不靠对象身份比较
    const optVals = (s) => {
      const out = []
      const walk = (node) => {
        for (const ch of (Array.isArray(node) ? node : [node])) {
          if (!ch || !ch.props) continue
          if (typeof ch.props.value === 'string' && ch.props.value) out.push(ch.props.value)
          if (Array.isArray(ch.props.children)) walk(ch.props.children)
          if (Array.isArray(ch.children)) walk(ch.children)
        }
      }
      walk(s && s.props && s.props.children)
      return out
    }
    const selBy = (pred) => c.selects().find((s) => pred(optVals(s)))
    const scopeDropdown = () => selBy((v) => v.includes('global') && v.includes('team'))
    const wsDropdown = () => selBy((v) => v.includes('dev') || v.includes('pa'))
    const teamDropdown = () => selBy((v) => v.some((x) => /^room-/.test(x)))
    const modelDropdown = () => selBy((v) => v.includes('deepseek-v4.1-flash') || v.includes('kilo-auto/free'))

    // ① 作用域下拉：4 个选项（所有对话/这个工作区/这个对话/这个团队）
    const scopeSel = scopeDropdown()
    assert.ok(scopeSel, '应有作用域下拉：' + c.text().slice(0, 300))
    assert.deepEqual(optVals(scopeSel), ['global', 'workspace', 'session', 'team'], '作用域下拉选项固定 4 项')
    assert.ok(c.text().includes('所有对话（全局）'), '选项文案人类化：' + c.text().slice(0, 300))

    // ② 全局层保存：改默认模型 → 保存这一层 → POST /settings scope=global
    await c.waitFor(() => modelDropdown(), { label: '模型下拉出现' })
    const modelSel = modelDropdown()
    assert.ok(modelSel, '应有模型下拉')
    await c.change(modelSel, 'deepseek-v4.1-flash')
    await c.click('保存这一层')
    await c.waitFor(() => c.text().includes('✅ 已保存'), { label: '全局保存反馈' })
    const gPost = be.db.log.filter((x) => x.url === '/cs-myfree/settings' && x.method === 'POST').pop()
    assert.ok(gPost, 'DEBUG settings log=' + JSON.stringify(be.db.log.filter((x) => x.url.includes('/settings')).map((x) => x.url + ':' + x.method)).slice(-300) + ' text=' + c.text().slice(-200))
    assert.ok(gPost.body.scope === 'global', '应 POST scope=global：' + JSON.stringify(gPost.body))

    // ③ 切 workspace → 出现工作区下拉（枚举来自 GET /settings scopes.workspaces）→ 选 pa → 保存带 id=pa
    await c.change(scopeDropdown(), 'workspace')
    await c.waitFor(() => wsDropdown(), { label: '工作区下拉出现' })
    const wsSel = wsDropdown()
    const wsOpts = optVals(wsSel)
    assert.ok(wsOpts.includes('dev') && wsOpts.includes('pa'), '工作区枚举应来自后端 scopes：' + JSON.stringify(wsOpts))
    await c.change(wsSel, 'pa')
    // 选非当前上下文对象 ⇒ 表单置空；改默认模型制造一个改动再保存（空 patch 会提示「无需保存」不发请求）
    await c.waitFor(() => modelDropdown(), { label: '模型下拉仍在' })
    const modelSel2 = modelDropdown()
    assert.ok(modelSel2, '模型下拉应存在')
    await c.change(modelSel2, 'deepseek-v4.1-flash')
    await c.click('保存这一层')
    await c.waitFor(() => c.text().includes('✅ 已保存'), { label: '工作区保存反馈' })
    const wPost = be.db.log.filter((x) => x.url === '/cs-myfree/settings' && x.method === 'POST').pop()
    assert.ok(wPost, 'DEBUG log=' + JSON.stringify(be.db.log.map(x => x.url + ':' + x.method)).slice(-400) + ' text=' + c.text().slice(-260))
    assert.ok(wPost && wPost.body.scope === 'workspace' && wPost.body.id === 'pa', '应 POST workspace/pa：' + JSON.stringify(wPost && wPost.body))

    // ④ 切 team → 团队下拉选项来自 scopes.teams（label 用房间名）
    await c.change(scopeDropdown(), 'team')
    await c.waitFor(() => teamDropdown(), { label: '团队下拉出现' })
    const tmSel = teamDropdown()
    assert.ok(tmSel, '团队下拉应出现')
    const tmOpts = optVals(tmSel)
    assert.ok(tmOpts.includes('room-0077fb14'), '团队枚举应来自后端 scopes：' + JSON.stringify(tmOpts))
    assert.ok(JSON.stringify(tmSel.props.children).includes('test-room'), '团队 label 应展示房间名')

    // ⑤ 切 session → 显示当前会话（不可选别的会话）
    await c.change(scopeDropdown(), 'session')
    await c.waitFor(() => c.text().includes('当前会话：'), { label: '会话显示' })
    assert.ok(c.text().includes('测试会话'), '应显示当前会话 label：' + c.text().slice(-300))

    // ⑥ 枚举为空 → 手填兜底（不崩、给出可手填的输入框）
    be.db.scopes = { workspaces: [], teams: [], session: null }
    await c.change(scopeDropdown(), 'workspace')
    await c.waitFor(() => c.text().includes('当前没有可选的工作区'), { label: '手填兜底' })
    assert.ok(c.text().includes('可手填 ID'), c.text().slice(-300))
  } finally { c.unmount() }
})

test('流程⑦ 导入导出：剪贴板不可用要报错；导入 JSON 真的整表覆盖；坏 JSON 有提示', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend, clipboard: { writeText: () => Promise.reject(new Error('denied')) } })
  try {
    await c.start()
    await c.openTab('设置')
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
    await c.openTab('模型与路由')
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
    await c.openTab('模型与路由')
    await c.click('保存覆盖层')
    assert.ok(c.text().includes('✅ 已保存并立即生效'), 'applied=true 口径')
    be.db.chainApplied = false
    await c.click('保存覆盖层')
    assert.ok(c.text().includes('需重启生效'), 'applied=false+requiresRestart 口径')
  } finally { c.unmount() }
})

test('诚实性：4 个 tab 全部挂载时没有 Render 错误被 ErrorBoundary 吞掉', async () => {
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
    assert.ok(c.text().includes('· 需 OAuth token，未实现'), '必须展示后端的 reason：' + c.text().slice(-800))
    assert.ok(c.text().includes('· 本机网络不可达'), 'gemini 的不可达原因必须展示')
    assert.ok(c.text().includes('厂商官网'), '次要链接应叫「厂商官网」')
    assert.equal(c.text().includes('去官网'), false, '旧的误导性「去官网」必须移除')
  } finally { c.unmount() }
})

test('额度健康：自动签到状态 + 积分真实数据 + 立即签到结果 + 开关保存生效', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('供给源')
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

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 2026-11 第三轮：路由基本规则 / 子智能体路由 / 联网搜索 / 识图 / 火山方舟
//    （需求原文：规则说明 + 统计 + 设置三合一，且**不许**加「启用/关闭路由规则」总开关）
// ─────────────────────────────────────────────────────────────────────────────

/** select 的所有 option.value（含 optgroup 里的），用于「按选项内容」而不是对象身份找控件 */
function optValsOf(sel) {
  const out = []
  const walk = (node) => {
    for (const ch of (Array.isArray(node) ? node : [node])) {
      if (!ch || !ch.props) continue
      if (typeof ch.props.value === 'string' && ch.props.value) out.push(ch.props.value)
      if (Array.isArray(ch.props.children)) walk(ch.props.children)
      if (Array.isArray(ch.children)) walk(ch.children)
    }
  }
  walk(sel && sel.props && sel.props.children)
  return out
}

test('文案存在性：切换成功 / 路由基本规则 / 子智能体路由 / 联网搜索 / 识图（用户点名要的五处）', async () => {
  const c = await mount({ backend: makeBackend().backend })
  try {
    await c.start()
    await c.openTab('总览')
    assert.ok(c.text().includes('切换成功'), '总览页缺「切换成功」：' + c.text().slice(0, 900))
    await c.openTab('模型与路由')
    assert.ok(c.text().includes('路由基本规则'), '模型与路由页缺「路由基本规则」：' + c.text().slice(-900))
    await c.openTab('设置')
    const t = c.text()
    for (const s of ['联网搜索', '识图', '子智能体路由', '火山方舟余额']) {
      assert.ok(t.includes(s), '设置页缺「' + s + '」：' + t.slice(-1500))
    }
  } finally { c.unmount() }
})

test('路由基本规则：策略/排序/权重/过滤层/空集兜底/冷却/闸门统计/设置项齐全', async () => {
  const c = await mount({ backend: makeBackend().backend })
  try {
    await c.start()
    await c.openTab('模型与路由')
    const t = c.text()
    for (const s of [
      '路由基本规则',
      '策略（当前：free-first）',
      // ① 策略：label + desc + evidence（实测依据），非 active 压暗
      '免费优先', '先试免密源，再试付费渠道', '实测依据：实测免密源成功率更高',
      '均衡', '按拥挤度与失败率均衡打分',
      // ② 排序：人话 + 等宽小字数组
      '先过严格过滤层，再过免费过滤层，然后比拥挤度，最后比失败率。',
      'impl → free → load → fail',
      // ③ 权重
      '拥挤度权重（load）', '失败率权重（fail）',
      // ④ 过滤层：位置 + 名称 + 严格/可放宽 + effect
      '#1 渠道已实现', '严格', '未实现的渠道直接剔除（空集也不放宽）',
      '#2 免费可见', '可放宽', '空集时放行付费渠道',
      // ⑤ 空集兜底
      '空集兜底范围', '所有过滤都空时放开「免费可见」这一层', '永不放宽：渠道已实现',
      // ⑥ 冷却参数
      '冷却参数（当前生效值）', 'busyMs', 'rateMs', 'maxMs', '指数退避，封顶 10 分钟',
      // ⑦ 闸门统计（7 列）
      '各家闸门统计（实时）', '活跃/上限', '占比', '冷却', '429连击', '失败率', '样本数',
      'codearts', '1/2', '50%', '冷却中 15s',
      // ⑧ 设置项（控件 + effect + 来源）
      '设置（保存到全局层）', '优先策略', '默认值', '已自定义', '每家并发上限',
    ]) assert.ok(t.includes(s), '缺少文案：' + s + '\n' + t.slice(-1500))

    // 🔴 定位红线：这是「说明 + 统计 + 设置」面板，不许出现任何总开关
    assert.equal(/启用.{0,6}路由|关闭.{0,6}路由|路由.{0,4}(总开关|总用|启用|关闭)/.test(t), false,
      '路由基本规则不许有「启用/关闭路由规则」总开关：' + t.slice(-1200))
  } finally { c.unmount() }
})

test('路由基本规则：闸门无数据显示「暂无闸门数据」；严格=黄徽标、可放宽=灰徽标；冷却高亮', async () => {
  const baseRules = {
    policy: 'blended',
    policyOptions: [
      { id: 'blended', label: '混合', desc: '当前生效', active: true, evidence: '实测更稳' },
      { id: 'free-first', label: '免费优先', desc: '先免费', active: false, evidence: '实测免费源会挂' },
    ],
    order: ['tier', 'billing'],
    orderHuman: '先分层，再看计费。',
    weights: { load: 1, fail: 1 },
    filters: [
      { id: 'a', label: '渠道已实现', position: 1, strict: true, effect: '硬剔除' },
      { id: 'b', label: '免费可见', position: 2, strict: false, effect: '空集放宽' },
    ],
    emptySetFallback: { appliesTo: ['免费可见'], excludes: ['渠道已实现'], note: '空集时放开免费层' },
    cooldowns: { busyMs: 1000, rateMs: 2000, maxMs: 3000, note: '指数退避' },
    gate: {},
    configurable: [],
  }
  const c = await mount({ backend: makeBackend().backend })
  try {
    await c.start(c.mod.RoutingRulesCard, { rules: baseRules })
    assert.ok(c.text().includes('暂无闸门数据'), '无闸门数据时必须明确说「暂无闸门数据」：' + c.text().slice(-600))

    // 徽标档位靠背景色断言（warn = 黄，dim = 灰）——比断言文案更硬的证据
    const spanOf = (s) => c.nodes().find((n) => n.type === 'span' && n.children.length === 1 && n.children[0].text === s)
    assert.ok((spanOf('严格').props.style.background || '').includes('220,160,40'), '严格必须是 warn 档（黄）徽标')
    assert.ok((spanOf('可放宽').props.style.background || '').includes('128,128,128'), '可放宽必须是 dim 档（灰）徽标')

    // 冷却中：既要写「冷却中 Xs」，又要高亮（warn 前景色）
    await c.start(c.mod.RoutingRulesCard, {
      rules: Object.assign({}, baseRules, {
        gate: { kilo: { active: 0, limit: 3, ratio: 0, coolingMs: 15000, streak429: 2, failRate: 0.5, failSamples: 4 } },
      }),
    })
    assert.ok(c.text().includes('冷却中 15s'), '冷却中的渠道必须写「冷却中 15s」：' + c.text().slice(-600))
    const cool = spanOf('冷却中 15s')
    assert.ok(cool, '找不到冷却单元格')
    assert.equal(cool.props.style.color, 'var(--dsw-alias-state-warn-primary)', '冷却中必须高亮（warn 色）')
    // 失败率 + 样本数必须同时给出（只有百分比没有样本数 = 不可信）
    assert.ok(c.text().includes('50%'), c.text().slice(-400))
    assert.ok(c.text().includes('样本数'), c.text().slice(-400))
  } finally { c.unmount() }
})

test('子智能体路由：三选项 + 人话说明；pinned 展开模型下拉与兜底，保存写 subagentRouting', async () => {
  const be = makeBackend()
  const c = await mount({ backend: be.backend })
  try {
    await c.start()
    await c.openTab('设置')
    const t0 = c.text()
    for (const s of [
      '子智能体路由',
      '选了一个对话后，子智能体默认不跟随上级对话的模型，由 myfree 接手自动切换。',
      '不跟随路由，自动切换',
      '不跟随路由，后续仍由全局或单独设置兜底（选定一个模型）',
      '跟随路由，后续仍由全局或单独设置兜底',
    ]) assert.ok(t0.includes(s), '缺少文案：' + s + '\n' + t0.slice(-1600))
    // 默认 auto：不展开模型下拉/兜底（否则「选了一个模型」这张表单看起来像必填）
    assert.equal(t0.includes('固定用哪个模型'), false, 'auto 模式不该展开模型下拉')

    // 选 pinned ⇒ 展开模型下拉（选项来自 GET /settings 的 models）+ 兜底两选
    // ⚠️ 必须带「选项二：」前缀：clickableByText 是**子串**匹配，
    //    '跟随路由，后续仍由全局或单独设置兜底' 恰是「不跟随路由，…」的子串 ⇒ 选项三会误点成选项二。
    await c.click('选项二：不跟随路由，后续仍由全局或单独设置兜底')
    await c.waitFor(() => c.text().includes('固定用哪个模型'), { label: 'pinned 展开模型下拉' })
    assert.ok(c.text().includes('兜底：主选不可用时怎么办'), c.text().slice(-800))
    // ⚠️ 「默认用哪个模型」下拉的选项也是同一份模型列表 ⇒ 子智能体卡片里的那个在 DOM 里更靠后（取最后一个）；
    //    取第一个会误改 model.default（本用例第一版就踩了这个坑）
    const modelSels = c.selects().filter((s) => optValsOf(s).includes('kilo-auto/free'))
    assert.ok(modelSels.length >= 2, '应有「默认模型」与「子智能体固定模型」两个模型下拉：' + JSON.stringify(modelSels.map(optValsOf)))
    const modelSel = modelSels[modelSels.length - 1]
    await c.change(modelSel, 'kilo-auto/free')
    const fbSel = c.selects().find((s) => { const v = optValsOf(s); return v.includes('global') && v.includes('scope') })
    assert.ok(fbSel, '兜底必须是 global / scope 两选')
    await c.change(fbSel, 'scope')

    await c.click('保存这一层')
    await c.waitFor(() => c.text().includes('✅ 已保存'), { label: '保存反馈' })
    const post = be.db.log.filter((x) => x.url === '/cs-myfree/settings' && x.method === 'POST').pop()
    assert.ok(post, '应 POST /settings')
    assert.deepEqual(post.body.patch.subagentRouting,
      { mode: 'pinned', model: 'kilo-auto/free', fallback: 'scope' },
      '必须按 subagentRouting.{mode,model,fallback} 落盘：' + JSON.stringify(post.body.patch))

    // 选 follow ⇒ 模型下拉收起，兜底仍在（follow 也要兜底，否则主链全挂直接失败）
    // ⚠️ 同上：必须用「选项三：」前缀消歧义
    await c.click('选项三：跟随路由，后续仍由全局或单独设置兜底')
    await c.waitFor(() => !c.text().includes('固定用哪个模型'), { label: 'follow 收起模型下拉' })
    assert.ok(c.text().includes('兜底：主选不可用时怎么办'), c.text().slice(-800))
  } finally { c.unmount() }
})

test('火山方舟：live/estimated/error 三分支徽标与口径；估算分支绝不出现「官方/实时/live」', async () => {
  const c = await mount({ backend: makeBackend().backend })
  try {
    // ① live：徽标「实时」+ total + currency + period + fetchedAt（本地时间）
    await c.start(c.mod.ArkCard, {
      ark: {
        provider: 'ark', total: 12.5, currency: 'CNY', source: 'live', error: null,
        fetchedAt: 1793690401174, period: { fromMs: 1791098400000, toMs: 1793690400000 }, billingQuery: 'q',
      },
      onRefresh: () => {},
    })
    let t = c.text()
    for (const s of ['火山方舟余额', '实时', '¥12.50', '币种 CNY', '查询时间', '统计区间']) {
      assert.ok(t.includes(s), 'live 分支缺少：' + s + '\n' + t)
    }

    // ② estimated：徽标「估算」+ total + note/basis；🔴 不许出现 官方/实时/live
    await c.start(c.mod.ArkCard, {
      ark: {
        provider: 'ark', total: 3.5, currency: 'CNY', source: 'estimated', error: null,
        note: '真实账单需主账号 AK/SK 签名查询', basis: 'ledger-30d', fetchedAt: 1793690401174,
      },
      onRefresh: () => {},
    })
    t = c.text()
    for (const s of ['估算', '¥3.50', '本地账本近 30 天', '不等于账单数字', '口径：ledger-30d']) {
      assert.ok(t.includes(s), 'estimated 分支缺少：' + s + '\n' + t)
    }
    for (const bad of ['官方', '实时', 'live']) {
      assert.equal(t.includes(bad), false, '估算分支的文案里绝不许出现「' + bad + '」：' + t)
    }

    // ③ error：徽标「不可用」+ error + 「需要主账号 AK/SK 才能查真实账单」
    await c.start(c.mod.ArkCard, {
      ark: { provider: 'ark', total: null, currency: 'CNY', source: 'error', error: 'ARK 查询失败：未配置凭据', fetchedAt: null },
      onRefresh: () => {},
    })
    t = c.text()
    for (const s of ['不可用', 'ARK 查询失败：未配置凭据', '需要主账号 AK/SK 才能查真实账单', 'VOLC_ACCESS_KEY_ID']) {
      assert.ok(t.includes(s), 'error 分支缺少：' + s + '\n' + t)
    }
    assert.equal(t.includes('¥'), false, 'error 分支不该显示金额（没数字就显示 —）')
  } finally { c.unmount() }
})

// ─────────────────────────────────────────────────────────────────────────────
// 需求 #5：设置完工作区/对话后，展示「哪些地方和全局不一样」
// ─────────────────────────────────────────────────────────────────────────────
/** 收集一个 select 下所有 option 的 value（optgroup 递归） */
function optionValues(node, out = []) {
  for (const ch of (node && node.children) || []) {
    if (ch && ch.type === 'option' && ch.props && ch.props.value != null) out.push(ch.props.value)
    optionValues(ch, out)
  }
  return out
}

/** 页面上「模型下拉」（带 optgroup 的那个 select） */
function modelSelect(c) {
  return c.selects().find((s) => (s.children || []).some((ch) => ch && ch.type === 'optgroup'))
}

/** 页面上「作用域下拉」（选项固定 4 个） */
function scopeSelect(c) {
  return c.selects().find((s) => optionValues(s).join(',') === 'global,workspace,session,team')
}

test('需求 #5 差异面板：工作区层逐项列出「配置路径/全局值/当前值/来源层」，无差异时显示「与全局一致」', async () => {
  const be = makeBackend({
    settingsContext: { workspaceId: 'dev', sessionId: 's1', teamId: null },
    runtimeConfig: { model: { default: 'kilo-auto/free' }, routing: { autoSwitch: true } },
    settingsLayers: {
      'workspace:dev': { model: { default: 'deepseek-v4.1-flash' }, sources: { hidden: ['qoder'] } },
    },
  })
  const c = await mount({ backend: be.backend })
  try {
    await c.start(c.mod.SettingsPage)
    // 全局层：面板不出现（没有"跟谁不一样"这回事）
    assert.equal(c.text().includes('与全局不同'), false, '全局层不该出现差异面板：' + c.text().slice(0, 400))

    await c.change(scopeSelect(c), 'workspace')
    await c.waitFor(() => c.text().includes('与全局不同'), { label: '工作区差异面板' })
    const t = c.text()
    assert.ok(t.includes('与全局不同（2 项）'), '应显示差异项数：' + t.slice(0, 700))
    for (const s of ['配置路径', '全局值', '当前值', '来源层', '恢复全局']) {
      assert.ok(t.includes(s), '差异面板缺少列/按钮：' + s + '\n' + t.slice(0, 800))
    }
    // 逐行：路径 + 全局值 + 当前值 + 来源层
    assert.ok(t.includes('model.default'), '缺少差异路径 model.default：' + t.slice(0, 800))
    assert.ok(t.includes('kilo-auto/free'), '缺少全局值：' + t.slice(0, 800))
    assert.ok(t.includes('deepseek-v4.1-flash'), '缺少当前值：' + t.slice(0, 800))
    assert.ok(t.includes('sources.hidden'), '数组型差异也要列出：' + t.slice(0, 800))
    assert.ok(t.includes('工作区'), '来源层应标「工作区」：' + t.slice(0, 800))
    // 面板挂在页面顶部（先于「① 这些设置应用在」）
    assert.ok(t.indexOf('与全局不同') < t.indexOf('① 这些设置应用在'), '面板应在设置项上方：' + t.slice(0, 400))

    // 无差异的层（对话层还没写过）：显示「与全局一致」
    await c.change(scopeSelect(c), 'session')
    await c.waitFor(() => c.text().includes('与全局一致'), { label: '对话层无差异' })
    assert.ok(c.text().includes('这一层还没有任何设置跟全局不同'), c.text().slice(0, 600))
    assert.equal(c.text().includes('与全局不同'), false, '无差异时不该出现「与全局不同」')
  } finally { c.unmount() }
})

test('需求 #5 恢复全局：PATCH /settings 删掉该层该键（不是把全局值拷进来），成功后差异消失', async () => {
  const be = makeBackend({
    settingsContext: { workspaceId: 'dev', sessionId: 's1', teamId: null },
    runtimeConfig: { model: { default: 'kilo-auto/free' }, routing: { autoSwitch: true } },
    settingsLayers: {
      'workspace:dev': { model: { default: 'deepseek-v4.1-flash' }, sources: { hidden: ['qoder'] } },
    },
  })
  const c = await mount({ backend: be.backend })
  try {
    await c.start(c.mod.SettingsPage)
    await c.change(scopeSelect(c), 'workspace')
    await c.waitFor(() => c.text().includes('与全局不同（2 项）'), { label: '两项差异' })

    // 点 model.default 那行的「恢复全局」
    const btn = c.nodes().find((n) => n.props && n.props['data-diff-restore'] === 'model.default')
    assert.ok(btn, '找不到 model.default 的恢复按钮：' + c.text().slice(0, 700))
    assert.equal(typeof btn.props.onClick, 'function', '恢复按钮必须有 onClick')
    await c.click(btn)
    await c.waitFor(() => c.text().includes('✅ 已恢复全局'), { label: '恢复反馈' })

    const patchReq = c.requests.filter((r) => r.url.includes('/settings') && r.method === 'PATCH').pop()
    assert.ok(patchReq, '恢复全局必须走 PATCH /settings，实际请求：' + JSON.stringify(c.requests.map((r) => r.method + ' ' + r.url).slice(-6)))
    assert.equal(patchReq.body.scope, 'workspace', 'scope 必须是当前层：' + JSON.stringify(patchReq.body))
    assert.equal(patchReq.body.id, 'dev', '必须带该层 id：' + JSON.stringify(patchReq.body))
    assert.deepEqual(patchReq.body.patch, { model: { default: null } },
      'patch 必须是「删除该键」（null），不是把全局值写进去：' + JSON.stringify(patchReq.body.patch))
    assert.equal(JSON.stringify(patchReq.body).includes('kilo-auto/free'), false, 'patch 里绝不许出现全局值')

    // 后端真的删了 ⇒ 差异从 2 项变成 1 项
    assert.equal(be.db.settingsLayers['workspace:dev'].model, undefined, '这一层的 model 应被删掉')
    await c.waitFor(() => c.text().includes('与全局不同（1 项）'), { label: '差异数下降' })
    assert.ok(c.text().includes('✅ 已恢复全局：删掉了这一层的「model.default」'), c.text().slice(0, 600))
  } finally { c.unmount() }
})

test('需求 #5 恢复全局：后端不支持 PATCH（405）时降级 POST，patch 语义不变', async () => {
  const be = makeBackend({
    settingsContext: { workspaceId: 'dev', sessionId: 's1', teamId: null },
    runtimeConfig: { model: { default: 'kilo-auto/free' } },
    settingsLayers: { 'workspace:dev': { model: { default: 'deepseek-v4.1-flash' } } },
    rejectSettingsConj: 'PATCH',
  })
  const c = await mount({ backend: be.backend })
  try {
    await c.start(c.mod.SettingsPage)
    await c.change(scopeSelect(c), 'workspace')
    await c.waitFor(() => c.text().includes('与全局不同（1 项）'), { label: '差异一项' })
    const btn = c.nodes().find((n) => n.props && n.props['data-diff-restore'] === 'model.default')
    await c.click(btn)
    await c.waitFor(() => c.text().includes('✅ 已恢复全局'), { label: '降级后仍成功' })
    const methods = c.requests.filter((r) => r.url.includes('/settings')).map((r) => r.method)
    assert.ok(methods.includes('PATCH'), '先试 PATCH：' + JSON.stringify(methods))
    const post = c.requests.filter((r) => r.url.includes('/settings') && r.method === 'POST').pop()
    assert.ok(post, '405 后应降级 POST：' + JSON.stringify(methods))
    assert.deepEqual(post.body, { scope: 'workspace', id: 'dev', patch: { model: { default: null } } },
      '降级后 patch 必须一致：' + JSON.stringify(post.body))
  } finally { c.unmount() }
})

// ─────────────────────────────────────────────────────────────────────────────
// 需求 #6：对话里选模型只展示 deepseek 系 / 自加 API / 免费可用 / 华为云
// ─────────────────────────────────────────────────────────────────────────────
const MODEL_FIXTURE = [
  { kind: 'keyless', provider: 'kilo', label: 'Kilo 免费池', models: [{ id: 'kilo-auto/free', name: 'kilo-auto/free' }] },
  { kind: 'channel', provider: 'deepseek', label: 'DeepSeek 官方', models: [{ id: 'deepseek-chat', name: 'deepseek-chat' }] },
  { kind: 'channel', provider: 'officeace', label: '华为云 MaaS', models: [{ id: 'maas-qwen3', name: 'MaaS Qwen3' }] },
  { kind: 'channel', provider: 'codearts', label: 'CodeArts（华为云）', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] },
  { kind: 'channel', provider: 'qoder', label: 'Qoder', models: [{ id: 'qoder-max', name: 'Qoder Max' }] },
  { kind: 'channel-unlogged', provider: 'loomy', label: 'Loomy', models: [{ id: 'loomy-1', name: 'Loomy 1' }] },
  { kind: 'channel', provider: 'kilo-paid', label: 'Kilo 付费包', models: [{ id: 'kilo-pro', name: 'Kilo Pro' }], billing: 'free' },
  { kind: 'channel', provider: 'buddy', label: 'Buddy', models: [{ id: 'buddy-1', name: 'Buddy 1' }], hidden: true },
]

test('需求 #6 选择器过滤：只留 deepseek 系/自加 API/免费可用/华为云；其它渠道包与 hidden:true 不渲染', async () => {
  const be = makeBackend({ settingsModels: clone(MODEL_FIXTURE) })
  const c = await mount({ backend: be.backend })
  try {
    await c.start(c.mod.SettingsPage)
    await c.waitFor(() => modelSelect(c), { label: '模型下拉' })
    const vals = optionValues(modelSelect(c))
    for (const keep of ['kilo-auto/free', 'deepseek-chat', 'maas-qwen3', 'deepseek-v4.1-flash', 'kilo-pro']) {
      assert.ok(vals.includes(keep), '白名单来源应保留：' + keep + '；实际 ' + JSON.stringify(vals))
    }
    for (const drop of ['qoder-max', 'loomy-1', 'buddy-1']) {
      assert.equal(vals.includes(drop), false, '非白名单渠道包不该出现在选模型列表：' + drop + '；实际 ' + JSON.stringify(vals))
    }
    assert.ok(c.text().includes('这里只列 deepseek 系 / 自加 API / 免费可用渠道 / 华为云'), c.text().slice(0, 800))

    // 渲染兜底：hidden:true 的渠道连「渠道模型」清单里也不许出现（含展开全部）
    await c.start(c.mod.ModelsZone)
    await c.waitFor(() => c.text().includes('渠道模型'), { label: '渠道模型清单' })
    assert.equal(c.text().includes('Buddy'), false, 'hidden:true 的渠道不该渲染：' + c.text().slice(0, 600))
    await c.click('显示全部渠道')
    assert.equal(c.text().includes('Buddy'), false, '展开「显示全部渠道」也不渲染 hidden:true：' + c.text().slice(0, 800))
    assert.ok(c.text().includes('1 个渠道被「不展示」挡掉'), '应如实说明被挡掉的数量：' + c.text().slice(0, 800))
  } finally { c.unmount() }
})

test('需求 #6 展示开关：sources.hidden 里的渠道不出现在选择器，取消「展示」后立刻消失并随保存写入 sources.hidden', async () => {
  const be = makeBackend({
    settingsModels: clone(MODEL_FIXTURE),
    runtimeConfig: { sources: { hidden: ['codearts'] } },
    settingsChannels: [
      { id: 'codearts', label: 'CodeArts（华为云）', available: true, loginVerified: true, status: '正常', hidden: false, reason: null },
      { id: 'qoder', label: 'Qoder', available: false, loginVerified: false, status: '未登录', hidden: true, reason: '没有可用账号' },
    ],
  })
  const c = await mount({ backend: be.backend })
  try {
    await c.start(c.mod.SettingsPage)
    await c.waitFor(() => modelSelect(c), { label: '模型下拉' })
    assert.equal(optionValues(modelSelect(c)).includes('deepseek-v4.1-flash'), false,
      'sources.hidden 里的渠道不该出现在选模型列表：' + JSON.stringify(optionValues(modelSelect(c))))

    // 表格状态列：可用 / 是否展示 / 状态 三件事都看得见
    const t0 = c.text()
    assert.ok(t0.includes('可用') && t0.includes('展示') && t0.includes('状态'), t0.slice(0, 900))
    assert.ok(t0.includes('没有可用账号'), '不可用渠道要显示原因：' + t0.slice(0, 900))

    // 打开 codearts 的「展示」⇒ 立刻回到选模型列表
    const hiddenToggle = c.nodes().find((n) => n.props && n.props['data-toggle'] === 'hidden:codearts')
    assert.ok(hiddenToggle && typeof hiddenToggle.props.onClick === 'function', '应有「展示」开关：' + t0.slice(0, 900))
    await c.click(hiddenToggle)
    await c.waitFor(() => optionValues(modelSelect(c)).includes('deepseek-v4.1-flash'), { label: '重新展示' })

    // 再关掉 qoder 的展示 ⇒ sources.hidden 里含 qoder，保存走 POST
    const qoderToggle = c.nodes().find((n) => n.props && n.props['data-toggle'] === 'hidden:qoder')
    await c.click(qoderToggle)
    await c.click('保存这一层')
    await c.waitFor(() => c.text().includes('✅ 已保存'), { label: '保存展示开关' })
    const post = c.requests.filter((r) => r.url.includes('/settings') && r.method === 'POST').pop()
    assert.ok(post, '应 POST /settings')
    assert.deepEqual(post.body.patch.sources.hidden, ['qoder'],
      '展示开关写 sources.hidden（codearts 已被移除、qoder 加进来）：' + JSON.stringify(post.body.patch))
  } finally { c.unmount() }
})

// ══════════════════════════════════════════════════════════════════════════
// 外部对话上下文卡片（DeepSeek 网页版 → DSH）
//
// 用户要求「UI 卡片放上，让我直观操作感受」⇒ 这张卡必须自己说清三件事：
//   ① 口令怎么填 ② 现在有没有数据 ③ 怎么清空/复制
// 且必须如实显示「尚无上报」而不是假装已连接。
// ══════════════════════════════════════════════════════════════════════════

test('外部上下文卡：尚无上报时如实说「还没有」，不假装已连接', async () => {
  const be = makeBackend({ contextState: { ok: true, empty: true } })
  const c = await mount({ backend: be.backend })
  try {
    const form = {}
    await c.start(c.mod.ContextBridgeCard, {
      fv: (p) => (p in form ? form[p] : undefined),
      fset: (p, v) => { form[p] = v },
      disabled: false,
    })
    const t = c.text()
    assert.ok(t.includes('外部对话上下文'), '卡片标题：' + t.slice(0, 400))
    assert.ok(t.includes('尚无上报'), '空态必须有徽标：' + t.slice(0, 400))
    assert.ok(t.includes('还没有'), '空态要写人话：' + t.slice(0, 400))
    assert.equal(t.includes('已连接'), false, '没有数据时绝不能说已连接：' + t.slice(0, 400))
    // 「传得少」的四道闸门要写出来
    for (const s of ['最近 20 条', '每条 200 字', '64KB', '6 小时']) {
      assert.ok(t.includes(s), '缺上限说明：' + s)
    }
  } finally { c.unmount() }
})

test('外部上下文卡：有数据时显示时间/条数/预览，并允许清空', async () => {
  const be = makeBackend({
    contextState: {
      ok: true, empty: false, threadId: '/a/chat/s/1', updatedAt: 1793690401174,
      ageMs: 120000, count: 7, dropped: 13, bytesKept: 2048,
      preview: [{ role: 'user', text: '我想问个事' }, { role: 'assistant', text: '你说' }],
    },
  })
  const c = await mount({ backend: be.backend })
  try {
    const form = { contextBridgeCode: 'abc123' }
    await c.start(c.mod.ContextBridgeCard, {
      fv: (p) => form[p],
      fset: (p, v) => { form[p] = v },
      disabled: false,
    })
    const t = c.text()
    assert.ok(t.includes('已连接'), '有数据 ⇒ 已连接：' + t.slice(0, 400))
    assert.ok(t.includes('7 条'), '要显示条数：' + t.slice(0, 500))
    assert.ok(t.includes('2 KB'), '要显示占用：' + t.slice(0, 500))
    assert.ok(t.includes('丢弃较早的 13 条'), '要如实说丢了多少：' + t.slice(0, 500))
    assert.ok(t.includes('我想问个事'), '要显示预览：' + t.slice(0, 600))

    // 口令回填到输入框（用户在扩展里要填同一个）
    const input = c.nodes().find((n) => n.type === 'input' && n.props && n.props.value === 'abc123')
    assert.ok(input, '口令必须回填到输入框（否则用户不知道要填什么）')

    // 清空可用
    const clearBtn = c.nodes().find((n) => n.props && typeof n.props.onClick === 'function' && n.props.children === '清空')
    assert.ok(clearBtn, '要有「清空」按钮：' + t.slice(0, 500))
    await c.click(clearBtn)
    await c.waitFor(() => c.text().includes('已清空上下文'), { label: '清空反馈' })
  } finally { c.unmount() }
})

test('外部上下文卡：读取失败要如实报错，不静默', async () => {
  const be = makeBackend()
  be.backend = (() => {
    const orig = be.backend
    return async (url, req) => {
      if (String(url).includes('/context')) return { status: 500, body: { ok: false, error: 'boom' } }
      return orig(url, req)
    }
  })()
  const c = await mount({ backend: be.backend })
  try {
    await c.start(c.mod.ContextBridgeCard, { fv: () => '', fset: () => {}, disabled: false })
    await c.waitFor(() => c.text().includes('读取状态失败') || c.text().includes('读取失败'), { label: '错误可见' })
    const t = c.text()
    assert.ok(t.includes('读取状态失败') || t.includes('读取失败'), '失败必须可见：' + t.slice(0, 400))
  } finally { c.unmount() }
})

test('外部上下文卡：禁用态下口令不可编辑（管理员锁定的层）', async () => {
  const c = await mount({ backend: makeBackend().backend })
  try {
    await c.start(c.mod.ContextBridgeCard, { fv: () => '', fset: () => {}, disabled: true })
    const input = c.nodes().find((n) => n.type === 'input' && n.props && n.props.disabled === true)
    assert.ok(input, '禁用时 input 必须有 disabled（不装假按钮）')
  } finally { c.unmount() }
})

test('🟥 选择器优先用后端 modelsVisible（同模型只留一个渠道），不被前端本地过滤覆盖', async () => {
  // 后端已去重：deepseek-v4.1-flash 只挂在 codearts（而不是 5 家全列）
  const be = makeBackend({
    settingsModels: [
      { provider: 'codearts', label: 'CodeArts', models: [{ id: 'deepseek-v4.1-flash', name: 'DS Flash' }] },
      { provider: 'buddy', label: 'CodeBuddy', models: [{ id: 'deepseek-v4.1-flash', name: 'DS Flash' }] },
    ],
    settingsModelsVisible: [
      { provider: 'codearts', label: 'CodeArts', kind: 'channel', models: [{ id: 'deepseek-v4.1-flash', name: 'DS Flash' }] },
    ],
  })
  const c = await mount({ backend: be.backend })
  try {
    await c.start(c.mod.SettingsPage)
    await c.waitFor(() => modelSelect(c), { label: '模型下拉' })
    const vals = optionValues(modelSelect(c))
    const hits = vals.filter((v) => v === 'deepseek-v4.1-flash').length
    assert.equal(hits, 1, '同一模型在选择器里只能出现一次：' + JSON.stringify(vals))
  } finally { c.unmount() }
})

test('后端没给 modelsVisible 时，前端回退本地过滤（老后端兼容）', async () => {
  const be = makeBackend({
    settingsModels: [
      { provider: 'codearts', label: 'CodeArts', models: [{ id: 'X-model', name: 'X' }] },
    ],
    settingsModelsVisible: null,
  })
  const c = await mount({ backend: be.backend })
  try {
    await c.start(c.mod.SettingsPage)
    await c.waitFor(() => modelSelect(c), { label: '模型下拉' })
    const vals = optionValues(modelSelect(c))
    assert.ok(vals.includes('X-model'), '老后端（无 modelsVisible）时仍要能列出模型：' + JSON.stringify(vals))
  } finally { c.unmount() }
})
