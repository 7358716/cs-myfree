/**
 * 运行时流式回归 —— 「说到一半停/总截断」的根因测试
 *
 * 🔴 曾经的缺陷（362 个用例全绿也漏掉的洞）：
 *    adapter.stream() 的提交点缓冲循环只搬 `released`，
 *    而 createHeld().push 在**已提交后**返回 { committed:true, chunk, released:[] }
 *    ⇒ 第一个可见增量之后的所有增量全部丢失。
 *
 * 本文件用「源产出 N 个增量，adapter 必须 1:1 全部吐出」来钉死它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAdapter } from '../src/adapter/index.js'

async function collect(iter) { const o = []; for await (const c of iter) o.push(c); return o }
const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')

const CHAIN = [{ provider: 'kilo', model: 'kilo-auto/free', tier: 1 }]

test('🔴 提交点之后的增量不得丢失（50 个 text-delta 全量到达）', async () => {
  const parts = Array.from({ length: 50 }, (_, i) => `片段${i}；`)
  const expected = parts.join('')

  const a = createAdapter({
    builtin: CHAIN,
    send: async () => (async function* () {
      yield { type: 'reasoning-delta', text: '先想' }
      yield { type: 'reasoning-delta', text: '一下' }
      for (const p of parts) yield { type: 'text-delta', text: p }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  })

  const out = await collect(a.stream({ model: 'kilo-auto/free', messages: [] }))

  assert.equal(out.filter((c) => c.type === 'text-delta').length, 50, '每个增量都必须到达调用方')
  assert.equal(textOf(out), expected, '拼接文本必须与源完全一致')
  const end = out.find((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.ok(end, '必须有 text 块结束')
  assert.equal(end.block.text, expected, 'block-end 携带完整文本')
  assert.equal(out.at(-1).type, 'finish')
  assert.equal(out.at(-1).reason.kind, 'stop')
})

test('提交点之前的 reasoning 在成功路径下保留为 reasoning 块（不丢内容）', async () => {
  const a = createAdapter({
    builtin: CHAIN,
    send: async () => (async function* () {
      yield { type: 'reasoning-delta', text: '思考中' }
      yield { type: 'text-delta', text: '答案' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  })
  const out = await collect(a.stream({ model: 'kilo-auto/free', messages: [] }))
  assert.equal(out.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join(''), '思考中')
  assert.equal(textOf(out), '答案')
})

test('失败候选切源后：只输出胜出候选的内容（缓冲不泄漏）', async () => {
  const a = createAdapter({
    builtin: [
      { provider: 'bad', model: 'm1', tier: 1 },
      { provider: 'good', model: 'm2', tier: 2 },
    ],
    send: async ({ provider }) => {
      if (provider === 'bad') {
        return (async function* () {
          yield { type: 'reasoning-delta', text: '坏源的思考' }
          throw Object.assign(new Error('boom'), { status: 500 })
        })()
      }
      return (async function* () {
        yield { type: 'text-delta', text: '好源答案' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  })
  const out = await collect(a.stream({ model: 'm1', messages: [] }))
  assert.equal(textOf(out), '好源答案')
  assert.equal(JSON.stringify(out).includes('坏源的思考'), false)
})

test('长文本 + usage：usage 在 finish 之前、文本一字不少', async () => {
  const a = createAdapter({
    builtin: CHAIN,
    send: async () => (async function* () {
      yield { type: 'text-delta', text: 'A'.repeat(300) }
      yield { type: 'text-delta', text: 'B'.repeat(300) }
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 600 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  })
  const out = await collect(a.stream({ model: 'kilo-auto/free', messages: [] }))
  assert.equal(textOf(out), 'A'.repeat(300) + 'B'.repeat(300))
  const ui = out.findIndex((c) => c.type === 'usage')
  const fi = out.findIndex((c) => c.type === 'finish')
  assert.ok(ui >= 0 && fi > ui, 'usage 必须在 finish 之前')
})
