import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSse } from '../src/index.js'

function streamOf(text) {
  const buf = new TextEncoder().encode(text)
  return (async function* () { yield buf })()
}
async function collect(it) { const o = []; for await (const c of it) o.push(c); return o }

test('解析 text-delta', async () => {
  const s = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n'
  const r = await collect(parseSse(streamOf(s)))
  assert.equal(r.length, 1)
  assert.equal(r[0].text, '你好')
})

test('解析 reasoning-delta（与正文区分）', async () => {
  const s = 'data: {"choices":[{"delta":{"reasoning_content":"想想"}}]}\n'
  const r = await collect(parseSse(streamOf(s)))
  assert.equal(r[0].type, 'reasoning-delta')
})

test('[DONE] 终止解析', async () => {
  const s = 'data: {"choices":[{"delta":{"content":"a"}}]}\ndata: [DONE]\ndata: {"choices":[{"delta":{"content":"b"}}]}\n'
  const r = await collect(parseSse(streamOf(s)))
  assert.equal(r.length, 1, 'DONE 之后不再产出')
})

test('忽略非 data 行与坏 JSON', async () => {
  const s = ': heartbeat\n\ndata: not-json\n'
  const r = await collect(parseSse(streamOf(s)))
  assert.equal(r.length, 0)
})
