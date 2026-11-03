import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccountStore, maskCredential } from '../src/pools/channels/accounts.js'
import { listChannels, loginUrlOf, LOGIN_GUIDES } from '../src/web/channels.js'
import { CHANNELS, LOGIN } from '../src/pools/channels/protocols.js'

async function tmpHome() { return mkdtemp(join(tmpdir(), 'cs-acc-')) }

test('掩码只露前后 4 位', () => {
  assert.equal(maskCredential('sk-1234567890abcdef'), 'sk-1…cdef')
  assert.equal(maskCredential('short'), '****')
  assert.equal(maskCredential(''), '')
})

test('保存后 list 不含凭据原文（安全红线）', async () => {
  const home = await tmpHome()
  const s = createAccountStore(home)
  await s.save({ provider: 'codearts', label: 'A', credential: 'SECRET-TOKEN-XYZ' })
  const list = await s.list()
  const json = JSON.stringify(list)
  assert.equal(json.includes('SECRET-TOKEN-XYZ'), false, 'list 绝不能回原文')
  assert.equal(list[0].hasCredential, true)
  assert.ok(list[0].masked)
})

test('credentialOf 能取原文（内部用）', async () => {
  const home = await tmpHome()
  const s = createAccountStore(home)
  await s.save({ provider: 'kilo', credential: 'abc123' })
  assert.equal(await s.credentialOf('kilo'), 'abc123')
  assert.equal(await s.credentialOf('none'), null)
})

test('文件权限是 0600', async () => {
  const home = await tmpHome()
  const s = createAccountStore(home)
  await s.save({ provider: 'x', credential: 'y' })
  const st = await stat(join(home, 'cs-myfree', 'accounts.json'))
  assert.equal((st.mode & 0o777), 0o600, '必须是 0600')
})

test('删除账号', async () => {
  const home = await tmpHome()
  const s = createAccountStore(home)
  const r = await s.save({ provider: 'x', credential: 'y' })
  assert.equal((await s.remove(r.id)).ok, true)
  assert.equal((await s.list()).length, 0)
})

test('18 个渠道都有登录指引', async () => {
  const home = await tmpHome()
  const list = await listChannels(createAccountStore(home))
  assert.equal(list.length, 18)
  for (const c of list) {
    assert.ok(c.guideTitle, c.id + ' 缺 guideTitle')
    assert.ok(Array.isArray(c.guideSteps) && c.guideSteps.length > 0, c.id + ' 缺步骤')
    assert.ok(c.field, c.id + ' 缺输入字段名')
  }
})

test('登录 URL 必须是 https 且非空（可用真实入口路径）', () => {
  for (const id of Object.keys(CHANNELS)) {
    const u = loginUrlOf(id)
    assert.ok(u, id + ' 缺登录 URL')
    assert.match(u, /^https:\/\//, id + ' 必须 https：' + u)
  }
})
test('18 个渠道都有 loginPage（真实入口）', () => {
  const withPage = Object.values(CHANNELS).filter((c) => c.loginPage).length
  assert.equal(withPage, 18)
})

test('未登录时 loggedIn=false', async () => {
  const home = await tmpHome()
  const list = await listChannels(createAccountStore(home))
  assert.equal(list.every((c) => c.loggedIn === false), true)
})

test('登录后 loggedIn=true 且只回掩码', async () => {
  const home = await tmpHome()
  const store = createAccountStore(home)
  await store.save({ provider: 'loomy', credential: 'LOOMY-SECRET-TOKEN-123' })
  const list = await listChannels(store)
  const loomy = list.find((c) => c.id === 'loomy')
  assert.equal(loomy.loggedIn, true)
  assert.equal(JSON.stringify(list).includes('LOOMY-SECRET-TOKEN-123'), false)
})

test('每种登录方式都有指引定义', () => {
  for (const k of Object.values(LOGIN)) {
    if (k === LOGIN.NONE) continue
    assert.ok(LOGIN_GUIDES[k], '缺少 ' + k + ' 的指引')
  }
})

// ── 覆盖层规范化（清理历史错名）──
test('normalizeChain 把 kilo-free 改成 kilo 并去重', async () => {
  const { createState } = await import('../src/web/state.js')
  const { resolveSourceId } = await import('../src/pools/keyless/index.js')
  const home = await tmpHome()
  const st = createState(home)
  await st.writeChain({
    chain: [
      { provider: 'kilo', model: 'kilo-auto/free', tier: 1 },
      { provider: 'kilo-free', model: 'kilo-auto/free', tier: 1 },
      { provider: 'ovh', model: 'Qwen3.5-9B', tier: 1 },
    ],
  })
  const r = await st.normalizeChain(resolveSourceId)
  assert.equal(r.before, 3)
  assert.equal(r.after, 2, 'kilo 与 kilo-free 归一后应去重成 1 条')
  assert.equal(r.changed, true)
  const after = await st.readChain()
  assert.equal(after.chain.every((e) => e.provider !== 'kilo-free'), true, '不应再有 kilo-free')
})

test('已经是规范名时不做改动', async () => {
  const { createState } = await import('../src/web/state.js')
  const { resolveSourceId } = await import('../src/pools/keyless/index.js')
  const home = await tmpHome()
  const st = createState(home)
  await st.writeChain({ chain: [{ provider: 'kilo', model: 'x', tier: 1 }] })
  const r = await st.normalizeChain(resolveSourceId)
  assert.equal(r.changed, false)
})

test('空覆盖层不报错', async () => {
  const { createState } = await import('../src/web/state.js')
  const home = await tmpHome()
  const st = createState(home)
  const r = await st.normalizeChain((x) => x)
  assert.equal(r.changed, false)
  assert.equal(r.before, 0)
})
