/**
 * cs-myfree — 账本**分账**测试（契约 §3 记账分账）
 *
 * 要证明的事：
 *   1. 每条新记录都落 `billingTier` + `billing`（非法/缺失 ⇒ 'unknown'，绝不默认 free_only）
 *   2. `readSpend().byBillingTier` 三个桶恒存在，能区分 free_only / paid_allowed / unknown
 *   3. 历史行（无这两个字段）归 'unknown'，**不计入 paid 占比的分子/分母**
 *   4. 空账本也返回同样的结构（调用方不用判空）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, appendFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendRecord, readSpend, ledgerFile, ledgerDir, normalizeLedgerTier, normalizeLedgerBilling, collectLedger,
} from '../src/audit/sources.js'

async function tmpHome() {
  return await mkdtemp(join(tmpdir(), 'cs-myfree-ledger-'))
}

test('归一化：非法/缺失 ⇒ unknown（不默认 free_only）', () => {
  assert.equal(normalizeLedgerTier('paid_allowed'), 'paid_allowed')
  assert.equal(normalizeLedgerTier('FREE_ONLY'), 'free_only')
  assert.equal(normalizeLedgerTier(undefined), 'unknown')
  assert.equal(normalizeLedgerTier('weird'), 'unknown')
  assert.equal(normalizeLedgerBilling('paid'), 'paid')
  assert.equal(normalizeLedgerBilling('free'), 'free')
  assert.equal(normalizeLedgerBilling(null), 'unknown')
  assert.equal(normalizeLedgerBilling('0'), 'unknown')
})

test('每条新记录都落 billingTier + billing（含非法值兜底）', async () => {
  const home = await tmpHome()
  try {
    await appendRecord({ at: 1_700_000_000_000, provider: 'p', model: 'm', paid: true, cost: 0.1, billingTier: 'paid_allowed', billing: 'paid' }, { dshHome: home })
    await appendRecord({ at: 1_700_000_001_000, provider: 'p', model: 'm', paid: false, cost: 0, billingTier: 'free_only', billing: 'free' }, { dshHome: home })
    await appendRecord({ at: 1_700_000_002_000, provider: 'p', model: 'm', billingTier: 'bogus', billing: 'bogus' }, { dshHome: home })
    const raw = await readFile(ledgerFile(home), 'utf8')
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(lines.length, 3)
    assert.equal(lines.every((l) => 'billingTier' in l && 'billing' in l), true, '每条都必须带分账字段')
    assert.equal(lines[0].billingTier, 'paid_allowed')
    assert.equal(lines[0].billing, 'paid')
    assert.equal(lines[1].billingTier, 'free_only')
    assert.equal(lines[2].billingTier, 'unknown', '非法值必须退化为 unknown，不能猜成 free_only')
    assert.equal(lines[2].billing, 'unknown')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('byBillingTier 聚合：三桶齐全 + 历史行进 unknown，不污染 paid 占比', async () => {
  const home = await tmpHome()
  try {
    // 两条历史行（旧版本写的：没有分账字段）
    await mkdir(ledgerDir(home), { recursive: true, mode: 0o700 })
    const legacy = [
      { at: 1_700_000_000_000, day: '2026-11-01', provider: 'old', model: 'm0', in: 1, out: 1, cost: 0.5, paid: true, ok: true, code: null, ms: 100 },
      { at: 1_700_000_001_000, day: '2026-11-01', provider: 'old', model: 'm0', in: 1, out: 1, cost: 0, paid: false, ok: true, code: null, ms: 100 },
    ]
    await appendFile(ledgerFile(home), legacy.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })

    // 新记录：free_only 下 2 次免费、paid_allowed 下 1 次付费
    await appendRecord({ at: 1_700_000_010_000, provider: 'a', model: 'm1', cost: 0, paid: false, ok: true, billingTier: 'free_only', billing: 'free' }, { dshHome: home })
    await appendRecord({ at: 1_700_000_011_000, provider: 'b', model: 'm2', cost: 0, paid: false, ok: true, billingTier: 'free_only', billing: 'free' }, { dshHome: home })
    await appendRecord({ at: 1_700_000_012_000, provider: 'c', model: 'm3', cost: 0.25, paid: true, ok: true, billingTier: 'paid_allowed', billing: 'paid' }, { dshHome: home })

    const sp = await readSpend({ dshHome: home })
    assert.equal(sp.total, 5)
    for (const k of ['free_only', 'paid_allowed', 'unknown']) {
      assert.ok(sp.byBillingTier[k], `桶 ${k} 必须存在`)
    }
    assert.equal(sp.byBillingTier.free_only.calls, 2)
    assert.equal(sp.byBillingTier.free_only.paidCalls, 0)
    assert.equal(sp.byBillingTier.paid_allowed.calls, 1)
    assert.equal(sp.byBillingTier.paid_allowed.paidCalls, 1)
    assert.equal(sp.byBillingTier.paid_allowed.costCNY, 0.25)
    assert.equal(sp.byBillingTier.unknown.calls, 2, '历史行归 unknown')
    assert.equal(sp.byBillingTier.unknown.paidCalls, 1, '历史行的 paid 仍在 unknown 桶里如实计数')

    // 口径：paid 占比的分母只算带授权标签的记录（2 + 1 = 3），unknown 的 2 条不进分子/分母
    assert.equal(sp.billingSplit.knownCalls, 3)
    assert.equal(sp.billingSplit.unknownCalls, 2)
    assert.equal(sp.billingSplit.paidCallsOfKnown, 1)
    assert.equal(sp.billingSplit.paidShareOfKnown, Number((1 / 3).toFixed(4)))
    assert.match(sp.billingSplit.formula, /unknown 不计入/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('空账本：结构一致（三桶为 0、占比 null），不抛错', async () => {
  const home = await tmpHome()
  try {
    const sp = await readSpend({ dshHome: home })
    assert.equal(sp.ok, true)
    assert.equal(sp.empty, true)
    assert.equal(sp.byBillingTier.free_only.calls, 0)
    assert.equal(sp.byBillingTier.paid_allowed.calls, 0)
    assert.equal(sp.byBillingTier.unknown.calls, 0)
    assert.equal(sp.billingSplit.paidShareOfKnown, null)
    const lg = await collectLedger({ dshHome: home })
    assert.equal(lg.ok, true)
    assert.ok(lg.spend.byBillingTier, 'collectLedger 要把分账透传给 /ledger')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('adapter → 账本端到端：paid 授权下的付费调用在 paid_allowed 桶，免费调用在 free_only 桶', async () => {
  const home = await tmpHome()
  try {
    const { createAdapter } = await import('../src/adapter/index.js')
    const { createHintRegistry } = await import('../src/adapter/routing-hints.js')
    const { createConcurrencyGate } = await import('../src/adapter/concurrency.js')
    const reg = createHintRegistry()
    reg.set('sess-ledger', { billing_tier: 'paid_allowed', source: 'test', at: Date.now() })
    const adapter = createAdapter({
      builtin: [{ provider: 'paid-src', model: 'paid-1', tier: 1, paid: true }],
      send: async () => (async function* () {
        yield { type: 'text-delta', text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' }, usage: { inputTokens: 10, outputTokens: 5 } }
      })(),
      concurrency: createConcurrencyGate({ limits: { 'paid-src': 2, default: 2 } }),
      routingHints: reg,
      onRecord: (r) => { appendRecord(r, { dshHome: home }).catch(() => {}) },
    })
    for await (const _c of adapter.stream({ model: 'x', messages: [], sessionId: 'sess-ledger' })) { /* drain */ }
    await new Promise((r) => setTimeout(r, 60))
    const sp = await readSpend({ dshHome: home })
    assert.equal(sp.byBillingTier.paid_allowed.calls, 1)
    assert.equal(sp.byBillingTier.paid_allowed.paidCalls, 1)
    assert.equal(sp.billingSplit.paidShareOfKnown, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
