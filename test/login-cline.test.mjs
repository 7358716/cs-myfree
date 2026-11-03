/**
 * cs-myfree — Cline 设备码登录（WorkOS）测试
 * 全 mock，不联网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  startCline, pollCline, parseClineDeviceAuthorization, parseClineTokenPayload,
  CLINE_WORKOS_BASE, CLINE_DEVICE_AUTHORIZATION_PATH, CLINE_DEVICE_AUTHENTICATE_PATH,
  CLINE_WORKOS_CLIENT_ID,
} from '../src/pools/channels/login/cline.js'
import { getFlow, FLOW_TYPE } from '../src/pools/channels/login/flow-map.js'

const AUTH_OK = {
  device_code: 'DEV-1', user_code: 'ABCD-EFGH',
  verification_uri: 'https://authkit.cline.bot/device',
  verification_uri_complete: 'https://authkit.cline.bot/device?user_code=ABCD-EFGH',
  expires_in: 600, interval: 5,
}

test('设备码响应解析：字段齐全才有效', () => {
  const a = parseClineDeviceAuthorization(AUTH_OK)
  assert.equal(a.deviceCode, 'DEV-1')
  assert.equal(a.userCode, 'ABCD-EFGH')
  assert.equal(a.verificationUriComplete, AUTH_OK.verification_uri_complete)
  assert.equal(a.expiresInSec, 600)
  assert.equal(a.intervalSec, 5)
  // 缺任一必需字段 ⇒ null
  assert.equal(parseClineDeviceAuthorization({ device_code: 'D', user_code: 'U' }), null)
  assert.equal(parseClineDeviceAuthorization(null), null)
})

test('startCline：向 WorkOS 申请设备码并返回人读码 + 授权页', async () => {
  let seenUrl = ''
  let seenBody = ''
  const r = await startCline('cline', {}, {
    fetchImpl: async (url, init) => {
      seenUrl = url
      seenBody = String(init.body)
      return { ok: true, status: 200, json: async () => AUTH_OK }
    },
  })
  assert.equal(seenUrl, `${CLINE_WORKOS_BASE}${CLINE_DEVICE_AUTHORIZATION_PATH}`)
  assert.ok(seenBody.includes(`client_id=${CLINE_WORKOS_CLIENT_ID}`), '必须带 client_id')
  assert.equal(r.flow, 'device')
  assert.equal(r.userCode, 'ABCD-EFGH')
  assert.ok(r.url.includes('user_code=ABCD-EFGH'), '优先用 verification_uri_complete')
  assert.equal(r.interval, 5)
  assert.ok(r._deviceCode, '必须持有 device_code 供轮询')
  assert.ok(Array.isArray(r.instructions) && r.instructions.length > 0)
})

test('startCline：网络失败 ⇒ 诚实降级（不编造设备码）', async () => {
  const r = await startCline('cline', {}, { fetchImpl: async () => { throw new Error('ENOTFOUND') } })
  assert.equal(r.userCode, null)
  assert.equal(r.url, null)
  assert.ok(r._startError && r._startError.includes('无法连接'))
})

test('startCline：HTTP 4xx ⇒ 诚实降级', async () => {
  const r = await startCline('cline', {}, { fetchImpl: async () => ({ ok: false, status: 403 }) })
  assert.equal(r.userCode, null)
  assert.match(r._startError, /403/)
})

test('startCline：响应格式异常 ⇒ 诚实降级', async () => {
  const r = await startCline('cline', {}, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) })
  assert.equal(r.userCode, null)
  assert.match(r._startError, /缺少必要字段/)
})

test('pollCline：authorization_pending ⇒ waiting（不是 error）', async () => {
  const s = { _deviceCode: 'D', _expiresAtMs: Date.now() + 60000 }
  const r = await pollCline(s, {
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'authorization_pending' }) }),
  })
  assert.equal(r.state, 'waiting')
})

test('pollCline：slow_down ⇒ 退避但仍 waiting', async () => {
  const s = { _deviceCode: 'D', _expiresAtMs: Date.now() + 60000, _intervalMs: 5000 }
  const r = await pollCline(s, {
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'slow_down' }) }),
  })
  assert.equal(r.state, 'waiting')
  assert.ok(s._intervalMs > 5000, '必须累积退避')
})

test('pollCline：access_denied / expired_token / invalid_grant ⇒ error', async () => {
  for (const code of ['access_denied', 'expired_token', 'invalid_grant']) {
    const s = { _deviceCode: 'D', _expiresAtMs: Date.now() + 60000 }
    const r = await pollCline(s, {
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: code, error_description: 'x' }) }),
    })
    assert.equal(r.state, 'error', `${code} 必须是终态`)
  }
})

test('pollCline：成功换 Cline token（信封 {success,data}）', async () => {
  const s = { _deviceCode: 'D', _expiresAtMs: Date.now() + 60000 }
  let calls = 0
  const r = await pollCline(s, {
    fetchImpl: async (url) => {
      calls++
      if (url.includes('/user_management/authenticate')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'WA', refresh_token: 'WR' }) }
      }
      // register
      return { ok: true, status: 200, json: async () => ({ success: true, data: { accessToken: 'CA', refreshToken: 'CR', expiresAt: Date.now() + 3600_000 } }) }
    },
  })
  assert.equal(r.state, 'ok')
  assert.equal(r.credential.token, 'CA', '应优先用 Cline 自己的 token')
  assert.equal(r.credential.refreshToken, 'CR')
  assert.equal(calls, 2)
})

test('pollCline：注册失败时退回 WorkOS token 并诚实标注', async () => {
  const s = { _deviceCode: 'D', _expiresAtMs: Date.now() + 60000 }
  const r = await pollCline(s, {
    fetchImpl: async (url) => {
      if (url.includes('/user_management/authenticate')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'WA', refresh_token: 'WR' }) }
      }
      return { ok: false, status: 500, json: async () => ({}) }
    },
  })
  assert.equal(r.state, 'ok')
  assert.equal(r.credential.token, 'WA')
  assert.match(r.hint, /未完成 Cline 注册/)
})

test('pollCline：设备码过期 ⇒ error', async () => {
  const s = { _deviceCode: 'D', _expiresAtMs: Date.now() - 1000 }
  const r = await pollCline(s, { fetchImpl: async () => ({ ok: false, status: 400 }) })
  assert.equal(r.state, 'error')
  assert.match(r.error, /过期/)
})

test('pollCline：缺 device_code ⇒ error', async () => {
  const r = await pollCline({}, { fetchImpl: async () => ({ ok: false, status: 400 }) })
  assert.equal(r.state, 'error')
})

test('pollCline：连续网络失败超过上限 ⇒ error', async () => {
  const s = { _deviceCode: 'D', _expiresAtMs: Date.now() + 600000 }
  let last = null
  for (let i = 0; i < 8; i++) {
    last = await pollCline(s, { fetchImpl: async () => { throw new Error('ECONNRESET') } })
  }
  assert.equal(last.state, 'error')
})

test('flow-map：cline 走真实现', () => {
  const f = getFlow('cline', null)
  assert.equal(f.type, FLOW_TYPE.DEVICE)
  assert.equal(typeof f.start, 'function')
  assert.equal(typeof f.poll, 'function')
})
