/**
 * cs-myfree — **路由 hint 旁路注册表**（billing_tier 授权标签的唯一实际通道）
 *
 * 设计依据：`design/17-并发感知路由层-接口契约-v1.md` §3（冻结）。
 *
 * ## 为什么必须"旁路"
 *
 * 宿主把请求对象 `{...config, messages, tools?, toolHistory, sessionId, signal}`
 * **冻结**后交给 adapter（`Object.freeze`，见 dsh-agent-loop/lib/index.js:1286）。
 * 物理上报错：改了也不生效，且严格模式会抛。而平台侧（cs-bots）需要按任务
 * 复杂度告诉 adapter「这一轮可以付费」——这份信息只能**放在请求对象之外**。
 *
 * 通道设计（两条，互为兜底）：
 *   1. `globalThis[Symbol.for('cs-myfree.routing.hints.v1')]` —— 跨插件唯一入口
 *      （cs-bots 只认这个符号，读不到就静默跳过 ⇒ cs-myfree 默认 free_only）
 *   2. cordis 服务 `csMyfreeRouting` —— 可发现面（由 `src/index.js` 提供）
 *
 * ## 安全纪律
 *
 * · **授权只降不升**：解析失败/过期/缺失 ⇒ `free_only`（fail-closed）。
 * · **纯内存、无 I/O**：不写盘、不联网，进程重启即清空（授权不该持久化）。
 * · **TTL + 容量上限**：hint 是"这一轮/这一段"的临时意图，30 分钟后自动失效，
 *   防止一个泄漏的 `paid_allowed` 长期挂在某个 sessionId 上。
 *
 * ## 版本史
 *
 * · **v1**（`design/17` §3）：六键 —— billing_tier / complexity_tier / agent_role /
 *   requires_paid / source / at。
 * · **v2**（`design/22` 契约 E1）：v1 六键**语义不变**，另加两个可选键
 *   `follow_parent_routing` / `pinned_model`（子智能体路由跟随策略）。
 *   兼容口径：**v1 客户端发的六键 hint 必须被正常接受**（新键缺省 ⇒ null）；
 *   非法新键 ⇒ null 而**不拒绝整条 hint**；未知键 ⇒ 丢弃。
 *
 * @module cs-myfree/adapter/routing-hints
 */

/**
 * hint 契约版本（跨仓冻结；形状变化必须升版本）
 *
 * v1 → v2（`design/22` 契约 E1）：新增两个**可选**键
 *   `follow_parent_routing: boolean|null` / `pinned_model: string|null`
 *   （子智能体路由跟随策略）。**v1 客户端发来的六键 hint 仍然完全合法**
 *   —— 缺新键即归一为 `null`（= 未声明），绝不因此拒收整条 hint。
 *   符号名 `cs-myfree.routing.hints.v1` **刻意不改**：它是跨插件发现地址，
 *   改了老 cs-bots 就找不到注册表（版本由 `version` 字段承担，不由符号承担）。
 */
export const HINTS_VERSION = 2

/** 跨插件唯一入口（cs-bots 用同一个 `Symbol.for` 取注册表） */
export const HINTS_SYMBOL = Symbol.for('cs-myfree.routing.hints.v1')

/** hint 默认有效期：30 分钟 */
export const HINTS_TTL_MS = 30 * 60 * 1000

/** 默认容量上限（超出按插入时间淘汰最旧） */
export const HINTS_MAX_ENTRIES = 4096

/** 子智能体路由策略取值（`config/scope.js` 的 `subagentRouting.mode` 同一口径） */
export const SUBAGENT_ROUTING_MODES = Object.freeze(['auto', 'pinned', 'follow'])

/** `pinned_model` 长度上限（防御超长噪音把 hint 撑大） */
export const PINNED_MODEL_MAX_LEN = 128

/**
 * 归一化 `follow_parent_routing`（v2 新增键）。
 *
 * 语义：`true` = 子智能体跟随上级路由（继承上级授权与选路）；
 *       `false` = 明确**不**跟随；`null` = 未声明（按 `subagentRouting.mode` 兜底）。
 * 非布尔（含 `undefined`、`'true'`、`1`）一律 `null` —— **不拒绝整条 hint**。
 *
 * @param {unknown} value
 * @returns {boolean|null}
 */
export function normalizeFollowParentRouting(value) {
  return typeof value === 'boolean' ? value : null
}

/**
 * 归一化 `pinned_model`（v2 新增键）：`'provider/model'` 或裸模型名。
 *
 * 非字符串 / 空白 / 含空白或控制字符 / 超长 ⇒ `null`（= 不固定模型），
 * **不拒绝整条 hint**：非法的新键只是没声明，v1 六键语义照旧成立。
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizePinnedModel(value) {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s) return null
  // 模型名形状约束：不允许空白/控制字符（`provider/model` 或裸模型名都不含空格）
  if (/[\s\u0000-\u001F\u007F]/.test(s)) return null
  return s.slice(0, PINNED_MODEL_MAX_LEN)
}

const VALID_TIER = new Set(['paid_allowed', 'free_only'])
const VALID_COMPLEXITY = new Set(['T0', 'T1', 'T2', 'T3'])
const VALID_ROLE = new Set(['main', 'subagent', 'unknown'])

/**
 * 归一化一个 hint（**非法值返回 null**，调用方据此拒绝写入）。
 *
 * 形状（契约 §3 v1 六键 + `design/22` 契约 E1 v2 两键）：
 *   { billing_tier, complexity_tier|null, agent_role, requires_paid, source, at,
 *     follow_parent_routing|null, pinned_model|null }
 *
 * 兼容纪律（契约 E1 明确要求）：
 *   · `billing_tier` 是**唯一**必需字段，缺失/非法 ⇒ 拒绝（fail-closed，授权只降不升）；
 *   · 两个 v2 新键是**可选**的：缺省/非法一律归一为 `null`（= 未声明），
 *     **绝不因此拒绝整条 hint** —— 否则 v1 客户端（cs-bots 旧版）发的六键 hint
 *     会整条被丢，子智能体的 task 授权直接失效（功能静默消失，比报错更难查）。
 *   · 未知键（不在上面形状里的）一律**丢弃**：本函数只产出白名单字段。
 *
 * @param {object} hint
 * @param {() => number} now
 * @returns {object|null}
 */
export function normalizeHint(hint, now = () => Date.now()) {
  if (!hint || typeof hint !== 'object') return null
  const tier = typeof hint.billing_tier === 'string' ? hint.billing_tier.trim().toLowerCase() : ''
  if (!VALID_TIER.has(tier)) return null        // 必需字段缺失/非法 ⇒ 拒绝（fail-closed）

  const complexity = typeof hint.complexity_tier === 'string' && VALID_COMPLEXITY.has(hint.complexity_tier)
    ? hint.complexity_tier
    : null
  const role = typeof hint.agent_role === 'string' && VALID_ROLE.has(hint.agent_role)
    ? hint.agent_role
    : 'unknown'
  const at = Number.isFinite(hint.at) && hint.at > 0 ? hint.at : now()

  return Object.freeze({
    billing_tier: tier,
    complexity_tier: complexity,
    agent_role: role,
    requires_paid: hint.requires_paid === true,
    source: typeof hint.source === 'string' && hint.source.trim() !== '' ? hint.source.trim().slice(0, 64) : 'unknown',
    at,
    // ── v2 新增（可选）：缺省即 null = 未声明（v1 六键 hint 走这里） ──
    follow_parent_routing: normalizeFollowParentRouting(hint.follow_parent_routing),
    pinned_model: normalizePinnedModel(hint.pinned_model),
  })
}

/** 诊断用：sessionId 脱敏（只留首尾，避免把会话标识原样暴露在页面/日志） */
export function maskSessionId(sessionId) {
  const s = String(sessionId ?? '')
  if (s.length <= 8) return s ? `${s.slice(0, 2)}***` : ''
  return `${s.slice(0, 4)}***${s.slice(-4)}`
}

/**
 * 创建 hint 注册表（纯内存）。
 *
 * @param {object} [o]
 * @param {() => number} [o.now] 注入时钟（测试用）
 * @param {number} [o.ttlMs] 有效期（默认 30 分钟）
 * @param {number} [o.maxEntries] 容量上限（默认 4096）
 */
export function createHintRegistry({
  now = () => Date.now(),
  ttlMs = HINTS_TTL_MS,
  maxEntries = HINTS_MAX_ENTRIES,
} = {}) {
  /** sessionId -> { hint, storedAt } */
  const map = new Map()

  const isExpired = (entry, at) => (at - entry.storedAt) >= ttlMs

  /** 清掉所有过期项（get/set/snapshot 都会顺手清，避免内存无限增长） */
  const pruneExpired = (at) => {
    for (const [k, v] of map) if (isExpired(v, at)) map.delete(k)
  }

  /** 容量淘汰：按 storedAt 升序删最旧，直到 size < maxEntries */
  const evictIfNeeded = (at) => {
    pruneExpired(at)
    const cap = Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : HINTS_MAX_ENTRIES
    while (map.size >= cap) {
      let oldestKey = null
      let oldestAt = Infinity
      for (const [k, v] of map) {
        if (v.storedAt < oldestAt) { oldestAt = v.storedAt; oldestKey = k }
      }
      if (oldestKey === null) break
      map.delete(oldestKey)
    }
  }

  const api = {
    version: HINTS_VERSION,

    /**
     * 写入 hint（同 sessionId **覆盖**）。
     * @returns {object|null} 归一化后的 hint；非法输入返回 null（不写入）
     */
    set(sessionId, hint) {
      const key = String(sessionId ?? '').trim()
      if (!key) return null
      const normalized = normalizeHint(hint, now)
      if (!normalized) return null
      const at = now()
      evictIfNeeded(at)
      map.delete(key)
      map.set(key, { hint: normalized, storedAt: at })
      return normalized
    },

    /** 读取 hint（过期返回 null，并顺手删除） */
    get(sessionId) {
      const key = String(sessionId ?? '').trim()
      if (!key) return null
      const entry = map.get(key)
      if (!entry) return null
      const at = now()
      if (isExpired(entry, at)) { map.delete(key); return null }
      return entry.hint
    },

    /** 删除（授权撤销/会话结束） */
    clear(sessionId) {
      return map.delete(String(sessionId ?? '').trim())
    },

    /** 诊断快照（**脱敏**：sessionId 掩码 + 只含 hint 本身，不含任何凭据） */
    snapshot() {
      const at = now()
      pruneExpired(at)
      const out = {}
      for (const [k, v] of map) {
        out[maskSessionId(k)] = { ...v.hint, ageMs: Math.max(0, at - v.storedAt) }
      }
      return out
    },

    /** 当前有效条目数 */
    get size() {
      pruneExpired(now())
      return map.size
    },

    /** 清空（测试/热重载用） */
    clearAll() {
      map.clear()
    },
  }

  // ── 契约名别名（`design/17` §3 冻结的方法名）──
  //
  // 🔴 为什么必须对齐：cs-bots 的发现条件是 `globalThis[...].api.setRequestHint`
  //    是函数。这里只暴露 set/get 时，对方判定「cs-myfree 未安装」⇒ hint 一条
  //    都写不进去 ⇒ 改造 3 全链路静默空转（Lead 集成复核实测到该漂移）。
  //    别名指向**同一实现**（不是复制逻辑），`set/get/clear` 保留给旧调用方。
  api.setRequestHint = api.set
  api.getRequestHint = api.get
  api.clearRequestHint = api.clear

  return api
}

/** 跨仓契约要求的方法名（缺任一 ⇒ 视为不可用，绝不装一半） */
export const HINTS_REQUIRED_METHODS = Object.freeze(['setRequestHint', 'getRequestHint', 'clearRequestHint'])

/**
 * 安装到 `globalThis[HINTS_SYMBOL]`（cs-bots 通过同一符号发现）。
 * @param {object} registry
 * @returns {boolean}
 */
export function installGlobalHints(registry) {
  if (!registry) return false
  // 契约名必须齐全：缺任一 ⇒ 装上去对方也读不到（宁可明确失败 + 上层 warn）
  const missing = HINTS_REQUIRED_METHODS.filter((k) => typeof registry[k] !== 'function')
  if (missing.length > 0) return false
  try {
    globalThis[HINTS_SYMBOL] = { version: HINTS_VERSION, api: registry }
    return true
  } catch {
    return false   // 极端环境（冻结的 globalThis）⇒ 仍可走 cordis 服务
  }
}

/**
 * 仍可读取的最低 hint 契约版本。
 *
 * 为什么不是「版本必须等于 HINTS_VERSION」：同机可能出现**两份 cs-myfree**
 * （profile 安装版 + link 源码版），其中一份仍按 v1 装注册表。读侧一律要求
 * 版本严格相等的话，v2 代码会把 v1 注册表判成「未安装」⇒ 整条授权链路静默
 * 降级成 free_only（功能消失但不报错）。故读侧接受 `[1, HINTS_VERSION]`：
 * v1 注册表里的 hint 只是缺两个新键（消费方按 `null`/`undefined` 兜底），语义仍正确。
 */
export const MIN_SUPPORTED_HINTS_VERSION = 1

/**
 * 取全局注册表。
 * @returns {object|null} 未安装（如 cs-bots 单独安装、或 cs-myfree 未启动）⇒ null
 */
export function getGlobalHints() {
  try {
    const bag = globalThis[HINTS_SYMBOL]
    if (!bag) return null
    const version = Number(bag.version)
    if (!Number.isFinite(version)) return null
    if (version < MIN_SUPPORTED_HINTS_VERSION || version > HINTS_VERSION) return null
    const api = bag.api
    if (!api || typeof api.get !== 'function') return null
    return api
  } catch {
    return null
  }
}

/** 卸载（测试用） */
export function uninstallGlobalHints() {
  try { delete globalThis[HINTS_SYMBOL] } catch { /* ignore */ }
}
