import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planRefresh, auditCredentials, WARN_BEFORE_MS } from '../src/pools/channels/refresh.js'
import { buildBackup, validateBackup, diffImport, SCHEMA } from '../src/ops/backup.js'
import { createFeedStore, planReload, RELOAD_SCOPE } from '../src/ops/feed.js'
import { channelById } from '../src/pools/channels/protocols.js'

const NOW = 1_800_000_000_000

// ── 续期 ──
test('长期有效 ⇒ 不处理', () => {
  assert.equal(planRefresh({ ch: channelById('codearts'), expiresAt: null, now: NOW }).action, 'none')
})
test('Loomy 过期 ⇒ 必须人工重登（无续期端点）', () => {
  const r = planRefresh({ ch: channelById('loomy'), expiresAt: NOW - 1, now: NOW })
  assert.equal(r.action, 'relogin')
  assert.match(r.reason, /无续期端点/)
})
test('Loomy 临期 ⇒ 提前告警重登', () => {
  const r = planRefresh({ ch: channelById('loomy'), expiresAt: NOW + 3600_000, now: NOW })
  assert.equal(r.action, 'warn-relogin')
  assert.match(r.reason, /提前重登/)
})
test('Loomy 远期 ⇒ 仅观察', () => {
  const r = planRefresh({ ch: channelById('loomy'), expiresAt: NOW + 10 * 24 * 3600_000, now: NOW })
  assert.equal(r.action, 'watch')
})
test('CodeArts 临期 ⇒ 可静默续期', () => {
  const r = planRefresh({ ch: channelById('codearts'), expiresAt: NOW + 3600_000, now: NOW })
  assert.equal(r.action, 'refresh-soon')
})
test('auditCredentials 分流正确', () => {
  const r = auditCredentials({
    channels: { loomy: channelById('loomy'), codearts: channelById('codearts') },
    accounts: [
      { id: 'l1', provider: 'loomy', expiresAt: NOW + 3600_000 },
      { id: 'c1', provider: 'codearts', expiresAt: NOW + 3600_000 },
    ],
    now: NOW,
  })
  assert.equal(r.reloginRequired.length, 1)
  assert.equal(r.reloginRequired[0].provider, 'loomy')
  assert.equal(r.autoRefreshable.length, 1)
})
test('告警窗口 24 小时', () => { assert.equal(WARN_BEFORE_MS, 24 * 3600 * 1000) })

// ── 备份（安全红线）──
test('默认备份不含凭据（红线）', () => {
  const b = buildBackup({ config: { a: 1 }, accounts: [{ id: 'x', provider: 'p', token: 'SECRET' }] })
  assert.equal(b.containsCredentials, false)
  assert.equal(JSON.stringify(b).includes('SECRET'), false, '凭据绝不能进默认备份')
})
test('显式要求才带凭据且带警告', () => {
  const b = buildBackup({ includeCredentials: true, credentials: { k: 'v' } })
  assert.equal(b.containsCredentials, true)
  assert.match(b.warning, /不要留在 \/tmp/)
})
test('validateBackup 校验 schema', () => {
  assert.equal(validateBackup({}).ok, false)
  assert.equal(validateBackup({ schema: SCHEMA, accounts: [], config: {} }).ok, true)
})
test('导入预览要求显式同意（含凭据时）', () => {
  const v = validateBackup({ schema: SCHEMA, accounts: [], config: {}, containsCredentials: true })
  assert.equal(v.preview.requiresExplicitConsent, true)
})
test('diffImport 给出新增/更新/保留', () => {
  const d = diffImport(
    { accounts: [{ id: 'a', provider: 'p' }, { id: 'b', provider: 'p', x: 1 }] },
    { accounts: [{ id: 'b', provider: 'p' }, { id: 'c', provider: 'p' }] },
  )
  assert.deepEqual(d.add, ['a'])
  assert.deepEqual(d.update, ['b'])
  assert.deepEqual(d.remove, ['c'])
  assert.equal(d.willRemove, false, '删除默认不做')
})

// ── 公告与热重载 ──
test('公告同 id 只推一次', () => {
  const f = createFeedStore()
  assert.equal(f.filter([{ id: 'n1', text: 'a' }]).length, 1)
  assert.equal(f.filter([{ id: 'n1', text: 'a' }]).length, 0)
})
test('内容变了会重推', () => {
  const f = createFeedStore()
  f.filter([{ id: 'n1', text: 'a' }])
  assert.equal(f.filter([{ id: 'n1', text: 'b' }]).length, 1)
})
test('公告按优先级排序', () => {
  const f = createFeedStore()
  const r = f.filter([{ id: 'a', priority: 0 }, { id: 'b', priority: 9 }])
  assert.equal(r[0].id, 'b')
})
test('改配置 ⇒ 热生效', () => {
  assert.equal(planReload({ changed: ['config.json'] }).scope, RELOAD_SCOPE.HOT)
})
test('改代码 ⇒ 重载插件', () => {
  assert.equal(planReload({ changed: ['src/index.js'] }).scope, RELOAD_SCOPE.RELOAD)
})
test('改依赖/patch ⇒ 必须重启', () => {
  assert.equal(planReload({ changed: ['package.json'] }).scope, RELOAD_SCOPE.RESTART)
  assert.equal(planReload({ changed: ['cordis.patch.yml'] }).scope, RELOAD_SCOPE.RESTART)
})
