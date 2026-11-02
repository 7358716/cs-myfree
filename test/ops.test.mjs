import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { verifySignature, sha256, planAtomicReplace, planRollback, rollbackResult } from '../src/ops/updater.js'
import { check, ACTION, VERDICT, RESTART_MIN_INTERVAL_MS } from '../src/ops/trust.js'

// ── 升级 ──
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const pem = publicKey.export({ type: 'spki', format: 'pem' })

test('合法签名通过', () => {
  const payload = Buffer.from('hello')
  const sig = sign(null, payload, privateKey).toString('base64')
  assert.equal(verifySignature({ payload, signature: sig, publicKeyPem: pem, algorithm: null }), true)
})
test('篡改内容验证失败', () => {
  const sig = sign(null, Buffer.from('hello'), privateKey).toString('base64')
  assert.equal(verifySignature({ payload: Buffer.from('tampered'), signature: sig, publicKeyPem: pem, algorithm: null }), false)
})
test('畸形输入一律 false（不降级放行）', () => {
  assert.equal(verifySignature({}), false)
  assert.equal(verifySignature({ payload: 'x', signature: 'not-base64!!', publicKeyPem: 'garbage' }), false)
})
test('原子替换用同目录 .new（保证同卷）', () => {
  const p = planAtomicReplace('/a/b/c/pkg.json')
  assert.equal(p.tmpPath, '/a/b/c/.pkg.json.new')
  assert.equal(p.finalPath, '/a/b/c/pkg.json')
})
test('回滚必须先恢复再删多余', () => {
  const r = planRollback({ backupFiles: ['a', 'b'], targetFiles: ['a', 'b', 'c'] })
  assert.equal(r.steps[0].phase, 'restore')
  assert.equal(r.steps[1].phase, 'remove-extra')
  assert.deepEqual(r.steps[1].files, ['c'])
})
test('备份缺失时拒绝（防呆）', () => {
  const r = planRollback({ backupFiles: [], targetFiles: ['a'] })
  assert.equal(r.ok, false)
  assert.match(r.reason, /备份缺失/)
})
test('回滚不全必须明说', () => {
  const r = rollbackResult({ restored: ['a'], failed: ['b'] })
  assert.equal(r.complete, false)
  assert.match(r.message, /rollback incomplete/)
  assert.match(r.message, /不要假设包可用/)
})
test('sha256 稳定', () => { assert.equal(sha256(Buffer.from('x')), sha256(Buffer.from('x'))) })

// ── 信任围栏 ──
test('读日志允许', () => { assert.equal(check(ACTION.READ_DIAG).verdict, VERDICT.ALLOW) })
test('改全局配置禁止', () => { assert.equal(check(ACTION.EDIT_GLOBAL_CONFIG).verdict, VERDICT.DENY) })
test('装依赖禁止', () => { assert.equal(check(ACTION.INSTALL_DEPS).verdict, VERDICT.DENY) })
test('删文件永远需要人工确认', () => {
  assert.equal(check(ACTION.DELETE_FILE).verdict, VERDICT.NEED_HUMAN)
  assert.equal(check(ACTION.DELETE_FILE, { humanConfirmed: true }).verdict, VERDICT.ALLOW)
})
test('改自有配置放行但要备份+审计', () => {
  const r = check(ACTION.EDIT_OWN_CONFIG)
  assert.equal(r.verdict, VERDICT.ALLOW)
  assert.equal(r.mustBackup, true)
  assert.equal(r.mustAudit, true)
})
test('有活跃轮次时禁止重启', () => {
  const r = check(ACTION.RESTART, { activeTurns: 2 })
  assert.equal(r.verdict, VERDICT.DENY)
  assert.match(r.reason, /活跃轮次/)
})
test('重启限速生效', () => {
  const now = 10_000_000
  const r = check(ACTION.RESTART, { now, lastRestartAt: now - 1000 })
  assert.equal(r.verdict, VERDICT.DENY)
  assert.match(r.reason, /限速/)
})
test('满足条件时允许重启且必须审计', () => {
  const now = 10_000_000
  const r = check(ACTION.RESTART, { now, lastRestartAt: now - RESTART_MIN_INTERVAL_MS - 1 })
  assert.equal(r.verdict, VERDICT.ALLOW)
  assert.equal(r.mustAudit, true)
})
test('未知动作默认拒绝', () => {
  assert.equal(check('some-new-action').verdict, VERDICT.DENY)
})
