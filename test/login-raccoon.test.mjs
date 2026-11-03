/**
 * cs-myfree — Raccoon（商汤）扫码登录测试（全 mock）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  startRaccoon, pollRaccoon, generateQrCode, buildQrImageUrl,
  parseRaccoonEnvelope, raccoonJwtExpMs, RACCOON_API_BASE,
  RACCOON_AUTH_PREFIX, RACCOON_QR_STATUS,
} from '../src/pools/channels/login/raccoon.js'
import { getFlow, FLOW_TYPE } from '../src/pools/channels/login/flow-map.js'

test('二维码内容指向公开微信登录页', () => {
  const code = 'a'.repeat(32)
  const url = buildQrImageUrl(code)
  assert.ok(url.startsWith(`${RACCOON_API_BASE}/login/mp?`))
  assert.ok(url.includes(`code=${code}`))
  assert.ok(decodeURIComponent(url).includes('商汤小浣熊官网'))
})

test('qr code 是 32 位小写 hex（16 随机字节）', () => {
  const c = generateQrCode()
  assert.match(c, /^[0-9a-f]{32}$/)
  assert.notEqual(generateQrCode(), c, '每次不同')
})

test('startRaccoon 返回 qr flow + 说明', () => {
  const r = startRaccoon('raccoon', {})
  assert.equal(r.flow, 'qr')
  assert.ok(r.qr.includes('login/mp'))
  assert.ok(r._qrcodeCode.length === 32)
  assert.ok(r.instructions.length >= 2)
})

test('信封解析', () => {
  assert.equal(parseRaccoonEnvelope({ code: 0, data: { status: 'pending' } }).code, 0)
  assert.equal(parseRaccoonEnvelope(null), null)
  assert.equal(parseRaccoonEnvelope({ msg: 'x' }).data, undefined)
})

test('JWT exp 解析：非法返回 undefined（不当作过期）', () => {
  assert.equal(raccoonJwtExpMs(''), undefined)
  assert.equal(raccoonJwtExpMs('not-a-jwt'), undefined)
  const p = Buffer.from(JSON.stringify({ exp: 1793700000 })).toString('base64url')
  assert.equal(raccoonJwtExpMs(`h.${p}.s`), 1793700000000)
})

test('poll：pending 状态 ⇒ waiting', async () => {
  const s = { _qrcodeCode: 'abc', _attempts: 0 }
  const r = await pollRaccoon(s, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: 0, data: { status: 'pending' } }) }),
  })
  assert.equal(r.state, 'waiting')
})

test('poll：logging（已扫码待确认）⇒ waiting 且提示明确', async () => {
  const s = { _qrcodeCode: 'abc', _attempts: 0 }
  const r = await pollRaccoon(s, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: 0, data: { status: 'logging' } }) }),
  })
  assert.equal(r.state, 'waiting')
  assert.match(r.hint, /已扫码/)
})

test('poll：canceled ⇒ 可读错误', async () => {
  const s = { _qrcodeCode: 'abc', _attempts: 0 }
  const r = await pollRaccoon(s, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: 0, data: { status: 'canceled' } }) }),
  })
  assert.equal(r.state, 'error')
  assert.match(r.error, /取消/)
})

test('poll：success 且带 token ⇒ ok', async () => {
  const s = { _qrcodeCode: 'abc', _attempts: 0 }
  const r = await pollRaccoon(s, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ code: 0, data: { status: 'success', access_token: 'AT', refresh_token: 'RT' } }),
    }),
  })
  assert.equal(r.state, 'ok')
  assert.equal(r.credential.token, 'AT')
  assert.equal(r.credential.refreshToken, 'RT')
})

test('poll：success 但缺 token ⇒ 视为未完成（不产出空凭据）', async () => {
  const s = { _qrcodeCode: 'abc', _attempts: 0 }
  const r = await pollRaccoon(s, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: 0, data: { status: 'success' } }) }),
  })
  assert.equal(r.state, 'waiting', '不能因为 status=success 就给空凭据')
})

test('poll：网络异常 / 畸形响应 / 未知状态 一律 pending（不中断）', async () => {
  for (const impl of [
    async () => { throw new Error('ECONNRESET') },
    async () => ({ ok: false, status: 500 }),
    async () => ({ ok: true, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({ code: 0, data: { status: 'weird' } }) }),
  ]) {
    const s = { _qrcodeCode: 'abc', _attempts: 0 }
    const r = await pollRaccoon(s, { fetchImpl: impl })
    assert.equal(r.state, 'waiting')
  }
})

test('poll：缺二维码 / 超时上限', async () => {
  assert.equal((await pollRaccoon({}, { fetchImpl: async () => ({}) })).state, 'error')
  const s = { _qrcodeCode: 'abc', _attempts: 500 }
  assert.equal((await pollRaccoon(s, { fetchImpl: async () => ({}) })).state, 'error')
})

test('flow-map：raccoon 走真实现', () => {
  const f = getFlow('raccoon', null)
  assert.equal(f.type, FLOW_TYPE.QR)
  assert.equal(typeof f.start, 'function')
  assert.equal(typeof f.poll, 'function')
})
