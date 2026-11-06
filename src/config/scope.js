/**
 * cs-myfree — 作用域（全局 / 预设(兼容) / 工作区 / 会话 / 团队）
 *
 * 优先级（窄范围优先生效，后覆盖前）：
 *   global ← preset(仅兼容读取) ← workspace ← session ← team
 *
 * 存储：
 *   global   : ~/.dsh/cs-myfree/config.json
 *   preset   : ~/.dsh/cs-myfree/config.preset.<presetId>.json   （旧机制，保留读取）
 *   workspace: ~/.dsh/cs-myfree/config.workspace.<name>.json
 *   session  : ~/.dsh/cs-myfree/config.session.<sessionId>.json
 *   team     : ~/.dsh/cs-myfree/config.team.<teamId>.json
 *
 * 权限（design/19 §1.1，用户确认「全部可改 + 管理员优先」）：
 *   每层配置携带 `_meta: { owner: 'admin'|'user', updatedAt }`；
 *   管理员写的层，普通用户 UI 显示锁定并只读；普通用户写的层管理员可覆盖。
 *   宿主身份服务缺省时视为 admin（fail-open 到最宽松）。
 *
 * 设计理由：**不侵入宿主存储**，全部落在自己的目录，便于审计与清理。
 *
 * @module cs-myfree/config/scope
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { findSensitiveKey, stripSensitive } from './store.js'

export const SCOPE = Object.freeze({
  GLOBAL: 'global',
  PRESET: 'preset',
  SESSION: 'session',
  WORKSPACE: 'workspace',
  TEAM: 'team',
})

/** 合并顺序（索引小 = 更宽，被后面的覆盖） */
export const SCOPE_ORDER = Object.freeze([
  SCOPE.GLOBAL,
  SCOPE.PRESET,       // 旧机制：仅兼容读取，UI 不再引导
  SCOPE.WORKSPACE,
  SCOPE.SESSION,
  SCOPE.TEAM,
])

/** UI 可引导的四层（preset 不进引导列表） */
export const UI_SCOPES = Object.freeze([
  SCOPE.GLOBAL, SCOPE.WORKSPACE, SCOPE.SESSION, SCOPE.TEAM,
])

export function scopeDir(dshHome) {
  return join(dshHome || process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh'), 'cs-myfree')
}

/** 某作用域对应的文件名 */
export function scopeFile(dshHome, scope, id) {
  const dir = scopeDir(dshHome)
  if (scope === SCOPE.PRESET) {
    if (!id) throw new Error('预设作用域需要 presetId')
    return join(dir, `config.preset.${safe(id)}.json`)
  }
  if (scope === SCOPE.SESSION) {
    if (!id) throw new Error('会话作用域需要 sessionId')
    return join(dir, `config.session.${safe(id)}.json`)
  }
  if (scope === SCOPE.WORKSPACE) {
    if (!id) throw new Error('工作区作用域需要 workspaceId')
    return join(dir, `config.workspace.${safe(id)}.json`)
  }
  if (scope === SCOPE.TEAM) {
    if (!id) throw new Error('团队作用域需要 teamId')
    return join(dir, `config.team.${safe(id)}.json`)
  }
  return join(dir, 'config.json')
}

function safe(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
}

async function readJson(file, fallback = {}) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}

async function writeJson(file, obj) {
  const dir = dirname(file)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = `${dir}/.${Date.now()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, file)
    return true
  } catch {
    await unlink(tmp).catch(() => {})
    return false
  }
}

/** 深合并（对象递归，数组/标量替换） */
export function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over
  const out = Object.assign({}, base)
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v)
    } else out[k] = v
  }
  return out
}

/** 读单个作用域（含 _meta；敏感字段由调用方 stripSensitive） */
export async function readScope(dshHome, scope, id) {
  try { return await readJson(scopeFile(dshHome, scope, id), {}) } catch { return {} }
}

// ── 子智能体路由跟随策略（`design/22` 契约 E2；作用域配置字段）────────────────
//
// 背景（用户原话逐条对应，契约 E3，不许自创语义）：
//   一：不跟随路由，自动切换            ⇒ mode='auto'
//   二：不跟随路由，后续仍由全局或单独设置兜底（选定一个模型） ⇒ mode='pinned' + model
//   三：跟随路由，后续仍由全局或单独设置兜底 ⇒ mode='follow'
//
// 关键：**「不跟随」≠「不用全局设置」**。三选项都要保留 `fallback`
// （全局链 / 本层单独设置的链）这一层兜底，否则「pinned 的模型不可用」时会直接失败。
//
// 默认值 `{ mode:'auto', model:null, fallback:'global' }` **等于今天的行为**
// （子智能体按可用性自动选路 + 全局链兜底）⇒ harness 零回归。

/** 配置键名（写 patch / 读生效配置都用它，避免各处手写字符串漂移） */
export const SUBAGENT_ROUTING_KEY = 'subagentRouting'

/** 三种策略（顺序 = UI 三选项顺序，契约 E3） */
export const SUBAGENT_ROUTING_MODES = Object.freeze(['auto', 'pinned', 'follow'])

/** 兜底口径：`global` 用全局链 | `scope` 用本层单独设置的链 */
export const SUBAGENT_ROUTING_FALLBACKS = Object.freeze(['global', 'scope'])

/** 默认值（= 今天的行为，零回归） */
export const SUBAGENT_ROUTING_DEFAULTS = Object.freeze({
  mode: 'auto',
  model: null,
  fallback: 'global',
})

/** `model` 形状：`'provider/model'` 或裸模型名；长度上限防御噪音 */
export const SUBAGENT_MODEL_MAX_LEN = 128

/**
 * 归一化 `subagentRouting`（**永不抛错**，脏值一律回默认值）。
 *
 * 纪律：
 *   · `mode` 非法 ⇒ `'auto'`（= 今天的行为，最保守且零回归）；
 *   · `model` 非字符串/空白/超长 ⇒ `null`；
 *   · `fallback` 非法 ⇒ `'global'`；
 *   · `mode==='pinned'` 但 `model===null`：**保留 pinned 不改写用户意图**，
 *     由 `validateSubagentRouting` 报错、由消费方按 `fallback` 兜底（不能偷偷变 auto）。
 *
 * @param {unknown} input
 * @returns {{ mode:'auto'|'pinned'|'follow', model:string|null, fallback:'global'|'scope' }}
 */
export function normalizeSubagentRouting(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const mode = typeof raw.mode === 'string' && SUBAGENT_ROUTING_MODES.includes(raw.mode.trim().toLowerCase())
    ? /** @type {any} */ (raw.mode.trim().toLowerCase())
    : SUBAGENT_ROUTING_DEFAULTS.mode
  const model = typeof raw.model === 'string'
    ? (raw.model.trim() === '' ? null : raw.model.trim().slice(0, SUBAGENT_MODEL_MAX_LEN))
    : null
  const fallback = typeof raw.fallback === 'string' && SUBAGENT_ROUTING_FALLBACKS.includes(raw.fallback.trim().toLowerCase())
    ? /** @type {any} */ (raw.fallback.trim().toLowerCase())
    : SUBAGENT_ROUTING_DEFAULTS.fallback
  return { mode, model, fallback }
}

/**
 * 校验 `subagentRouting`（settings API 写入前的闸门）。
 *
 * 与 `normalizeSubagentRouting` 的分工：这里是**报错**给用户看（不静默改写），
 * 那里是**运行期兜底**（永不抛）。两者都用同一份常量，口径不会打架。
 *
 * @param {unknown} input
 * @returns {{ ok:boolean, value:object, errors:string[] }}
 */
export function validateSubagentRouting(input) {
  const errors = []
  const raw = input
  if (raw === null || raw === undefined) return { ok: true, value: normalizeSubagentRouting({}), errors }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, value: normalizeSubagentRouting({}), errors: ['subagentRouting 必须是对象'] }
  }
  if (raw.mode !== undefined) {
    const m = typeof raw.mode === 'string' ? raw.mode.trim().toLowerCase() : ''
    if (!SUBAGENT_ROUTING_MODES.includes(m)) {
      errors.push(`subagentRouting.mode 非法：${JSON.stringify(raw.mode)}（可选：${SUBAGENT_ROUTING_MODES.join(' / ')}）`)
    }
  }
  if (raw.fallback !== undefined) {
    const f = typeof raw.fallback === 'string' ? raw.fallback.trim().toLowerCase() : ''
    if (!SUBAGENT_ROUTING_FALLBACKS.includes(f)) {
      errors.push(`subagentRouting.fallback 非法：${JSON.stringify(raw.fallback)}（可选：${SUBAGENT_ROUTING_FALLBACKS.join(' / ')}）`)
    }
  }
  if (raw.model !== undefined && raw.model !== null) {
    if (typeof raw.model !== 'string' || raw.model.trim() === '') {
      errors.push('subagentRouting.model 必须是 "provider/model" 或裸模型名字符串（清空请传 null）')
    } else if (raw.model.trim().length > SUBAGENT_MODEL_MAX_LEN) {
      errors.push(`subagentRouting.model 过长（上限 ${SUBAGENT_MODEL_MAX_LEN} 字符）`)
    } else if (/[\s\u0000-\u001F\u007F]/.test(raw.model.trim())) {
      errors.push('subagentRouting.model 不允许含空白或控制字符')
    }
  }
  const value = normalizeSubagentRouting(raw)
  // 🔴 契约 E2：「pinned 时必填 model」——只在**合并后**判定，
  //    这样 patch 里只改 mode 也能正确报错（而不是等到运行期才发现没固定目标）
  if (value.mode === 'pinned' && !value.model) {
    errors.push('subagentRouting.mode="pinned" 时必须给 model（"provider/model"）')
  }
  return { ok: errors.length === 0, value, errors }
}

/**
 * 合并「本层值 + 上层继承值」得到生效的 `subagentRouting`（窄层优先，字段级覆盖）。
 *
 * 作用：`effectiveConfig()` 是**顶层键**深合并，`{ subagentRouting: { mode:'follow' } }`
 * 覆盖上层时不会带上上层的 `model`/`fallback`，若直接归一化就会把上层的 `model`
 * 丢掉。这里逐字段补齐：`undefined` 才继承，`null` 是**显式清空**（不继承）。
 *
 * @param {...unknown} layers 由宽到窄（全局 → … → 团队）
 * @returns {{ mode:string, model:string|null, fallback:string }}
 */
export function mergeSubagentRouting(...layers) {
  const acc = {}
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue
    for (const key of ['mode', 'model', 'fallback']) {
      if (layer[key] !== undefined) acc[key] = layer[key]
    }
  }
  return normalizeSubagentRouting(acc)
}

/**
 * 由「生效配置 + hint」解析子智能体**最终**该走哪条策略（契约 E3 的唯一判定点）。
 *
 * 优先级（自洽且可审计）：
 *   1. hint 显式声明了 `follow_parent_routing` ⇒ 以它为准
 *      （`true` ⇒ 'follow'；`false` ⇒ 不跟随，配置是 pinned 就用 pinned，否则 auto）；
 *   2. hint 没声明（`null`/`undefined`，含 v1 六键 hint）⇒ 用配置 `mode` 兜底；
 *   3. 都没有 ⇒ 默认 `'auto'`（今天的行为）。
 * 模型：hint 的 `pinned_model` 优先（这是"这一轮就钉这个消息"），否则配置 `model`。
 *
 * @param {{ config?: object, hint?: object|null }} o
 * @returns {{ mode:'auto'|'pinned'|'follow', model:string|null, fallback:'global'|'scope', source:'hint'|'config'|'default' }}
 */
export function resolveSubagentRouting({ config, hint } = {}) {
  const cfg = normalizeSubagentRouting(config && typeof config === 'object' ? config : {})
  const declared = hint && typeof hint === 'object' ? hint.follow_parent_routing : null
  const declaredPinned = hint && typeof hint === 'object'
    && typeof hint.pinned_model === 'string' && hint.pinned_model.trim() !== ''
    ? hint.pinned_model.trim().slice(0, SUBAGENT_MODEL_MAX_LEN)
    : null

  let mode = cfg.mode
  let source = config && typeof config === 'object' && Object.keys(config).length > 0 ? 'config' : 'default'
  if (declared === true) {
    mode = 'follow'
    source = 'hint'
  } else if (declared === false) {
    mode = cfg.mode === 'pinned' ? 'pinned' : 'auto'
    source = 'hint'
  } else if (declaredPinned) {
    // 只钉了模型但没声明跟随关系 ⇒ 等价于「不跟随 + 固定模型」
    mode = 'pinned'
    source = 'hint'
  }
  const model = declaredPinned ?? cfg.model
  return { mode, model, fallback: cfg.fallback, source }
}

/**
 * 作用域字段登记表（供 settings UI / 校验统一遍历，避免"页面能改但后端不读"的假开关）。
 * 深合并本身支持任意键（`deepMerge` 是递归的），这里登记的是**语义**：默认值 + 归一 + 校验。
 */
export const SCOPED_FIELD_REGISTRY = Object.freeze({
  [SUBAGENT_ROUTING_KEY]: Object.freeze({
    default: SUBAGENT_ROUTING_DEFAULTS,
    normalize: normalizeSubagentRouting,
    validate: validateSubagentRouting,
  }),
})

/** 层配置的「已设顶层键数」（_meta 不算） */
export function countSetKeys(obj) {
  if (!obj || typeof obj !== 'object') return 0
  return Object.keys(obj).filter((k) => k !== '_meta').length
}

/**
 * 写单个作用域。
 *
 * 🔴 红线 #1/#2/#7：**任何凭据都不许写进配置文件**。
 * 递归检查（防 `{"transportHeaders":{"authorization":"…"}}` 这类嵌套绕过），
 * 命中直接抛错让 API 返回明确原因，而不是静默落盘。
 *
 * @param {string} dshHome
 * @param {string} scope  SCOPE 之一
 * @param {string} [id]   非 global 作用域必填
 * @param {object} obj    要写入的配置（不含 _meta；_meta 由本函数统一附加）
 * @param {{owner:'admin'|'user', updatedAt?:number}} [meta] 权限元数据；缺省不写 _meta
 */
export async function writeScope(dshHome, scope, id, obj, meta) {
  const hit = findSensitiveKey(obj)
  if (hit) {
    const err = new Error(`禁止写入敏感字段：${hit}`)
    err.code = 'SENSITIVE_FIELD'
    throw err
  }
  const payload = { ...(obj ?? {}) }
  if (meta && (meta.owner === 'admin' || meta.owner === 'user')) {
    payload._meta = {
      owner: meta.owner,
      updatedAt: Number.isFinite(meta.updatedAt) ? meta.updatedAt : Date.now(),
    }
  } else if (payload._meta) {
    // 保留显式传入的 _meta（防丢失），但规范化 owner
    const owner = payload._meta.owner === 'user' ? 'user' : 'admin'
    payload._meta = { owner, updatedAt: Number.isFinite(payload._meta.updatedAt) ? payload._meta.updatedAt : Date.now() }
  }
  try { return await writeJson(scopeFile(dshHome, scope, id), payload) } catch { return false }
}

/** 取某层配置的 owner（无 _meta ⇒ null） */
export function ownerOf(obj) {
  const o = obj && typeof obj === 'object' ? obj._meta : null
  return o && (o.owner === 'admin' || o.owner === 'user') ? o.owner : null
}

/**
 * 计算**生效配置**：global ← preset(兼容) ← workspace ← session ← team 逐层覆盖。
 * @param {{dshHome?:string, presetId?:string, sessionId?:string, workspaceId?:string, teamId?:string}} o
 * @returns {Promise<{config, layers, ids, byLayer}>}
 *   byLayer: { scope: 该层剥离敏感字段后的配置 }（供 UI 逐字段标注生效来源）
 */
export async function effectiveConfig(o = {}) {
  const { dshHome, presetId, sessionId, workspaceId, teamId } = o
  // 读路径也剔除敏感字段（磁盘上可能有历史脏数据，绝不能回给 UI）
  const read = async (scope, id) => (id || scope === SCOPE.GLOBAL
    ? stripSensitive(await readScope(dshHome, scope, scope === SCOPE.GLOBAL ? undefined : id))
    : {})
  const global = await read(SCOPE.GLOBAL)
  const preset = presetId ? await read(SCOPE.PRESET, presetId) : {}
  const workspace = workspaceId ? await read(SCOPE.WORKSPACE, workspaceId) : {}
  const session = sessionId ? await read(SCOPE.SESSION, sessionId) : {}
  const team = teamId ? await read(SCOPE.TEAM, teamId) : {}

  let merged = {}
  const byLayer = {}
  for (const [scope, cfg] of [
    [SCOPE.GLOBAL, global],
    [SCOPE.PRESET, preset],
    [SCOPE.WORKSPACE, workspace],
    [SCOPE.SESSION, session],
    [SCOPE.TEAM, team],
  ]) {
    if (cfg && Object.keys(cfg).length > 0) merged = deepMerge(merged, cfg)
    byLayer[scope] = cfg ?? {}
  }

  // 🔒 生效配置里剥离 _meta（权限元数据只该出现在 byLayer/layers 的 owner 里，
  //    混进 config 会污染读路径的 schema；P4 修复）
  const { _meta, ...cleanMerged } = merged

  return {
    config: stripSensitive(cleanMerged),
    layers: {
      global: countSetKeys(global),
      preset: countSetKeys(preset),
      workspace: countSetKeys(workspace),
      session: countSetKeys(session),
      team: countSetKeys(team),
    },
    ids: { presetId: presetId ?? null, sessionId: sessionId ?? null, workspaceId: workspaceId ?? null, teamId: teamId ?? null },
    byLayer,
  }
}

/**
 * 列出所有作用域文件（供 UI 展示与清理），识别全部五类。
 * @returns {Promise<Array<{name:string, scope:string, id:string|null}>>}
 */
export async function listScopes(dshHome) {
  const dir = scopeDir(dshHome)
  try {
    const names = await readdir(dir)
    const out = []
    for (const name of names) {
      if (!/^config(\.|$)/.test(name)) continue
      const m = name.match(/^config\.(preset|session|workspace|team)\.(.+)\.json$/)
      if (name === 'config.json') out.push({ name, scope: SCOPE.GLOBAL, id: null })
      else if (m) out.push({ name, scope: m[1], id: m[2] })
      else out.push({ name, scope: 'unknown', id: null })
    }
    return out
  } catch {
    return []
  }
}
