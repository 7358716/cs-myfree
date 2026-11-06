/**
 * cs-myfree — 子智能体路由跟随策略测试（`design/22` 契约 E1 / E2 / E3）
 *
 * 要证明的事（每条都给可核对的断言，不接受"没抛错"）：
 *   1. hint 契约升 v2：`HINTS_VERSION === 2`，符号名**不变**（改了老 cs-bots 就找不到注册表）；
 *   2. 🔴 **v1 兼容**：v1 客户端发的六键 hint 必须被**正常接受**，两个新键归一为 `null`
 *      （`follow_parent_routing === null` 而不是 undefined —— 消费方按 null 兜底）；
 *   3. v2 两键生效：合法布尔/字符串被保留；
 *   4. **非法新键 ⇒ null，但不拒绝整条 hint**（授权字段仍照常可用）；
 *   5. 未知键被丢弃（白名单重建）；
 *   6. `subagentRouting` 作用域字段：默认值 = 今天的行为（零回归）、三种 mode 的归一与校验、
 *      字段级继承（`mergeSubagentRouting`）、hint 优先的最终判定（`resolveSubagentRouting`）；
 *   7. 注册表读侧版本兼容：v1 注册表（同机双份 cs-myfree）仍可读，未知大版本拒绝。
 *
 * 运行：`node --test test/subagent-routing.test.mjs`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  HINTS_VERSION,
  HINTS_SYMBOL,
  MIN_SUPPORTED_HINTS_VERSION,
  PINNED_MODEL_MAX_LEN,
  SUBAGENT_ROUTING_MODES as HINT_MODES,
  createHintRegistry,
  getGlobalHints,
  installGlobalHints,
  normalizeFollowParentRouting,
  normalizeHint,
  normalizePinnedModel,
  uninstallGlobalHints,
} from '../src/adapter/routing-hints.js'

import {
  SCOPED_FIELD_REGISTRY,
  SUBAGENT_ROUTING_DEFAULTS,
  SUBAGENT_ROUTING_FALLBACKS,
  SUBAGENT_ROUTING_KEY,
  SUBAGENT_ROUTING_MODES,
  mergeSubagentRouting,
  normalizeSubagentRouting,
  resolveSubagentRouting,
  validateSubagentRouting,
} from '../src/config/scope.js'

/** v1 六键 hint（**故意不含**任何 v2 键：模拟旧 cs-bots 发来的形状） */
const HINT_V1 = Object.freeze({
  billing_tier: 'paid_allowed',
  complexity_tier: 'T2',
  agent_role: 'subagent',
  requires_paid: true,
  source: 'cs-bots/task-board',
  at: 1_700_000_000_000,
})

// ── ① 版本与符号 ─────────────────────────────────────────────────────────────

test('契约 E1：HINTS_VERSION 升到 2，跨插件符号名不变（改了老 cs-bots 就失联）', () => {
  assert.equal(HINTS_VERSION, 2)
  assert.equal(MIN_SUPPORTED_HINTS_VERSION, 1)
  assert.equal(HINTS_SYMBOL, Symbol.for('cs-myfree.routing.hints.v1'),
    '符号名是发现地址，版本由 version 字段承担')
  assert.deepEqual([...HINT_MODES], ['auto', 'pinned', 'follow'])
})

// ── ② 🔴 v1 向后兼容（本契约最关键的一条）───────────────────────────────────

test('★ 契约 E1：v1 六键 hint 必须被正常接受，follow_parent_routing === null', () => {
  const n = normalizeHint(HINT_V1)
  assert.ok(n, 'v1 六键 hint 绝不能被拒绝')
  assert.equal(n.follow_parent_routing, null, '缺键 ⇒ null（不是 undefined：消费方按 null 兜底）')
  assert.equal(n.pinned_model, null)
  // v1 六键语义逐字不变
  assert.equal(n.billing_tier, 'paid_allowed')
  assert.equal(n.complexity_tier, 'T2')
  assert.equal(n.agent_role, 'subagent')
  assert.equal(n.requires_paid, true)
  assert.equal(n.source, 'cs-bots/task-board')
  assert.equal(n.at, 1_700_000_000_000)
})

test('★ v1 hint 经注册表往返仍是「可用的 paid_allowed 授权」（不能因为升版丢授权）', () => {
  const reg = createHintRegistry()
  assert.ok(reg.set('sess-v1', HINT_V1), 'v1 hint 必须能写进注册表')
  const got = reg.get('sess-v1')
  assert.equal(got.billing_tier, 'paid_allowed', '授权不能因升版而降级')
  assert.equal(got.follow_parent_routing, null)
  assert.equal(got.pinned_model, null)
})

// ── ③ v2 两键生效 ───────────────────────────────────────────────────────────

test('契约 E1：v2 两键合法值被保留（true/false + provider/model + 裸模型名）', () => {
  for (const follow of [true, false]) {
    const n = normalizeHint({ ...HINT_V1, follow_parent_routing: follow })
    assert.equal(n.follow_parent_routing, follow)
  }
  for (const model of ['deepseek/deepseek-chat', 'Qwen2.5-VL-72B-Instruct', '  glm-4-flash  ']) {
    const n = normalizeHint({ ...HINT_V1, pinned_model: model })
    assert.equal(n.pinned_model, model.trim(), `pinned_model 应保留并 trim：${model}`)
  }
})

test('契约 E1：非法新键 ⇒ null，且**不拒绝整条 hint**（授权字段照常可用）', () => {
  const bad = [
    { follow_parent_routing: 'yes' },
    { follow_parent_routing: 1 },
    { follow_parent_routing: {} },
    { follow_parent_routing: null },
    { pinned_model: 123 },
    { pinned_model: '' },
    { pinned_model: '   ' },
    { pinned_model: { id: 'x' } },
    { pinned_model: ['a/b'] },
    { pinned_model: 'has space/model' },      // 含空白 ⇒ 形状不合法
    { pinned_model: 'bad\u0000ctrl' },        // 控制字符 ⇒ 形状不合法
  ]
  for (const over of bad) {
    const n = normalizeHint({ ...HINT_V1, ...over })
    assert.ok(n, `不得因非法新键拒绝整条 hint：${JSON.stringify(over)}`)
    const key = Object.keys(over)[0]
    assert.equal(n[key], null, `${key} 非法值应归一为 null：${JSON.stringify(over)}`)
    assert.equal(n.billing_tier, 'paid_allowed', '非法新键不得影响授权字段')
    assert.equal(n.requires_paid, true)
  }
})

test('normalizePinnedModel / normalizeFollowParentRouting：纯函数边界', () => {
  assert.equal(normalizePinnedModel('  a/b '), 'a/b')
  assert.equal(normalizePinnedModel('x'.repeat(PINNED_MODEL_MAX_LEN + 50)).length, PINNED_MODEL_MAX_LEN)
  for (const bad of [undefined, null, 0, true, {}, [], '', '  ', 'a b']) {
    assert.equal(normalizePinnedModel(bad), null, `normalizePinnedModel(${JSON.stringify(bad)}) 应为 null`)
  }
  assert.equal(normalizeFollowParentRouting(true), true)
  assert.equal(normalizeFollowParentRouting(false), false)
  for (const bad of [undefined, null, 'true', 1, 0, {}]) {
    assert.equal(normalizeFollowParentRouting(bad), null, `normalizeFollowParentRouting(${JSON.stringify(bad)}) 应为 null`)
  }
})

// ── ④ 未知键丢弃 / 白名单形状 ────────────────────────────────────────────────

test('契约 E1：未知键被丢弃（白名单重建，不报错）', () => {
  const n = normalizeHint({
    ...HINT_V1,
    follow_parent_routing: true,
    pinned_model: 'p/m',
    granted_at: 123,
    __proto__polluted: 'x',
    extra: { nested: true },
  })
  assert.deepEqual(Object.keys(n).sort(), [
    'agent_role', 'at', 'billing_tier', 'complexity_tier',
    'follow_parent_routing', 'pinned_model', 'requires_paid', 'source',
  ])
  assert.equal(n.granted_at, undefined)
  assert.equal(n.extra, undefined)
})

test('hint 对象仍冻结（注册表内不可被外部改写）', () => {
  const n = normalizeHint({ ...HINT_V1, follow_parent_routing: true })
  assert.equal(Object.isFrozen(n), true)
})

// ── ⑤ 注册表读侧的版本兼容 ───────────────────────────────────────────────────

test('getGlobalHints：接受 v1 注册表（同机双份 cs-myfree），未知版本一律拒绝', () => {
  try {
    uninstallGlobalHints()
    const reg = createHintRegistry()
    assert.equal(installGlobalHints(reg), true)
    assert.equal(getGlobalHints(), reg, '本版注册表可读')
    // v1 注册表（旧版 cs-myfree 装的）也应可读：hint 只是缺两个新键
    globalThis[HINTS_SYMBOL].version = 1
    assert.equal(getGlobalHints(), reg, 'v1 注册表不得被判成未安装（否则授权静默全降级）')
    globalThis[HINTS_SYMBOL].version = 999
    assert.equal(getGlobalHints(), null, '未知大版本必须拒绝（不误读）')
    globalThis[HINTS_SYMBOL].version = 'x'
    assert.equal(getGlobalHints(), null, '非法版本号必须拒绝')
  } finally {
    uninstallGlobalHints()
  }
})

// ── ⑥ 作用域配置：subagentRouting（契约 E2 / E3）─────────────────────────────

test('契约 E2：默认值 { mode:auto, model:null, fallback:global } = 今天的行为（零回归）', () => {
  assert.equal(SUBAGENT_ROUTING_KEY, 'subagentRouting')
  assert.deepEqual({ ...SUBAGENT_ROUTING_DEFAULTS }, { mode: 'auto', model: null, fallback: 'global' })
  assert.deepEqual([...SUBAGENT_ROUTING_MODES], ['auto', 'pinned', 'follow'])
  assert.deepEqual([...SUBAGENT_ROUTING_FALLBACKS], ['global', 'scope'])
  // 没有配置时归一 = 默认值（⇒ 消费方零回归）
  for (const empty of [undefined, null, {}, 'x', [], 42]) {
    assert.deepEqual(normalizeSubagentRouting(empty), { mode: 'auto', model: null, fallback: 'global' })
  }
  // 字段已登记（供 settings UI 遍历，防"页面能改但后端不读"的假开关）
  assert.equal(typeof SCOPED_FIELD_REGISTRY[SUBAGENT_ROUTING_KEY]?.validate, 'function')
})

test('契约 E3 三选项：auto / pinned / follow 各自归一结果', () => {
  assert.deepEqual(
    normalizeSubagentRouting({ mode: 'AUTO' }),
    { mode: 'auto', model: null, fallback: 'global' },
  )
  assert.deepEqual(
    normalizeSubagentRouting({ mode: 'pinned', model: ' deepseek/deepseek-chat ', fallback: 'scope' }),
    { mode: 'pinned', model: 'deepseek/deepseek-chat', fallback: 'scope' },
  )
  assert.deepEqual(
    normalizeSubagentRouting({ mode: 'follow', fallback: 'SCOPE' }),
    { mode: 'follow', model: null, fallback: 'scope' },
  )
  // 脏值一律回默认（永不抛）
  assert.deepEqual(
    normalizeSubagentRouting({ mode: 'bogus', model: 42, fallback: 'nope' }),
    { mode: 'auto', model: null, fallback: 'global' },
  )
})

test('validateSubagentRouting：非法 mode/fallback/model 逐条报错；pinned 必须给 model', () => {
  assert.equal(validateSubagentRouting({ mode: 'follow' }).ok, true)
  assert.equal(validateSubagentRouting({ mode: 'auto', model: null }).ok, true)
  assert.equal(validateSubagentRouting(null).ok, true, 'null = 清空该字段，合法')

  const badMode = validateSubagentRouting({ mode: 'inherit' })
  assert.equal(badMode.ok, false)
  assert.match(badMode.errors.join(';'), /mode 非法/)

  const badFallback = validateSubagentRouting({ mode: 'follow', fallback: 'local' })
  assert.equal(badFallback.ok, false)
  assert.match(badFallback.errors.join(';'), /fallback 非法/)

  const badModel = validateSubagentRouting({ mode: 'pinned', model: 'has space' })
  assert.equal(badModel.ok, false)
  assert.match(badModel.errors.join(';'), /model/)

  // 🔴 契约 E2：「pinned 时必填 model」——合并后判定，运行期之前就拦住
  const pinnedNoModel = validateSubagentRouting({ mode: 'pinned', model: null })
  assert.equal(pinnedNoModel.ok, false)
  assert.match(pinnedNoModel.errors.join(';'), /pinned.*必须给 model/)

  assert.equal(validateSubagentRouting({ mode: 'pinned', model: 'p/m' }).ok, true)
  assert.equal(validateSubagentRouting('nope').ok, false, '非对象必须报错')
})

test('mergeSubagentRouting：字段级继承（mode 覆盖但保留上层 model/fallback）', () => {
  const global = { mode: 'pinned', model: 'p/m', fallback: 'scope' }
  // 窄层只改 mode ⇒ model/fallback 继承全局（顶层深合并做不到这一点）
  assert.deepEqual(
    mergeSubagentRouting(global, { mode: 'follow' }),
    { mode: 'follow', model: 'p/m', fallback: 'scope' },
  )
  // 显式 null = 清空（不继承）
  assert.deepEqual(
    mergeSubagentRouting(global, { model: null }),
    { mode: 'pinned', model: null, fallback: 'scope' },
  )
  // 全空 ⇒ 默认（零回归）
  assert.deepEqual(mergeSubagentRouting(), { mode: 'auto', model: null, fallback: 'global' })
  assert.deepEqual(mergeSubagentRouting(null, undefined, {}), { mode: 'auto', model: null, fallback: 'global' })
})

test('resolveSubagentRouting：hint 优先、无 hint 用配置兜底、都没有 ⇒ auto（今天的行为）', () => {
  // ① 什么都没配 + v1 六键 hint ⇒ auto（零回归）
  assert.deepEqual(
    resolveSubagentRouting({ config: undefined, hint: normalizeHint(HINT_V1) }),
    { mode: 'auto', model: null, fallback: 'global', source: 'default' },
  )
  // ② hint 声明 follow ⇒ follow（hint 比配置更精确）
  assert.equal(
    resolveSubagentRouting({ config: { mode: 'auto' }, hint: normalizeHint({ ...HINT_V1, follow_parent_routing: true }) }).mode,
    'follow',
  )
  // ③ hint 声明不跟随 + 配置是 pinned ⇒ 用 pinned（不跟随 ≠ 不用配置）
  const pinnedCfg = { mode: 'pinned', model: 'p/m', fallback: 'scope' }
  const notFollow = resolveSubagentRouting({
    config: pinnedCfg,
    hint: normalizeHint({ ...HINT_V1, follow_parent_routing: false }),
  })
  assert.equal(notFollow.mode, 'pinned')
  assert.equal(notFollow.model, 'p/m')
  assert.equal(notFollow.fallback, 'scope')
  assert.equal(notFollow.source, 'hint')
  // ④ hint 只钉模型（没声明跟随）⇒ 等价「不跟随 + 固定模型」
  const pinnedByHint = resolveSubagentRouting({
    config: { mode: 'auto' },
    hint: normalizeHint({ ...HINT_V1, pinned_model: 'other/m' }),
  })
  assert.equal(pinnedByHint.mode, 'pinned')
  assert.equal(pinnedByHint.model, 'other/m')
  // ⑤ hint 的 pinned_model 优先于配置 model
  assert.equal(
    resolveSubagentRouting({ config: pinnedCfg, hint: normalizeHint({ ...HINT_V1, pinned_model: 'hint/m' }) }).model,
    'hint/m',
  )
  // ⑥ 配置 follow、hint 未声明 ⇒ follow（配置兜底生效）
  assert.equal(
    resolveSubagentRouting({ config: { mode: 'follow' }, hint: normalizeHint(HINT_V1) }).mode,
    'follow',
  )
  // ⑦ 三选项都保留 fallback 这一层（不能因为选了 auto/follow 就丢掉兜底）
  for (const mode of ['auto', 'pinned', 'follow']) {
    const r = resolveSubagentRouting({ config: { mode, model: 'p/m', fallback: 'scope' }, hint: null })
    assert.equal(r.fallback, 'scope', `${mode} 必须保留 fallback`)
  }
})
