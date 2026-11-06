/**
 * 客户端插件加载测试 —— 模拟宿主的 window.__ModuleLoader__
 *
 * 这是「设置页能不能出现」的关键验证：
 * 若 client.js 不是 __ModuleLoader__.load 格式，或 exports.apply 缺失，
 * 设置页会**静默不出现**（本机踩过这个坑）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/** 假 react（够用即可） */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
  useState: (init) => [init, () => {}],
  useEffect: () => {},
  // ErrorBoundary 需要继承 Component
  Component: class {
    constructor(props) { this.props = props || {}; this.state = {} }
    setState(s) { this.state = Object.assign({}, this.state, typeof s === 'function' ? s(this.state) : s) }
  },
}

/** 执行 client.js，返回被 ModuleLoader 收到的声明 */
function loadClient(file) {
  const src = readFileSync(file, 'utf8')
  let captured = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (decl) => { captured = decl },
      },
    },
    console,
    Symbol,
    Object,
    Array,
    JSON,
    Error,
  }
  sandbox.globalThis = sandbox
  const requireStub = (id) => {
    if (id === 'react') return fakeReact
    if (id === 'react/jsx-runtime') return { jsx: fakeReact.createElement, jsxs: fakeReact.createElement }
    throw new Error(`unexpected require: ${id}`)
  }
  const fn = new Function('window', 'console', 'Symbol', 'Object', 'Array', 'JSON', 'Error', src)
  fn(sandbox.window, console, Symbol, Object, Array, JSON, Error)
  return { decl: captured, requireStub }
}

test('client.js 必须是 __ModuleLoader__.load 格式（不是裸 ESM）', () => {
  const { decl } = loadClient('src/client.js')
  assert.ok(decl, '必须调用 window.__ModuleLoader__.load')
  assert.equal(decl.id, 'cs-myfree', 'id 必须是包名')
  assert.equal(typeof decl.factory, 'function', 'factory 必须是函数')
})

test('factory 必须导出 apply 与 inject', () => {
  const { decl } = loadClient('src/client.js')
  const mod = decl.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error('unexpected ' + id)
  })
  assert.equal(typeof mod.apply, 'function', 'apply 缺失 ⇒ 设置页不出现')
  assert.ok(Array.isArray(mod.inject), 'inject 必须是数组')
  assert.ok(mod.inject.includes('slots'), '必须声明需要 slots 服务')
})

test('apply 会注册 settings.section', () => {
  const { decl } = loadClient('src/client.js')
  const mod = decl.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error('unexpected ' + id)
  })

  const registered = []
  const ctx = {
    slots: {
      inject: (slotName, factory) => {
        assert.equal(slotName, 'settings.section')
        factory()
      },
      register: (desc, Component) => { registered.push({ desc, Component }); return () => {} },
    },
  }
  mod.apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].desc.id, 'cs-myfree')
  assert.equal(typeof registered[0].desc.label, 'function', 'label 必须是函数')
  assert.equal(registered[0].desc.label(), 'Myfree')
  assert.equal(typeof registered[0].Component, 'function', '第二个参数必须是组件')
})

test('组件能渲染出 5 个区（design/21 §1）', () => {
  const { decl } = loadClient('src/client.js')
  const mod = decl.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error('unexpected ' + id)
  })
  let captured = []
  const ctx = {
    slots: {
      inject: (n, f) => f(),
      register: (d, C) => { captured.push(C); return () => {} },
    },
  }
  mod.apply(ctx)
  const tree = captured[0]()
  const json = JSON.stringify(tree, (k, v) => (typeof v === 'function' ? '[fn]' : v))
  assert.ok(json.includes('总览'), '缺少总览标签')
  assert.ok(json.includes('供给源'), '缺少供给源标签')
  assert.ok(json.includes('模型与路由'), '缺少模型与路由标签')
  assert.ok(json.includes('设置'), '缺少设置标签')
  // 旧的 12 个分区标签不得再出现在 tab 行（ZONES 只 5 区）
  for (const old of ['W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11', 'W12']) {
    assert.equal(json.includes(`title:"${old}"`), false, '旧分区 ' + old + ' 不应再进 ZONES')
  }
})

test('apply 在 slots 缺失时不抛（防白屏）', () => {
  const { decl } = loadClient('src/client.js')
  const mod = decl.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error('unexpected ' + id)
  })
  assert.doesNotThrow(() => mod.apply({}))
  assert.doesNotThrow(() => mod.apply(null))
})

test('apply 在 register 抛错时也不抛（防白屏）', () => {
  const { decl } = loadClient('src/client.js')
  const mod = decl.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error('unexpected ' + id)
  })
  assert.doesNotThrow(() => mod.apply({
    slots: { inject: (n, f) => f(), register: () => { throw new Error('boom') } },
  }))
})

test('ZONES 必须是 5 区（总览/供给源/模型与路由/设置；design/21 §1）', () => {
  const { decl } = loadClient('src/client.js')
  const mod = decl.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error('unexpected ' + id)
  })
  assert.equal(mod.ZONES.length, 4, '总览/供给源/模型与路由/设置 四区（W4 预留不占位）')
  const keys = mod.ZONES.map((z) => z.key)
  assert.deepEqual(keys, ['overview', 'sources', 'models', 'settings'], '四区键必须与 design/21 §1 一致')
  const ids = mod.ZONES.map((z) => z.id)
  assert.equal(ids[0], 'W0')
  assert.deepEqual(ids, ['W0', 'W1', 'W2', 'W3'])
  // 旧 14 区组件源码必须保留（防回归），只是不再进 ZONES
  const names = ['ChainZone', 'PinZone', 'HealthZone', 'PolicyZone', 'BudgetZone', 'SaverZone', 'ObserveZone', 'IoZone', 'ScopeZone', 'DiagZone']
  for (const n of names) assert.equal(typeof mod[n], 'function', n + ' 源码必须保留（design/21 §6）')
  assert.equal(typeof mod.ModelsZone, 'function', '新增模型与路由组件')
  assert.equal(typeof mod.SettingsZone, 'function', '设置页新名（= SettingsPage 改造）')
})

test('apply 同时注册设置页与余额 chip（两个槽位）', () => {
  const { decl } = loadClient('src/client.js')
  const mod = decl.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error('unexpected ' + id)
  })
  const slots = []
  const ctx = {
    slots: {
      inject: (name, f) => { f() },
      register: (desc, C) => { slots.push({ desc, C }); return () => {} },
    },
  }
  mod.apply(ctx)
  const names = slots.map((s) => s.desc.name)
  assert.ok(names.includes('settings.section'), '必须有设置页')
  assert.ok(names.includes('sidebar.footer.action'), '必须有余额 chip')
})

test('余额 chip 的 id 与 order 正确', () => {
  const { decl } = loadClient('src/client.js')
  const mod = decl.factory((id) => (id === 'react' ? fakeReact : null))
  const slots = []
  mod.apply({
    slots: { inject: (n, f) => f(), register: (d, C) => { slots.push(d); return () => {} } },
  })
  const chip = slots.find((d) => d.name === 'sidebar.footer.action')
  assert.equal(chip.id, 'cs-myfree-cash')
  assert.equal(chip.order, 40)
})

test('CashChip 组件已导出', () => {
  const { decl } = loadClient('src/client.js')
  const mod = decl.factory((id) => (id === 'react' ? fakeReact : null))
  assert.equal(typeof mod.CashChip, 'function')
})

test('无 sidebar.footer.action 槽位时不影响设置页', () => {
  const { decl } = loadClient('src/client.js')
  const mod = decl.factory((id) => (id === 'react' ? fakeReact : null))
  let settingsRegistered = 0
  const ctx = {
    slots: {
      inject: (name, f) => {
        if (name === 'sidebar.footer.action') throw new Error('slot not found')
        f()
      },
      register: (d) => { if (d.name === 'settings.section') settingsRegistered++; return () => {} },
    },
  }
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(settingsRegistered, 1, '设置页仍应注册成功')
})

/** 深度遍历构造出来的元素树，收集所有 element.type */
function collectTypes(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.type) out.push(node.type)
  const kids = node.children
  if (Array.isArray(kids)) for (const k of kids) {
    if (Array.isArray(k)) for (const kk of k) collectTypes(kk, out)
    else collectTypes(k, out)
  }
  return out
}

test('设置页必须包含余额卡片（不能被漏掉）', () => {
  const { decl } = loadClient('src/client.js')
  const mod = decl.factory((id) => (id === 'react' ? fakeReact : null))
  let Section = null
  mod.apply({
    slots: { inject: (n, f) => f(), register: (d, C) => { if (d.name === 'settings.section') Section = C; return () => {} } },
  })
  assert.ok(Section, '设置页组件必须注册')
  const tree = Section()
  const types = collectTypes(tree)
  assert.ok(types.includes(mod.CashCard), '设置页必须渲染 CashCard 元素')
})

test('CashCard 自身能渲染出「DeepSeek 账户余额」', () => {
  const { decl } = loadClient('src/client.js')
  const mod = decl.factory((id) => (id === 'react' ? fakeReact : null))
  // 只验证组件骨架包含该文案：用假 hooks 让 useEffect 不执行副作用
  const realUseState = fakeReact.useState
  const realUseEffect = fakeReact.useEffect
  fakeReact.useState = (init) => [init, () => {}]
  fakeReact.useEffect = () => {}
  try {
    const tree = mod.CashCard()
    const json = JSON.stringify(tree, (k, v) => (typeof v === 'function' ? '[fn]' : v))
    assert.ok(json.includes('DeepSeek 账户余额'), '卡片必须显示标题')
  } finally {
    fakeReact.useState = realUseState
    fakeReact.useEffect = realUseEffect
  }
})

test('余额卡片与 chip 都导出了', () => {
  const { decl } = loadClient('src/client.js')
  const mod = decl.factory((id) => (id === 'react' ? fakeReact : null))
  assert.equal(typeof mod.CashCard, 'function')
  assert.equal(typeof mod.CashChip, 'function')
  assert.equal(typeof mod.MyfreeSection, 'function')
})

// ── 白屏防护（v1.1.0 实际故障）──
test('🔴 所有 style 必须是对象，不能是字符串（否则 React 崩溃白屏）', () => {
  const src = readFileSync('src/client.js', 'utf8')
  // 抓 `style: S.xxx + ''` 这类写法
  const bad = src.match(/style:\s*S\.\w+\s*\+\s*''/g)
  assert.equal(bad, null, '存在 style 字符串写法：' + JSON.stringify(bad))
})

test('🔴 不允许把样式属性写在 props 顶层（marginTop 等）', () => {
  const src = readFileSync('src/client.js', 'utf8')
  const bad = src.match(/style:\s*S\.\w+\([^)]*\),\s*(marginTop|marginBottom|padding|width|height)/g)
  assert.equal(bad, null, '存在顶层样式 prop：' + JSON.stringify(bad))
})

test('存在 ErrorBoundary 且主视图被包裹（防整页白屏）', () => {
  const { decl } = loadClient('src/client.js')
  const mod = decl.factory((id) => (id === 'react' ? fakeReact : null))
  assert.equal(typeof mod.ErrorBoundary, 'function', '必须导出 ErrorBoundary')
  assert.equal(typeof mod.Safe, 'function', '必须导出 Safe 包装器')
})

test('ErrorBoundary 渲染出错时显示错误信息而非抛穿', () => {
  const { decl } = loadClient('src/client.js')
  const mod = decl.factory((id) => (id === 'react' ? fakeReact : null))
  const EB = mod.ErrorBoundary
  // 伪造实例：直接调 getDerivedStateFromError + render
  const state = EB.getDerivedStateFromError(new Error('boom'))
  assert.equal(state.error.message, 'boom')
  const inst = { state, props: { children: 'x' } }
  const tree = EB.prototype.render.call(inst)
  const json = JSON.stringify(tree, (k, v) => (typeof v === 'function' ? '[fn]' : v))
  assert.ok(json.includes('渲染失败'), '必须显示友好错误')
  assert.ok(json.includes('boom'), '必须显示原始错误信息')
})

test('主设置页必须把当前 Tab 包进 Safe，且带上 tab 作为 key（切分区重置错误边界）', () => {
  const src = readFileSync('src/client.js', 'utf8')
  // v1.7.1：Safe 额外接收 scope（= 当前 tab），用于 key 重建 ErrorBoundary；
  // 否则一个分区渲染崩了，错误边界状态会一直留着，其它分区也全变错误页。
  assert.match(src, /h\(Safe,\s*\{[^)]*?View:\s*View[^)]*?\}\)/, '视图必须被 Safe 包裹')
  assert.match(src, /h\(Safe,\s*\{[^)]*?scope:\s*tab[^)]*?\}\)/, 'Safe 必须带 scope=当前 tab')
  assert.match(src, /h\(ErrorBoundary,\s*\{\s*key:\s*props\.scope/, 'ErrorBoundary 必须用 scope 做 key')
})
