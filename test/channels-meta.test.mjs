/**
 * cs-myfree — 18 家渠道元数据完整性测试（契约 §5 / §7.7）
 *
 * 防的是「加渠道/改渠道时漏字段」这类静默缺陷：
 *   · 每家必须有 `concurrencyLimit`（正整数）与 `billing ∈ {free,paid}`；
 *   · `billing` 必须与 `audit/pricing.js` 的声明一致（唯一事实来源）；
 *   · `DEFAULT_LIMITS` 从 `CHANNELS` **派生**，实测值原样保留（codearts 1 / kilo 4 / ovh 2 …）；
 *   · officeace：没有硬编模型名，登录后**动态拉取**（华为云临时凭据 ⇒ 签名鉴权）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHANNELS, allChannelIds } from '../src/pools/channels/protocols.js'
import { DEFAULT_LIMITS } from '../src/adapter/concurrency.js'
import { FREE_PROVIDERS, CHANNEL_FREE } from '../src/audit/pricing.js'
import { MODELS_PATH, BUILTIN_MODELS, builtinModelsOf } from '../src/pools/channels/builtin-models.js'
import { fetchChannelModels } from '../src/pools/channels/catalog.js'

const VALID_BILLING = new Set(['free', 'paid'])
const VALID_BILLING_SOURCE = new Set(['measured', 'declared', 'default'])
const VALID_LIMIT_SOURCE = new Set(['measured', 'default'])

test('渠道数量：18 家（遍历 Object.keys，防漏改/误删）', () => {
  const ids = Object.keys(CHANNELS)
  assert.equal(ids.length, 18, `实际 ${ids.length} 家：${ids.join(',')}`)
  assert.deepEqual(allChannelIds(), ids)
  for (const id of ids) {
    assert.equal(CHANNELS[id]?.label?.length > 0, true, `${id} 缺 label`)
  }
})

test('每家都有 concurrencyLimit（正整数）与 billing/billingSource/limitSource', () => {
  for (const id of Object.keys(CHANNELS)) {
    const ch = CHANNELS[id]
    assert.equal(Number.isInteger(ch.concurrencyLimit) && ch.concurrencyLimit > 0, true, `${id}.concurrencyLimit=${ch.concurrencyLimit}`)
    assert.equal(VALID_BILLING.has(ch.billing), true, `${id}.billing=${ch.billing}`)
    assert.equal(VALID_BILLING_SOURCE.has(ch.billingSource), true, `${id}.billingSource=${ch.billingSource}`)
    assert.equal(VALID_LIMIT_SOURCE.has(ch.limitSource), true, `${id}.limitSource=${ch.limitSource}`)
  }
})

test('billing 与 audit/pricing.js 声明一致（唯一事实来源，不许猜厂商计价）', () => {
  for (const id of Object.keys(CHANNELS)) {
    const ch = CHANNELS[id]
    if (ch.billing === 'paid') continue          // 付费渠道必须另有 PRICING 依据，由 pricing 测试覆盖
    if (ch.billingSource === 'declared') {
      assert.equal(
        CHANNEL_FREE.includes(id) || FREE_PROVIDERS.includes(id), true,
        `${id} 标了 declared/free，但 pricing.js 没有声明它免费`,
      )
    }
    // 未知的只能是 free + default（保守：不把未知当付费，也不当已声明的免费）
    if (ch.billingSource === 'default') {
      assert.equal(ch.billing, 'free', `${id}: 推不出时必须是 free（billingSource:'default'）`)
    }
  }
})

test('DEFAULT_LIMITS 从 CHANNELS 派生：每家等于自己的 concurrencyLimit', () => {
  for (const id of Object.keys(CHANNELS)) {
    assert.equal(DEFAULT_LIMITS[id], CHANNELS[id].concurrencyLimit, `${id} 的并发上限必须来自渠道元数据`)
  }
})

test('已实测的并发上限原样保留（codearts 1 / buddy 2 / kilo 4 / ovh 2）', () => {
  assert.equal(DEFAULT_LIMITS.codearts, 1, 'codearts 上游会话不随连接释放 ⇒ 严格串行')
  assert.equal(DEFAULT_LIMITS.buddy, 2)
  assert.equal(DEFAULT_LIMITS.kilo, 4, '免密源按 IP 限流，不该被压成 1')
  assert.equal(DEFAULT_LIMITS.ovh, 2)
  assert.equal(DEFAULT_LIMITS.default, 2, '未登记的 provider 保持旧行为')
  assert.equal(CHANNELS.codearts.limitSource, 'measured')
  assert.equal(CHANNELS.codearts.billing, 'free')
})

test('officeace：不硬编模型名，登录后动态拉取（华为云临时凭据 ⇒ 签名鉴权）', async () => {
  // ① 不硬编模型名：内置清单为空，但声明了模型端点
  assert.equal(MODELS_PATH.officeace, '/v2/models')
  assert.deepEqual(BUILTIN_MODELS.officeace, [])
  assert.deepEqual(builtinModelsOf('officeace'), [])

  // ② 华为云临时凭据（AK/SK/securityToken）⇒ 必须签名，否则请求无 authorization ⇒ 恒 401
  let seen = null
  const r = await fetchChannelModels('officeace', { ak: 'AKID', sk: 'SKID', securityToken: 'STS' }, {
    fetchImpl: async (url, init) => {
      seen = { url, headers: init?.headers ?? {} }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'qwen3-coder-480b', name: 'Qwen3 Coder' }, { id: 'deepseek-v3' }] }),
      }
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.source, 'remote')
  assert.deepEqual(r.models.map((m) => m.id), ['qwen3-coder-480b', 'deepseek-v3'])
  assert.equal(seen.url, 'https://api.modelarts-maas.com/v2/models', '必须打渠道声明的模型端点')
  assert.match(String(seen.headers.authorization), /^SDK-HMAC-SHA256 Access=AKID,/, '必须用 AK/SK 签名')
  assert.equal(seen.headers['x-security-token'], 'STS')

  // ③ 只有 token 的旧凭据 ⇒ 仍走原声明的 Bearer（不破坏手工粘贴 key 的用法）
  let bearer = null
  await fetchChannelModels('officeace', { token: 'tk' }, {
    fetchImpl: async (_url, init) => {
      bearer = init?.headers ?? {}
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm1' }] }) }
    },
  })
  assert.equal(bearer.authorization, 'Bearer tk')

  // ④ 远端失败 ⇒ 不抛错、不硬编兜底（返回空并如实标 source）
  const failed = await fetchChannelModels('officeace', { ak: 'A', sk: 'S' }, {
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  })
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.models, [], '没有内置兜底就不能凭空造模型名')
  assert.match(String(failed.error), /401/)
})
