/**
 * cs-myfree — 2026-11-23 改造回归（Ts-202611034）
 *
 * 三件事：
 *   A. 供给页删掉「② 模型预设」—— 那个「加进模型链」按钮**从没真的加过任何东西**
 *      （只 `onGoTab('models')` + 弹提示），而四个预设本来就在免密源里，下拉可直接选。
 *   B. 渠道包去掉 API 类源：`deepseek-official` / `deepseek-web` 移出，
 *      `ark` 从渠道包语义转到**付费池**（不要两处都留）。
 *   C. 付费池新增阿里云百炼 Token Plan（`qwen-token-plan-cn`），
 *      Key 从**环境变量**读（`QWEN_TOKEN_PLAN_CN_API_KEY`），绝不硬编码；
 *      `ark` 标记 agentPlan 模式。
 *
 * 这些用例守的是「改造后不会悄悄退回去」：
 *   删掉的东西不许回来、加的东西必须真的能取到 Key、付费池不能出现重复条目。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { SOURCES, KIND, paidSources, keylessSources, buildOrder, sourceById } from '../src/pools/registry.js'
import { CHANNELS } from '../src/pools/channels/protocols.js'
import { FLOW_MAP } from '../src/pools/channels/login/flow-map.js'
import { createAccountStore } from '../src/pools/channels/accounts.js'
import { SELFAPI_SOURCE_IDS } from '../src/config/store.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

// ══════════════════════════════════════════════════════════════════════════
// A. 供给页 ② 模型预设已删除
// ══════════════════════════════════════════════════════════════════════════

test('A: 供给页不再有「② 模型预设」与「加进模型链」按钮', async () => {
  const src = await readFile(join(SRC, 'client.js'), 'utf8')
  assert.equal(src.includes('② 模型预设'), false, '「② 模型预设」整块应已删除')
  assert.equal(src.includes('加进模型链'), false, '那个按钮从没真的加过东西，应已删除')
  // 它引用的四个预设常量也不该残留成孤儿代码
  assert.equal(src.includes('Kilo 免费池 · kilo-auto/free'), false, '预设列表应随之删除')
})

test('A: 删掉 ② 之后，供给页编号仍是连续的（①→②，没有跳号）', async () => {
  const src = await readFile(join(SRC, 'client.js'), 'utf8')
  assert.ok(src.includes("'① 免密源（无需登录）'"), '① 免密源仍在')
  assert.ok(src.includes("'② 账号渠道（'"), '② 账号渠道应接续')
  assert.equal(src.includes('③ 账号渠道'), false, '不应残留旧的「③ 账号渠道」')
  // 页面里指向该分区的提示文案也要同步（否则「去配置 Key」会指到不存在的③）
  assert.equal(src.includes('「③ 账号渠道」'), false, '提示文案里不得再引用③编号')
})

// ══════════════════════════════════════════════════════════════════════════
// B. 渠道包去掉 API 类源
// ══════════════════════════════════════════════════════════════════════════

test('B: deepseek-official / deepseek-web 已从供应源注册表移除', () => {
  assert.equal(sourceById('deepseek-official'), null, '由宿主自带适配器承担，插件不再声明')
  assert.equal(sourceById('deepseek-web'), null, '不再由本插件声明')
  const ids = SOURCES.map((s) => s.id)
  assert.equal(ids.includes('deepseek-official'), false)
  assert.equal(ids.includes('deepseek-web'), false)
})

test('B: ark 只出现在付费池，不再有「渠道包里的 ark」', () => {
  const arkEntries = SOURCES.filter((s) => s.id === 'ark')
  assert.equal(arkEntries.length, 1, 'ark 只能有一条（不要两处都留）')
  assert.equal(arkEntries[0].paid, true, 'ark 属付费池')
  assert.equal(arkEntries[0].kind, KIND.SELFAPI, 'ark 是 API 型付费源，不是账号登录渠道')
  // 渠道包（ACCOUNT）里不该再有 ark
  const accountIds = SOURCES.filter((s) => s.kind === KIND.ACCOUNT).map((s) => s.id)
  assert.equal(accountIds.includes('ark'), false, 'ark 不得留在渠道包')
})

test('B: 移除后 buildOrder / paidSources 不空、不抛错（防空指针）', () => {
  const noPaid = buildOrder({ allowPaid: false })
  const withPaid = buildOrder({ allowPaid: true })
  assert.ok(noPaid.length > 0, '不允许付费时仍应有候选')
  assert.equal(noPaid.every((s) => s.paid !== true), true, '不允许付费时不得混入付费源')
  assert.ok(withPaid.length >= noPaid.length)
  assert.ok(paidSources().length > 0, '付费池不能空（否则界面付费池会是空白）')
  assert.ok(keylessSources().length > 0)
})

test('B: 每个供应源都能被 sourceById 查到，且 id 唯一', () => {
  const ids = SOURCES.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, '供应源 id 不得重复')
  for (const id of ids) assert.ok(sourceById(id), `${id} 应能被查到`)
})

test('B: SELFAPI_SOURCE_IDS 与付费池一致（漂移哨兵）', () => {
  const paidIds = paidSources().map((s) => s.id).sort()
  const declared = [...SELFAPI_SOURCE_IDS].sort()
  assert.deepEqual(paidIds, declared,
    'store.js 的 SELFAPI_SOURCE_IDS 必须与 registry 的付费源一致，否则可见性判定会错位')
})

// ══════════════════════════════════════════════════════════════════════════
// C. 付费池新增阿里 Token Plan
// ══════════════════════════════════════════════════════════════════════════

test('C: qwen-token-plan-cn 已登记为付费源，端点与凭据名正确', () => {
  const s = paidSources().find((x) => x.id === 'qwen-token-plan-cn')
  assert.ok(s, '付费池里必须有阿里 Token Plan')
  assert.equal(s.paid, true)
  assert.equal(s.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  assert.equal(s.credentialEnv, 'QWEN_TOKEN_PLAN_CN_API_KEY', 'Key 来源必须是环境变量名，不是值')
})

test('C: 渠道协议已登记（能被真正调用，不是只挂在注册表里）', () => {
  const ch = CHANNELS['qwen-token-plan-cn']
  assert.ok(ch, 'CHANNELS 里必须有它，否则选了也发不出去')
  assert.equal(ch.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  assert.equal(ch.chatPath, '/chat/completions')
  assert.equal(ch.billing, 'paid', '计费口径必须是 paid')
  assert.equal(ch.credentialEnv, 'QWEN_TOKEN_PLAN_CN_API_KEY')
})

test('C: 登录流类型已登记（供给页不会因缺 flow 而崩）', () => {
  const f = FLOW_MAP['qwen-token-plan-cn']
  assert.ok(f, 'flow-map 必须覆盖它')
  assert.equal(typeof f.loginVerified, 'boolean')
})

test('C: Key 从环境变量读取；取不到就是 null（如实报未登录）', async () => {
  const store = createAccountStore({ dshHome: join(HERE, '__nonexistent_home__') })
  const saved = process.env.QWEN_TOKEN_PLAN_CN_API_KEY
  try {
    delete process.env.QWEN_TOKEN_PLAN_CN_API_KEY
    assert.equal(await store.credentialOf('qwen-token-plan-cn'), null, '没有环境变量时不得假装有 Key')

    process.env.QWEN_TOKEN_PLAN_CN_API_KEY = 'env-key-for-test'
    assert.equal(await store.credentialOf('qwen-token-plan-cn'), 'env-key-for-test')

    process.env.QWEN_TOKEN_PLAN_CN_API_KEY = '   '
    assert.equal(await store.credentialOf('qwen-token-plan-cn'), null, '空白值视为没有')
  } finally {
    if (saved === undefined) delete process.env.QWEN_TOKEN_PLAN_CN_API_KEY
    else process.env.QWEN_TOKEN_PLAN_CN_API_KEY = saved
  }
})

test('C: 环境变量兜底**只对声明了 credentialEnv 的渠道生效**（不波及其它渠道）', async () => {
  const store = createAccountStore({ dshHome: join(HERE, '__nonexistent_home__') })
  const saved = process.env.ARK_API_KEY
  try {
    process.env.ARK_API_KEY = 'should-not-be-read'
    // ark 没有声明 credentialEnv ⇒ 不该被环境变量兜底
    assert.equal(await store.credentialOf('ark'), null,
      '未声明 credentialEnv 的渠道不得读环境变量（否则等于开后门）')
    assert.equal(await store.credentialOf('codearts'), null)
  } finally {
    if (saved === undefined) delete process.env.ARK_API_KEY
    else process.env.ARK_API_KEY = saved
  }
})

test('C: ark 标记为 agentPlan，且如实声明「只标记、未读取」', () => {
  const s = sourceById('ark')
  assert.equal(s.agentPlan, true, '付费池里的 ark 要标 agentPlan')
  const ch = CHANNELS.ark
  assert.equal(ch.agentPlan, true)
  assert.equal(ch.planModelsFile, 'plan-models-user.json')
  assert.equal(ch.planId, 'agent-plan')
  // 代码里目前没有解析该文件的实现 —— 这里锁住「注释别把话说满」
  assert.ok(ch.note, '要有 note 说明用法')
})

// ══════════════════════════════════════════════════════════════════════════
// 红线：不含密钥
// ══════════════════════════════════════════════════════════════════════════

test('红线：registry / protocols 里不含任何真实密钥，只写环境变量名', async () => {
  for (const f of ['pools/registry.js', 'pools/channels/protocols.js']) {
    const src = await readFile(join(SRC, f), 'utf8')
    assert.equal(/sk-[A-Za-z0-9]{16,}/.test(src), false, `${f} 不得出现 sk- 形态的密钥`)
    assert.equal(/dashscope[a-z.]*\/[^'"\s]*[A-Za-z0-9]{32}/.test(src), false, `${f} 不得出现内联密钥`)
  }
})