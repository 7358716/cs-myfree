/**
 * cs-myfree — 路由快照（诊断/验证指标口径的**唯一实现**）
 *
 * 为什么单独成文件：`/state.routing`、cordis 服务 `csMyfreeRouting.routingSnapshot()`
 * 与离线验证 harness 必须看**同一份**数据，否则「页面显示的」和「实际选路的」
 * 会再次漂移（本项目已经踩过这个坑：链显示与实际选路不一致）。
 *
 * 字段（冻结口径，验证指标直接用）：
 *   defaultBillingTier  未获授权时的默认标签（恒 'free_only'）
 *   lastAdmission       {at, stats:{total,kept,droppedBilling,droppedCooldown,
 *                        droppedConcurrency,relaxed,billingTier}, excluded[], eligible[]}
 *   chain[]             [{provider, model, tier, billing, billingSource, pinned}]
 *   gate{}              每家 {active, limit, ratio, coolingMs, streak429, last429At}
 *   blacklist[]         终态失败拉黑清单 [{provider, model, kind, until, remainMs}]
 *   hints               脱敏后的 hint 快照 + 条数
 *
 * 契约 A（`design/22` §A4）追加：
 *   switches{}          切换成功统计（口径 A）：{at, total, byProvider, byModel,
 *                       attempts:{total, byProvider}, switchSuccessRate, last}
 *
 * 契约 B（`design/22` §3）追加：
 *   rules{}             复杂路由基本规则（策略 / 排序键 / 过滤层 / 空集兜底 /
 *                       冷却时长 / 闸门快照 / **可设置项清单**）
 *
 * ⚠️ 铁律：`rules.configurable` 里每个 path 都必须**真能 patch 生效**（后端真的读）。
 *    生效值一律回读 adapter / 闸门，不在这里另算一份。
 *
 * 需求 #6（渠道展示开关）追加 —— **展示层口径的唯一实现**：
 *   `filterVisibleCatalog()` / `visibleCatalog()` / `visibilitySummary()`
 *   `hidden`（不展示）只作用于「对话模型选择器」目录；
 *   路由链、自动切换、准入过滤一律不读 `hidden`（隐藏 ≠ 禁用，红线）。
 *
 * @module cs-myfree/web/routing
 */

import { snapshotStats, COOLDOWN_BASE_MS, RATE_LIMIT_COOLDOWN_MS, COOLDOWN_MAX_MS, DEFAULT_LIMITS } from '../adapter/concurrency.js'
import { HINTS_VERSION } from '../adapter/routing-hints.js'
import { PHASE4_POLICY, RATE_LIMIT_COOLDOWN_MS as P3_RATE_COOLDOWN_MS } from '../adapter/policy-switch.js'
import { ADMISSION_WEIGHTS, ADMISSION_REASON } from '../adapter/admission.js'
import { ROUTING_DEFAULTS, ROUTING_PRIORITY_OPTIONS } from '../adapter/index.js'
import { resolveHiddenSources, normalizeSourceId, isHiddenByDefault, channelGroupOf } from '../config/store.js'

/**
 * 取 catalog 条目的渠道 id。
 *
 * 两种目录形状都要吃：
 *   · `/chain/catalog`（web/routes.js）        → `{kind, provider, label, models}`
 *   · adapter 的 `catalog()`（对话选择器真源） → `{provider, model, channelModel}` / `channelId`
 */
export function catalogSourceIdOf(entry) {
  const e = entry ?? {}
  return normalizeSourceId(e.provider ?? e.channelId ?? e.channel ?? e.id ?? '')
}

/**
 * 过滤「对话模型选择器」的模型目录（需求 #6：只展示 deepseek / 自加 API / 免费可用 /
 * 华为云，其它渠道包按 `sources.hidden` 隐藏）。
 *
 * 🔴 红线：**隐藏 ≠ 禁用**
 *   本函数**只**作用于「选择器展示的目录」（纯展示层）。路由链、自动切换、准入过滤
 *   （`createRoutingSnapshot` 的 `chain` / `lastAdmission` / 闸门）与 adapter 的
 *   `candidatesFor()` **一概不读** `sources.hidden`：
 *     · 用户隐藏了某家渠道 ⇒ 它不出现在选择器里，
 *     · 但自动切换在别家挂掉时**仍然**会用它（这是用户要的行为：隐藏只是界面整洁）。
 *   任何"顺手把 hidden 也塞进 disabled / 从链里剔掉"的改动都是越权，会被测试打回
 *   （见 `test/settings.test.mjs` 的「hidden 不影响路由链」用例）。
 *
 * @param {Array} sources 目录条目（任一 catalog 形状）
 * @param {object} cfg     生效配置（**未套 DEFAULTS**：`effectiveConfig().config`）
 * @returns {{sources:Array, hidden:string[], explicit:boolean, source:'config'|'default', dropped:string[]}}
 */
export function filterVisibleCatalog(sources, cfg) {
  const hidden = resolveHiddenSources(cfg)
  const list = Array.isArray(sources) ? sources : []
  const kept = []
  const dropped = []
  for (const entry of list) {
    const id = catalogSourceIdOf(entry)
    if (id && hidden.set.has(id)) {
      dropped.push(id)
      continue
    }
    kept.push(entry)         // 不改入参（路由链用的数组可能与这里同一个引用）
  }
  return {
    sources: kept,
    hidden: hidden.list,
    explicit: hidden.explicit,
    source: hidden.source,
    dropped,
  }
}

/** `filterVisibleCatalog` 的数组版（UI 侧只想要列表时用） */
export function visibleCatalog(sources, cfg) {
  return filterVisibleCatalog(sources, cfg).sources
}

/**
 * 模型去重：「同一个模型名只出现一次，并带出一个可用渠道」。
 *
 * 用户原话（2026-11-06）：
 *   「每次选择模型的时候，除了 deepseek 的付费 api 和自行添加的模型，
 *     其他的模型只带出一个可用的渠道。」
 *
 * 🔴 输入是 `/chain/catalog` 形状（`modelsVisible` 来自这里）：
 *   - 每组 `{ provider, label, kind, models: [{id, name}] }`
 *   - 渠道模型的 `id` 是**原始模型名**（无前缀），所以同名模型会跨组重复
 *
 * 🔴 三条纪律：
 *   1. **自加/付费 API 不打散**：`deepseek` / `ark` / `deepseek-web` 单独保留
 *      （用户要能明确地选「用我自己 key 的那个」）
 *   2. **去重只影响选择器展示，不影响路由**：候选链/降级链仍含全部渠道
 *   3. **可用性优先**：loggedIn && implemented && !disabled && !hidden 的渠道优先；
 *      同级里已验证 > 免费 > 原始顺序；若没有可用的，保留最好的兜底并标注
 *
 * @param {Array} groups `/settings` 的 models 目录（每组 {provider, label, kind, models}）
 * @param {Array} channels 渠道状态（id/label/loggedIn/loginVerified/implemented/usable/hidden）
 * @returns {Array} 去重后的分组（每模型只出现在一个组里）
 */
export function dedupeModelsVisible(groups, channels = []) {
  const chan = new Map()
  // 容错：目录或渠道清单可能是 null/非数组（老后端、首次启动），不许因此崩选择器
  for (const c of (Array.isArray(channels) ? channels : [])) {
    if (c && c.id) chan.set(String(c.id), c)
  }

  /** 渠道是否「可用」（登录 + 已实现 + 未停用 + 未隐藏） */
  const isUsable = (provider) => {
    const c = chan.get(provider)
    if (!c) return false
    if (c.implemented === false) return false
    if (c.loggedIn !== true) return false
    if (c.usable === false) return false
    if (c.hidden === true) return false
    return true
  }

  /** 渠道评分（越小越优先） */
  const rank = (provider) => {
    const c = chan.get(provider) || {}
    let s = 0
    if (!isUsable(provider)) s += 1000      // 不可用 ⇒ 靠后
    if (c.loginVerified !== true) s += 100  // 未验证 ⇒ 靠后（如实反映不确定性）
    return s * 1000 + Number(c.order || 0)
  }

  const isSelf = (provider) => /^(deepseek|ark|volcengine-agent-plan|kimi-coding|deepseek-web)$/.test(provider)

  /** modelName → {provider, label, kind, entry}  */
  const byModel = new Map()
  const dropped = []
  const flatGroups = []

  // 展开所有 (provider, model) 对
  for (const g of groups || []) {
    const provider = String(g?.provider ?? '')
    if (!provider) continue
    flatGroups.push({ provider, label: g.label, kind: g.kind, models: Array.isArray(g.models) ? g.models : [] })
  }

  for (const g of flatGroups) {
    const selfApi = isSelf(g.provider)
    for (const m of g.models) {
      const mid = String(m?.id ?? '')
      if (!mid) continue
      const key = selfApi ? `${mid}\u0000${g.provider}` : mid
      const entry = { id: mid, name: String(m.name || m.id || mid) }
      const cur = byModel.get(key)
      if (!cur) {
        byModel.set(key, { provider: g.provider, label: g.label, kind: g.kind, entry, _rank: rank(g.provider) })
        continue
      }
      const r = rank(g.provider)
      if (r < cur._rank) {
        byModel.set(key, { provider: g.provider, label: g.label, kind: g.kind, entry, _rank: r })
        dropped.push({ model: mid, droppedProvider: cur.provider, keptProvider: g.provider })
      } else {
        dropped.push({ model: mid, droppedProvider: g.provider, keptProvider: cur.provider })
      }
    }
  }

  // 按 provider 重新分组
  const byProvider = new Map()
  for (const [, v] of byModel) {
    const p = v.provider
    if (!byProvider.has(p)) byProvider.set(p, { provider: p, label: v.label, kind: v.kind, models: [], _count: 0 })
    byProvider.get(p).models.push(v.entry)
    byProvider.get(p)._count++
  }

  return [...byProvider.values()].map((g) => ({
    provider: g.provider,
    label: g.label,
    kind: g.kind,
    models: g.models,
  }))
}

/**
 * 设置页表格的「渠道可见性」摘要（不依赖 adapter，纯配置 + 渠道清单）。
 * @param {Array<{id:string}>} channels
 * @param {object} cfg 生效配置
 * @returns {{rows:Array<{id:string,group:string,hidden:boolean,defaultHidden:boolean}>, hidden:string[], explicit:boolean}}
 */
export function visibilitySummary(channels, cfg) {
  const hidden = resolveHiddenSources(cfg)
  const rows = (Array.isArray(channels) ? channels : []).map((c) => {
    const id = normalizeSourceId(c?.id)
    return {
      id,
      group: channelGroupOf(id),
      hidden: hidden.set.has(id),
      defaultHidden: isHiddenByDefault(id),
    }
  })
  return { rows, hidden: hidden.list, explicit: hidden.explicit, source: hidden.source }
}

/**
 * `switches` 的**空结构**（页面/指标直接读，不用处理字段缺失）。
 * 口径见 `design/22` §A1：分母 0 ⇒ `switchSuccessRate: null`（不是 0%）。
 */
export const EMPTY_SWITCHES = Object.freeze({
  at: null,
  total: 0,
  byProvider: {},
  byModel: {},
  attempts: { total: 0, byProvider: {} },
  switchSuccessRate: null,
  last: null,
})

/**
 * 可选策略清单（**含实测依据**，页面上要说清"为什么现在用这个"）。
 *
 * 依据 `src/adapter/policy-switch.js` 文件头与 `test/evidence/phase4-policies.md`：
 *   v1.1 是旧口径；p2/p3 已实测放弃（failRate 提前会加剧付费外溢）；blended 是定稿。
 */
export const POLICY_OPTIONS = Object.freeze([
  { id: 'v1.1', label: 'v1.1（旧）', desc: 'tier→billing→loadRatio→last429At→failRate→_i', evidence: 'paid 均值 6.46%' },
  { id: 'p2', label: 'p2（失败率提前）', desc: 'tier→billing→failRate→loadRatio→last429At→_i', evidence: '已实测放弃：加剧付费外溢' },
  { id: 'p3', label: 'p3（429 独立短冷却）', desc: `p2 + 429 独立短冷却（${P3_RATE_COOLDOWN_MS / 1000}s 起指数退避，封顶 120s）`, evidence: '已实测放弃' },
  { id: 'blended', label: 'blended（当前）', desc: 'tier→billing→(loadRatio+failRate)→last429At→_i', evidence: 'paid 6.46%→3.58%（−44.6%）' },
])

/** 过滤层（**执行顺序即 position**；`strict` 表示"永不被空集兜底放宽"） */
export const RULE_FILTERS = Object.freeze([
  { id: ADMISSION_REASON.BILLING, label: '付费授权过滤', position: 1, strict: true, effect: '未授权时付费候选直接剔除（fail-closed）' },
  { id: ADMISSION_REASON.BLACKLIST, label: '终态失败黑名单', position: 1.5, strict: true, effect: '拉黑期间不尝试，且不参与空集回退' },
  { id: ADMISSION_REASON.COOLDOWN, label: '冷却过滤', position: 2, strict: false, effect: '冷却中跳过；全冷却时放宽（省一次无效往返）' },
  { id: ADMISSION_REASON.CONCURRENCY, label: '并发过滤', position: 3, strict: false, effect: '名额满跳过；全满时放宽，由闸门做最后防线' },
])

/** 取第一个「有限数字」，否则回退（配置缺省时的兜底，绝不产生 NaN） */
function numOr(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 组装 `rules`（契约 B）。
 *
 * @param {object} o
 * @param {object|null} o.rt        adapter 的生效路由配置（routingConfigSnapshot()）
 * @param {object|null} o.gateSnap  闸门快照（snapshotStats()）
 * @returns {object}
 */
export function buildRoutingRules({ rt = null, gateSnap = null } = {}) {
  const conf = rt ?? {}
  const configured = conf.configured ?? {}
  // 冷却基值：adapter 生效值 > 闸门当前值 > 常量默认（三级回退，永远给得出数字）
  const busyMs = numOr(conf.cooldownMs, COOLDOWN_BASE_MS)
  const rateMs = numOr(conf.rateCooldownMs, RATE_LIMIT_COOLDOWN_MS)
  const maxMs = numOr(conf.maxCooldownMs, COOLDOWN_MAX_MS)
  const limits = (conf.limits && typeof conf.limits === 'object') ? conf.limits : { ...DEFAULT_LIMITS }
  const limitPaths = Object.keys(limits).map((id) => `sources.limits.${id}`)

  /** 该项的值来自配置还是默认（页面据此显示"已自定义/默认"） */
  const srcOf = (key) => (configured[key] ? 'config' : 'default')

  return {
    // ① 当前生效策略（`policy-switch.PHASE4_POLICY`，唯一事实来源）
    policy: PHASE4_POLICY,
    policyOptions: POLICY_OPTIONS.map((o) => ({ ...o, active: o.id === PHASE4_POLICY })),

    // ② 排序键（与 `admission.js` 的 cmp 完全一致；'score' = loadRatio+failRate 合成分）
    order: ['tier', 'billing', 'score', 'last429At', '_i'],
    orderHuman: '先按层 → 再看免费/付费 → 再看「拥挤度+失败率」合成分 → 再看多久没被限流 → 最后按你配置的顺序',
    weights: { load: ADMISSION_WEIGHTS.load, fail: ADMISSION_WEIGHTS.failRate },

    // ③ 过滤层（position 即执行顺序；strict=true 的永不被兜底放宽）
    filters: RULE_FILTERS.map((f) => ({ ...f })),

    // ④ 空集兜底范围（只在冷却/并发上兜底；授权与黑名单永不放宽）
    emptySetFallback: {
      appliesTo: [ADMISSION_REASON.COOLDOWN, ADMISSION_REASON.CONCURRENCY],
      excludes: [ADMISSION_REASON.BILLING, ADMISSION_REASON.BLACKLIST],
      note: '空集只在冷却/并发上兜底，授权与黑名单永不放宽',
    },

    // ⑤ 冷却时长（**实际生效值**，不是文档值：页面显示必须等于真实行为）
    cooldowns: {
      busyMs,
      rateMs,
      maxMs,
      note: `并发满 ${busyMs / 1000}s（上游约 10s 才归还）起指数退避封顶 ${maxMs / 1000}s；429 独立冷却 base ${rateMs / 1000}s 指数退避封顶 ${maxMs / 1000}s`,
    },

    // ⑥ 闸门快照（每家 active/limit/ratio/coolingMs/streak429/failRate/failSamples）
    gate: gateSnap ?? {},

    // ⑦ 可设置项清单（**每一项都有后端读点**，见 adapter 的 applyRoutingConfig）
    configurable: [
      {
        path: 'routing.priority', label: '路由优先目标', type: 'select',
        options: [...ROUTING_PRIORITY_OPTIONS],
        value: conf.priority ?? ROUTING_DEFAULTS.priority,
        source: srcOf('priority'),
        effect: 'balanced/free-first = 现行排序（免费优先，不看花费）；reliability-first = 把失败率提到负载之前的对照排序',
      },
      {
        path: 'routing.autoSwitch', label: '自动选路', type: 'bool',
        value: conf.autoSwitch !== false,
        source: srcOf('autoSwitch'),
        effect: 'false ⇒ 关掉冷却重试/二次尝试/最后兜底，只走主循环，失败即如实上报',
      },
      {
        path: 'routing.cooldownMs', label: '失败冷却多久', type: 'number', unit: 'ms',
        value: busyMs,
        source: srcOf('cooldownMs'),
        effect: '闸门 busyCooldownMs：并发满后跳过多长时间（指数退避起点）',
      },
      {
        path: 'routing.rateCooldownMs', label: '被限流后等多久', type: 'number', unit: 'ms',
        value: rateMs,
        source: srcOf('rateCooldownMs'),
        effect: '闸门 rateLimitCooldownMs：429 后等待时长（指数退避起点，重试不放宽）',
      },
      {
        path: 'sources.limits.<id>', label: '每家渠道同时最多几个请求', type: 'number',
        value: limits,
        paths: limitPaths,          // 逐家的具体路径（页面可以直接 patch 其中任意一项）
        source: srcOf('limits'),
        effect: '闸门上限：满了不排队，直接降级下一个候选',
      },
      {
        path: 'routing.blacklistTtlMs', label: '失败后暂停多久', type: 'number', unit: 'ms',
        value: numOr(conf.blacklistTtlMs, ROUTING_DEFAULTS.blacklistTtlMs),
        source: srcOf('blacklistTtlMs'),
        effect: '终态失败（AUTH/404/权限…）拉黑时长；成功一次自动解除',
      },
    ],
  }
}

/**
 * 创建路由快照函数（注入式，便于单测；不读文件、不联网）。
 *
 * @param {object} o
 * @param {() => object|null} [o.adapterOf] 取当前 adapter（插件热重载后可能换实例）
 * @param {object|null} [o.hintRegistry] hint 注册表
 * @param {() => object|null} [o.gateOf] 取并发闸门
 * @param {() => number} [o.now]
 * @returns {() => object}
 */
export function createRoutingSnapshot({
  adapterOf = () => null,
  hintRegistry = null,
  gateOf = () => null,
  blacklistSnapshot = () => [],
  now = () => Date.now(),
} = {}) {
  const adapterNow = () => {
    try { return typeof adapterOf === 'function' ? adapterOf() : null } catch { return null }
  }
  const gateNow = () => {
    try { return typeof gateOf === 'function' ? gateOf() : null } catch { return null }
  }

  return function routingSnapshot() {
    const adapter = adapterNow()
    let lastAdmission = null
    try { lastAdmission = adapter?.admissionSnapshot?.() ?? null } catch { lastAdmission = null }
    let chain = []
    try { chain = adapter?.chainSnapshot?.() ?? [] } catch { chain = [] }
    // 黑名单：**优先用 adapter 的生效视图**（含 `routing.blacklistTtlMs` 覆盖后的 until，
    // 展示口径 = 真实拦截面）；adapter 没有该方法 ⇒ 回退注入的快照（老版本兼容）。
    let blacklist = []
    try {
      if (typeof adapter?.blacklistSnapshot === 'function') blacklist = adapter.blacklistSnapshot() ?? []
      else blacklist = typeof blacklistSnapshot === 'function' ? (blacklistSnapshot() ?? []) : []
    } catch { blacklist = [] }
    let hints = {}
    let hintCount = 0
    try {
      if (hintRegistry) {
        hints = hintRegistry.snapshot()
        hintCount = typeof hintRegistry.size === 'number' ? hintRegistry.size : Object.keys(hints).length
      }
    } catch { hints = {} }

    // ── 契约 A：切换成功统计（口径 A；adapter 缺失 ⇒ 全 0 结构，不假装有数据）──
    let switches = { ...EMPTY_SWITCHES, attempts: { total: 0, byProvider: {} } }
    try {
      const s = typeof adapter?.switchSnapshot === 'function' ? adapter.switchSnapshot() : null
      if (s && typeof s === 'object') {
        switches = {
          at: s.at ?? null,
          total: Number(s.total) || 0,
          byProvider: s.byProvider ?? {},
          byModel: s.byModel ?? {},
          attempts: {
            total: Number(s.attempts?.total) || 0,
            byProvider: s.attempts?.byProvider ?? {},
          },
          switchSuccessRate: Number.isFinite(s.switchSuccessRate) ? s.switchSuccessRate : null,
          last: s.last ?? null,
        }
      }
    } catch { /* 统计失败绝不影响快照 */ }

    const gateSnap = snapshotStats(gateNow())
    // 契约 B：生效路由配置（adapter 唯一事实来源；拿不到 ⇒ 全默认值）
    let rt = null
    try { rt = typeof adapter?.routingConfigSnapshot === 'function' ? adapter.routingConfigSnapshot() : null } catch { rt = null }

    return {
      ok: true,
      at: now(),
      version: HINTS_VERSION,
      // 授权默认值：没有任何 hint/metadata 时，adapter 一定按 free_only 跑（fail-closed）
      defaultBillingTier: 'free_only',
      lastAdmission,
      chain,
      gate: gateSnap,
      // 终态失败黑名单（诊断页展示 + 手动解除的依据）
      blacklist,
      hints,
      hintCount,
      // 契约 A4：切换成功统计（口径 A）
      switches,
      // 契约 B：复杂路由基本规则（只读展示 + 可配置项清单）
      rules: buildRoutingRules({ rt, gateSnap }),
    }
  }
}
