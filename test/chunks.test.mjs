/**
 * StreamChunk 契约测试 ——
 * 防「reasoning-delta index must be a non-negative safe integer」回归
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBlockWriter, toHostChunks, usageChunk, finishChunk } from '../src/adapter/chunks.js'

async function collect(iter) { const o = []; for await (const c of iter) o.push(c); return o }

test('🔴 所有带 index 的 chunk 必须是合法非负整数', async () => {
  async function* src() {
    yield { type: 'reasoning-delta', text: '想' }
    yield { type: 'text-delta', text: '答' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const out = await collect(toHostChunks(src()))
  for (const c of out) {
    if ('index' in c) {
      assert.ok(Number.isSafeInteger(c.index), c.type + ' 的 index 必须是 safe integer')
      assert.ok(c.index >= 0, c.type + ' 的 index 必须非负')
    }
  }
})

test('🔴 每个 block 必须有 start → delta → end 完整序列', async () => {
  async function* src() {
    yield { type: 'text-delta', text: 'a' }
    yield { type: 'text-delta', text: 'b' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const out = await collect(toHostChunks(src()))
  const types = out.map((c) => c.type)
  assert.equal(types[0], 'block-start')
  assert.ok(types.includes('text-delta'))
  assert.ok(types.includes('block-end'))
  assert.equal(types.at(-1), 'finish')
})

test('block-end 携带拼装完整的块', async () => {
  async function* src() {
    yield { type: 'text-delta', text: '你' }
    yield { type: 'text-delta', text: '好' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const out = await collect(toHostChunks(src()))
  const end = out.find((c) => c.type === 'block-end')
  assert.deepEqual(end.block, { type: 'text', text: '你好' })
})

test('reasoning 块用 blockType=reasoning', async () => {
  async function* src() {
    yield { type: 'reasoning-delta', text: 'x' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const out = await collect(toHostChunks(src()))
  const start = out.find((c) => c.type === 'block-start')
  assert.equal(start.blockType, 'reasoning')
})

test('文本与 reasoning 各自独立 index（从 0 递增）', async () => {
  async function* src() {
    yield { type: 'reasoning-delta', text: 'r' }
    yield { type: 'text-delta', text: 't' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const out = await collect(toHostChunks(src()))
  const starts = out.filter((c) => c.type === 'block-start')
  assert.equal(starts.length, 2)
  assert.equal(starts[0].index, 0)
  assert.equal(starts[1].index, 1)
})

test('usage 必须在 finish 之前', async () => {
  async function* src() {
    yield { type: 'text-delta', text: 'x' }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const out = await collect(toHostChunks(src()))
  const ui = out.findIndex((c) => c.type === 'usage')
  const fi = out.findIndex((c) => c.type === 'finish')
  assert.ok(ui >= 0 && fi > ui, 'usage 必须在 finish 之前')
})

test('finish 之后不再产出任何 chunk', async () => {
  async function* src() {
    yield { type: 'text-delta', text: 'x' }
    yield { type: 'finish', reason: { kind: 'stop' } }
    yield { type: 'text-delta', text: 'SHOULD-NOT-APPEAR' }
  }
  const out = await collect(toHostChunks(src()))
  assert.equal(JSON.stringify(out).includes('SHOULD-NOT-APPEAR'), false)
  assert.equal(out.at(-1).type, 'finish')
})

test('流意外结束也补全 finish（不让宿主挂住）', async () => {
  async function* src() {
    yield { type: 'text-delta', text: 'x' }
    // 没有 finish
  }
  const out = await collect(toHostChunks(src()))
  assert.equal(out.at(-1).type, 'finish')
})

test('finishChunk 的 reason 形状正确', () => {
  assert.deepEqual(finishChunk('stop'), { type: 'finish', reason: { kind: 'stop' } })
  assert.deepEqual(finishChunk('max-tokens').reason.kind, 'max-tokens')
})

test('usageChunk 只保留数字字段', () => {
  const u = usageChunk({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 })
  assert.equal(u.type, 'usage')
  assert.equal(u.usage.inputTokens, 1)
  assert.equal(u.usage.cacheReadTokens, 3)
})

test('createBlockWriter 的 index 单调递增', () => {
  const w = createBlockWriter()
  assert.equal(w.start('text').index, 0)
  assert.equal(w.start('text').index, 1)
  assert.equal(w.start('reasoning').index, 2)
})

test('closeAll 关闭所有未结束的块', () => {
  const w = createBlockWriter()
  w.start('text')
  w.start('reasoning')
  assert.equal(w.openIndexes.length, 2)
  const closed = w.closeAll()
  assert.equal(closed.length, 2)
  assert.equal(w.openIndexes.length, 0)
})
