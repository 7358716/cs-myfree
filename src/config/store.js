/**
 * cs-myfree — 配置存储（原子写 + 权限收口）
 *
 * 设计依据：v3 §3.4。三条要求：
 *  1. **原子写**：先写临时文件再 rename（崩溃不会留下半个配置）
 *  2. **权限 0600**：配置可能含源开关，不应被同机其他用户读
 *  3. **不存密钥**：本模块只存「策略」，凭据一律走宿主凭据库
 *
 * @module cs-myfree/config/store
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
// 终态失败黑名单 TTL 的唯一事实来源：`ROUTING_DEFAULTS.blacklistTtlMs` 用的就是它，
// 这里 import 而不是抄数字，避免"两处各写一个 6h"以后漂移（本项目踩过口径漂移的坑）。
import { DEFAULT_TTL_MS } from '../adapter/failure-map.js'

/** 原子写：同目录临时文件 → fsync 语义由 rename 保证 */
export async function atomicWrite(file, data, { mode = 0o600 } = {}) {
  const dir = dirname(file)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  try {
    await writeFile(tmp, body, { mode })
    await chmod(tmp, mode).catch(() => {})
    await rename(tmp, file)
    return { ok: true, path: file, bytes: Buffer.byteLength(body) }
  } catch (err) {
    await unlink(tmp).catch(() => {})
    return { ok: false, error: String(err?.message ?? err) }
  }
}

/** 读 JSON；损坏时返回 defaults（绝不抛，避免一个坏文件让插件不激活） */
export async function readJson(file, defaults = null) {
  try {
    const t = await readFile(file, 'utf8')
    return { ok: true, value: JSON.parse(t) }
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, value: defaults, missing: true }
    return { ok: false, value: defaults, error: String(err?.message ?? err) }
  }
}

/** 配置文件默认值 */
export const DEFAULTS = Object.freeze({
  schema: 'cs-myfree/config/v1',
  chain: { overrides: [] },
  budget: {
    // ⚠️ 不是 0：0 会让所有限额变死信（现状缺陷）
    perCallCNY: 1,
    dailyCNY: 10,
    monthlyCNY: 100,
  },
  paid: { enabled: false, allowAutoCall: false, confirmEachTurn: true },
  vision: {
    mode: 'off',                     // off | local | free-cloud | paid-cloud（默认不变）
    consented: false,                // 云端识图需用户显式同意（红线：不默认上传）
    model: 'Qwen2.5-VL-72B-Instruct',
    chain: [],                       // 空 = 用 bridge.js 的 OVH_CHAIN 默认链
    cacheSize: 200,                  // 结果缓存条数
    maxImagesPerTurn: 4,
    maxImageBytes: 5242880,          // 5 MiB
  },
  search: {
    enabled: true,                   // false ⇒ /search/run 直接报「搜索已关闭」
    sources: ['bing-rss', 'bing-html', 'sogou', 'mwmbl'],
    budgetMs: 15000,                 // 多源搜索总预算（超时用已返回部分结果）
    cacheTtlMs: 300000,              // 5 分钟
    ratePerMin: 20,
    maxResults: 8,
  },
  // ── 渠道开关（三个概念必须分清，混了就出事）──────────────────────────────
  //   disabled  停用     —— **不参与**选路/自动切换（真的不让它干活）
  //   hidden    不展示   —— 只是不在「对话模型选择器」里出现；路由链、自动切换
  //                         仍然可以用它 🔴 **隐藏 ≠ 禁用**（这是红线，见 web/routing.js
  //                         的 `filterVisibleCatalog` 注释：它只过滤 catalog，
  //                         从不作用于链/准入/降级）
  //   `hidden: []`（默认）= 没写显式清单 ⇒ 套用下面的**默认可见集合**；
  //     显式写空数组（`{sources:{hidden:[]}}`）= 全部展示；写非空 = 该清单为准（绝对口径）。
  sources: { disabled: [], hidden: [] },
  // ── 路由（契约 B `rules.configurable`）──────────────────────────────────────
  // 🔴 **逐字镜像** `adapter/index.js` 的 `ROUTING_DEFAULTS`（见该处定义与注释）：
  //      priority: 'balanced' / autoSwitch: true / blacklistTtlMs: DEFAULT_TTL_MS(6h)
  //      ⇒ 页面显示值、落盘默认值、运行期真默认值三者同口径，零回归。
  // ⚠️ `cooldownMs` / `rateCooldownMs` **故意不在默认值里**：它们的真实来源是并发闸门
  //    （15s / 4s），`ROUTING_DEFAULTS` 里没有这两项 —— 在这里凭空写一个数，等于把
  //    "没配置"变成"已配置"，会真的改掉冷却行为（那是行为变更，不是补默认值）。
  //    页面要展示它们时读闸门实际值（`adapter.routingConfigSnapshot()`）。
  routing: {
    priority: 'balanced',
    autoSwitch: true,
    blacklistTtlMs: DEFAULT_TTL_MS,
    // 🔴 全部渠道失败后链路休眠（用户需求）：全部候选失败后，链路休眠多少秒再允许整体重试，
    //   避免连续轰炸失效渠道。0 或 null 表示不休眠（当前默认，零回归）。
    globalCooldownMs: null,
    // 🔴 探测路由开关（P2，2026-11-13）：true = 先探测可用集合再路由；false = 原 ladder 逻辑（默认，零回归）
    useProbeRoute: false,
    // 探测缓存 TTL（毫秒）；null = 用 model-chain 默认 5 分钟
    probeTtlMs: null,
  },
  // ── 子智能体路由策略（契约 E）──────────────────────────────────────────────
  // 默认值 = **今天的行为**（子智能体自动选路 + 全局链兜底）⇒ harness 零回归；
  // 与 `config/scope.js` 的 `SUBAGENT_ROUTING_DEFAULTS` 必须一致（那边归一/校验也用它）。
  subagentRouting: { mode: 'auto', model: null, fallback: 'global' },
})

/** 合并用户配置与默认值（深合并一层，数组整体替换） */
export function withDefaults(cfg = {}) {
  const out = { ...DEFAULTS }
  for (const [k, v] of Object.entries(cfg ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && DEFAULTS[k] && typeof DEFAULTS[k] === 'object' && !Array.isArray(DEFAULTS[k])) {
      out[k] = { ...DEFAULTS[k], ...v }
    } else {
      out[k] = v
    }
  }
  return out
}

// ══════════════════════════════════════════════════════════════════════════
// 渠道可见性（「是否展示」开关）—— 需求 #6 的唯一事实来源
//
// 为什么放在 store.js 而不是 UI：用户原话是「**默认**只展示 deepseek、自己加
// API 的、免费可用的、华为云」，这个默认集合必须是一个**常量**，UI 只负责渲染
// 这份常量，不许自己再写一份 if（否则页面显示与后端口径必然漂移，本项目踩过）。
//
// 🔴 隐藏（hidden）≠ 停用（disabled）：
//   · hidden  只影响「对话模型选择器」的候选目录（catalog）
//   · 路由链、自动切换、准入过滤**一律不看 hidden**
//   ⇒ 用户把某家渠道隐藏后，自动切换仍然会在别人都挂了时用它。这是红线。
// ══════════════════════════════════════════════════════════════════════════

/** 渠道分组（设置页表格的「分组」列；UI 按它分块渲染） */
export const CHANNEL_GROUP = Object.freeze({
  DEEPSEEK: 'deepseek',   // DeepSeek 系（官方 / 自加 API 的 deepseek）
  HUAWEI: 'huawei',       // 华为云（codearts / officeace-MaaS）
  FREE: 'free',           // 免密免费源（kilo / ovh / pollinations）
  SELFAPI: 'selfapi',     // 用户自加 API（ark 等）
  CHANNEL: 'channel',     // 其它渠道包（登录型，默认不展示）
  OTHER: 'other',         // 认不出来的（含用户新加的 id）
})

export const CHANNEL_GROUP_LABELS = Object.freeze({
  [CHANNEL_GROUP.DEEPSEEK]: 'DeepSeek',
  [CHANNEL_GROUP.HUAWEI]: '华为云',
  [CHANNEL_GROUP.FREE]: '免费源',
  [CHANNEL_GROUP.SELFAPI]: '自加 API',
  [CHANNEL_GROUP.CHANNEL]: '渠道包',
  [CHANNEL_GROUP.OTHER]: '其它',
})

/** 华为云（codearts = 华为云 CodeArts；officeace = 华为云 MaaS） */
export const HUAWEI_SOURCE_IDS = Object.freeze(['codearts', 'officeace'])
/** 免密免费源（能力可用、不需要账号） */
export const FREE_SOURCE_IDS = Object.freeze(['kilo', 'ovh', 'pollinations'])
/** 用户自加 API（付费/自带 key，不走登录态） */
export const SELFAPI_SOURCE_IDS = Object.freeze(['deepseek-official', 'ark'])
/** 名字以 deepseek 开头的一律算「deepseek 系」 */
export const DEEPSEEK_SOURCE_RE = /^deepseek/i

/**
 * 默认**隐藏**集合 = 「其它渠道包」。
 *
 * ⚠️ 这份清单与 `pools/channels/protocols.js#CHANNELS`、`pools/registry.js#SOURCES`
 *    是同一批 id；`test/settings.test.mjs` 里有一条**漂移哨兵**用例，新增渠道却忘了
 *    在这里分类时会直接测试失败（不许靠人肉记忆维护）。
 */
export const DEFAULT_HIDDEN_SOURCES = Object.freeze([
  'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'loomy',
  'raccoon', 'minimax', 'minimaxintl', 'zcode', 'opencode', 'gemini', 'accio', 'qiniu',
])

/** 默认**展示**集合（= deepseek 系 + 自加 API + 免费可用 + 华为云），供 UI/文档引用 */
export const DEFAULT_VISIBLE_SOURCES = Object.freeze([
  ...FREE_SOURCE_IDS, ...SELFAPI_SOURCE_IDS, ...HUAWEI_SOURCE_IDS,
])

/** 单条 id 上限（防止有人把整段 HTML 当 id 塞进配置） */
export const HIDDEN_MAX_ENTRIES = 200
export const HIDDEN_MAX_ID_LEN = 64

/**
 * id 归一（**可见性判定的唯一归一函数**）。
 * 免密源在链里叫 `kilo-free` / `ovh-vision`，在 catalog 里叫 `kilo` / `ovh`
 * （见 `web/routes.js#chainCatalogSources` 的 `replace(/-free$|-vision$/,'')`）——
 * 不归一的话「隐藏 kilo」会对 `kilo-free` 失效。
 */
export function normalizeSourceId(id) {
  return String(id ?? '').trim().toLowerCase().replace(/-free$|-vision$/, '')
}

/** 某渠道属于哪个分组 */
export function channelGroupOf(id) {
  const k = normalizeSourceId(id)
  if (!k) return CHANNEL_GROUP.OTHER
  if (DEEPSEEK_SOURCE_RE.test(k)) return CHANNEL_GROUP.DEEPSEEK
  if (HUAWEI_SOURCE_IDS.includes(k)) return CHANNEL_GROUP.HUAWEI
  if (FREE_SOURCE_IDS.includes(k)) return CHANNEL_GROUP.FREE
  if (SELFAPI_SOURCE_IDS.includes(k)) return CHANNEL_GROUP.SELFAPI
  if (DEFAULT_HIDDEN_SOURCES.includes(k)) return CHANNEL_GROUP.CHANNEL
  // 认不出来的（用户自加的 id）⇒ 默认**展示**：不把用户自己的东西藏起来
  return CHANNEL_GROUP.OTHER
}

/** 该渠道是否「默认不展示」 */
export function isHiddenByDefault(id) {
  const k = normalizeSourceId(id)
  return Boolean(k) && DEFAULT_HIDDEN_SOURCES.includes(k)
}

/**
 * 解析生效的隐藏集合。
 *
 * 口径（**唯一实现**，UI/路由/设置页都必须调这里，不许各算一份）：
 *   · `sources.hidden` 键**不存在** ⇒ 套用默认可见集合（`DEFAULT_HIDDEN_SOURCES`）
 *   · 键存在且是数组            ⇒ **以它为准**（绝对口径）：`[]` = 全部展示
 *
 * ⚠️ 传进来的必须是**未套 DEFAULTS 的**生效配置（`effectiveConfig().config`）。
 *    经过 `withDefaults()` 之后 `sources.hidden` 恒为 `[]`（= 全部展示），默认集合就不生效了。
 *
 * @param {object|null|undefined} cfg 生效配置
 * @returns {{explicit:boolean, list:string[], set:Set<string>, source:'config'|'default'}}
 */
export function resolveHiddenSources(cfg) {
  const src = cfg && typeof cfg === 'object' ? cfg.sources : undefined
  const hasExplicit = Boolean(src) && typeof src === 'object' && !Array.isArray(src)
    && Object.prototype.hasOwnProperty.call(src, 'hidden')
  if (hasExplicit) {
    const list = (Array.isArray(src.hidden) ? src.hidden : [])
      .map(normalizeSourceId).filter(Boolean)
    const uniq = [...new Set(list)].sort()
    return { explicit: true, list: uniq, set: new Set(uniq), source: 'config' }
  }
  const uniq = [...new Set(DEFAULT_HIDDEN_SOURCES.map(normalizeSourceId))].sort()
  return { explicit: false, list: uniq, set: new Set(uniq), source: 'default' }
}

/**
 * 单个渠道是否隐藏。第二参可以是 `resolveHiddenSources()` 的结果、Set，或生效配置。
 */
export function isSourceHidden(id, resolvedOrCfg) {
  const k = normalizeSourceId(id)
  if (!k) return false
  if (resolvedOrCfg instanceof Set) return resolvedOrCfg.has(k)
  if (resolvedOrCfg && typeof resolvedOrCfg === 'object' && resolvedOrCfg.set instanceof Set) {
    return resolvedOrCfg.set.has(k)
  }
  return resolveHiddenSources(resolvedOrCfg).set.has(k)
}

/**
 * 校验写入的 `sources.hidden`（**非法值必须被拒**，不许静默吞掉）。
 * @param {unknown} value patch 里的值（`null` = 删除该字段恢复继承/默认）
 * @param {{allowNull?:boolean}} [opts]
 * @returns {{ok:true, value:string[]|null, errors:[]}|{ok:false, value:null, errors:string[]}}
 */
export function validateHiddenSources(value, { allowNull = true } = {}) {
  if (value === null || value === undefined) {
    if (allowNull) return { ok: true, value: null, errors: [] }
    return { ok: false, value: null, errors: ['sources.hidden 不能为空值（要恢复默认请传 null）'] }
  }
  if (!Array.isArray(value)) {
    return {
      ok: false, value: null,
      errors: ['sources.hidden 必须是渠道 id 字符串数组（如 ["buddy","qoder"]）；删除该字段请传 null'],
    }
  }
  if (value.length > HIDDEN_MAX_ENTRIES) {
    return { ok: false, value: null, errors: [`sources.hidden 最多 ${HIDDEN_MAX_ENTRIES} 项（收到 ${value.length} 项）`] }
  }
  const errors = []
  const out = []
  value.forEach((v, i) => {
    if (typeof v !== 'string') {
      errors.push(`sources.hidden[${i}] 必须是字符串 id（收到 ${v === null ? 'null' : typeof v}）`)
      return
    }
    const k = normalizeSourceId(v)
    if (!k) { errors.push(`sources.hidden[${i}] 是空 id`); return }
    if (k.length > HIDDEN_MAX_ID_LEN) { errors.push(`sources.hidden[${i}] 太长（上限 ${HIDDEN_MAX_ID_LEN} 字符）`); return }
    if (!/^[a-z0-9._:-]+$/.test(k)) { errors.push(`sources.hidden[${i}] 含非法字符：${k.slice(0, HIDDEN_MAX_ID_LEN)}`); return }
    out.push(k)
  })
  if (errors.length) return { ok: false, value: null, errors }
  return { ok: true, value: [...new Set(out)].sort(), errors: [] }
}

/**
 * 敏感字段名（红线 #1/#2/#7：任何凭据都不得写进 config.json /
 * 也不得回给 UI）。
 *
 * `authorization` / `cookie` 也在此列：`transportHeaders` 这类嵌套对象
 * 很容易被用户/前端塞进 `Authorization: Bearer …`。
 */
export const SENSITIVE_KEY_RE = /(key|token|secret|password|passwd|authorization|cookie|credential)/i

/**
 * 递归查找敏感字段（返回第一个命中的路径，如 `transportHeaders.authorization`）。
 * @param {any} obj
 * @param {string} [path]
 * @returns {string|null}
 */
export function findSensitiveKey(obj, path = '') {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const hit = findSensitiveKey(obj[i], `${path}[${i}]`)
      if (hit) return hit
    }
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k
    if (SENSITIVE_KEY_RE.test(k)) return p
    const hit = findSensitiveKey(v, p)
    if (hit) return hit
  }
  return null
}

/**
 * 深拷贝并**剔除**敏感字段（读路径也用：磁盘上若有历史脏数据，
 * 绝不能通过 GET /config 回给 UI）。
 */
export function stripSensitive(obj) {
  if (Array.isArray(obj)) return obj.map((v) => stripSensitive(v))
  if (!obj || typeof obj !== 'object') return obj
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_RE.test(k)) continue
    out[k] = stripSensitive(v)
  }
  return out
}
