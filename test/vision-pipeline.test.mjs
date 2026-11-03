import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageKey, extractImage, preprocessImages, createDescribeCache, describeImage } from '../src/vision/pipeline.js'
import { MODE } from '../src/vision/bridge.js'

test('imageKey 对同一数据稳定', () => {
  assert.equal(imageKey({ data: 'AAA' }), imageKey({ data: 'AAA' }))
})
test('extractImage 支持多种块形状', () => {
  assert.equal(extractImage({ type: 'image', data: 'x', mime: 'image/png' })?.data, 'x')
  assert.ok(extractImage({ type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } })?.data)
  assert.equal(extractImage({ type: 'text' }), null)
})
test('🔴 off 档不出网，只留占位符', async () => {
  let called = false
  const r = await preprocessImages(
    [{ role: 'user', content: [{ type: 'image', data: 'AAA' }] }],
    { mode: MODE.OFF, fetchImpl: async () => { called = true; throw new Error('不该被调用') } },
  )
  assert.equal(called, false, 'off 档绝不能发网络请求')
  assert.equal(r.stats.skipped, 1)
  assert.match(r.messages[0].content[0].text, /未处理/)
})
test('free-cloud 未同意 ⇒ 也不出网', async () => {
  let called = false
  const r = await preprocessImages(
    [{ role: 'user', content: [{ type: 'image', data: 'AAA' }] }],
    { mode: MODE.FREE_CLOUD, consented: false, fetchImpl: async () => { called = true } },
  )
  assert.equal(called, false)
  assert.equal(r.stats.skipped, 1)
})
test('free-cloud 已同意 ⇒ 调视觉模型并替换成文字', async () => {
  const r = await preprocessImages(
    [{ role: 'user', content: [{ type: 'text', text: '这是什么' }, { type: 'image', data: 'AAA' }] }],
    {
      mode: MODE.FREE_CLOUD, consented: true,
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '一张红色图片' } }] }) }),
    },
  )
  assert.equal(r.stats.described, 1)
  assert.equal(r.messages[0].content[1].type, 'text')
  assert.match(r.messages[0].content[1].text, /一张红色图片/)
})
test('同一张图第二次走缓存（不重复出网）', async () => {
  let calls = 0
  const cache = createDescribeCache()
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ choices: [{ message: { content: 'X' } }] }) } }
  const msgs = [{ role: 'user', content: [{ type: 'image', data: 'SAME' }] }]
  await preprocessImages(msgs, { mode: MODE.FREE_CLOUD, consented: true, fetchImpl, cache })
  await preprocessImages(msgs, { mode: MODE.FREE_CLOUD, consented: true, fetchImpl, cache })
  assert.equal(calls, 1, '第二次必须走缓存')
})
test('视觉模型失败时给明确占位，不崩溃', async () => {
  const r = await preprocessImages(
    [{ role: 'user', content: [{ type: 'image', data: 'AAA' }] }],
    { mode: MODE.FREE_CLOUD, consented: true, fetchImpl: async () => ({ ok: false, status: 403 }) },
  )
  assert.equal(r.stats.failed, 1)
  assert.match(r.messages[0].content[0].text, /解析失败/)
})
test('纯文本消息原样透传', async () => {
  const msgs = [{ role: 'user', content: 'hello' }]
  const r = await preprocessImages(msgs, { mode: MODE.OFF })
  assert.equal(r.messages[0].content, 'hello')
  assert.equal(r.stats.images, 0)
})
test('🔴 视觉请求头绝不含 Authorization（免密铁律）', async () => {
  let headers = null
  await describeImage({ data: 'AAA', mime: 'image/png' }, {
    fetchImpl: async (url, init) => { headers = init.headers; return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) } },
  })
  assert.equal(Object.keys(headers).some((k) => /authorization/i.test(k)), false)
})
test('审计只记元数据，不含图片字节', async () => {
  const audits = []
  await preprocessImages(
    [{ role: 'user', content: [{ type: 'image', data: 'SECRET-BASE64-BYTES' }] }],
    {
      mode: MODE.FREE_CLOUD, consented: true,
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }),
      onAudit: (e) => audits.push(e),
    },
  )
  const s = JSON.stringify(audits)
  assert.equal(s.includes('SECRET-BASE64-BYTES'), false)
})
