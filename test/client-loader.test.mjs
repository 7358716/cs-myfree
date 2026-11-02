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
  assert.equal(registered[0].desc.label(), '免费模型')
  assert.equal(typeof registered[0].Component, 'function', '第二个参数必须是组件')
})

test('组件能渲染出 12 个区', () => {
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
  for (let i = 1; i <= 12; i++) assert.ok(json.includes(`W${i}`), `缺少 W${i}`)
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

test('导出的 ZONES 必须是 12 个（主管要求的 12 区）', () => {
  const { decl } = loadClient('src/client.js')
  const mod = decl.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error('unexpected ' + id)
  })
  assert.equal(mod.ZONES.length, 12)
  const ids = mod.ZONES.map((z) => z.id)
  for (let i = 1; i <= 12; i++) assert.ok(ids.includes('W' + i), '缺少 W' + i)
})
