import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  has, safeCall, detectHostVersion, parseVersion, makeLogger,
  safeEffect, safeInject, safeProvide, safeRegisterAdapter, safeRegisterSearch, guardApply,
} from '../src/compat.js'

test('has 对 null/undefined 返回 false 不抛', () => {
  assert.equal(has(null, 'x'), false)
  assert.equal(has(undefined, 'x'), false)
  assert.equal(has({}, 'x'), false)
  assert.equal(has({ x: () => {} }, 'x'), true)
})
test('has 遇到 getter 抛错也返回 false', () => {
  const o = Object.defineProperty({}, 'x', { get() { throw new Error('boom') } })
  assert.equal(has(o, 'x'), false)
})
test('safeCall 吞异常返回 fallback', () => {
  assert.equal(safeCall(() => { throw new Error('x') }, 'fb'), 'fb')
  assert.equal(safeCall(() => 42, 'fb'), 42)
  assert.equal(safeCall(null, 'fb'), 'fb')
})
test('detectHostVersion 拿不到返回 null', () => {
  assert.equal(detectHostVersion(null), null)
  assert.equal(detectHostVersion({ app: { version: '0.2.1-rc.2' } }), '0.2.1-rc.2')
})
test('parseVersion 解析三版本号', () => {
  assert.deepEqual(parseVersion('0.2.1-rc.2'), [0, 2, 1])
  assert.deepEqual(parseVersion('0.1.0'), [0, 1, 0])
  assert.equal(parseVersion('garbage'), null)
})
test('makeLogger 无 logger 时不抛', () => {
  const l = makeLogger({}, 'test')
  assert.doesNotThrow(() => l.info('x'))
  assert.doesNotThrow(() => l.error('x'))
})
test('makeLogger 优先用宿主 logger', () => {
  const got = []
  const l = makeLogger({ logger: { info: (m) => got.push(m) } }, 't')
  l.info('hello')
  assert.ok(got[0].includes('hello'))
})
test('safeEffect 宿主无 effect 返回 false 不抛', () => {
  assert.equal(safeEffect({}, () => () => {}, 'x'), false)
})
test('safeEffect 宿主 effect 抛错被吞', () => {
  assert.equal(safeEffect({ effect() { throw new Error('x') } }, () => () => {}, 'x'), false)
})
test('safeInject 宿主无 inject 返回 false', () => {
  assert.equal(safeInject({}, ['llm'], () => {}, 'x'), false)
})
test('safeProvide 宿主无 provide 返回 false', () => {
  assert.equal(safeProvide({}, 'k', {}), false)
})
test('safeRegisterAdapter 宿主无方法返回 false', () => {
  assert.equal(safeRegisterAdapter({}, 'id', {}), false)
  assert.equal(safeRegisterAdapter({ registerAdapter: (id) => { throw new Error('x') } }, 'id', {}), false)
})
test('safeRegisterSearch 同上', () => {
  assert.equal(safeRegisterSearch({}, {}), false)
})
test('guardApply：正常路径执行原函数', () => {
  let ran = false
  const f = guardApply(() => { ran = true }, 't')
  f({}, {})
  assert.equal(ran, true)
})
test('guardApply：抛错时绝不 rethrow（关键！）', () => {
  const f = guardApply(() => { throw new Error('应被吞掉') }, 't')
  assert.doesNotThrow(() => f({}, {}))
})
test('guardApply：连 logger 都坏也不抛', () => {
  const f = guardApply(() => { throw new Error('x') }, 't')
  const badCtx = { get logger() { throw new Error('logger boom') } }
  assert.doesNotThrow(() => f(badCtx, {}))
})
test('guardApply：ctx 为 null 也不抛', () => {
  const f = guardApply((c) => { if (!c) throw new Error('no ctx') }, 't')
  assert.doesNotThrow(() => f(null, {}))
})
