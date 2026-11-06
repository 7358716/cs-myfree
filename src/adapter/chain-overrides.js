/**
 * cs-myfree — 降级链覆盖层（用户自主配置的核心）
 *
 * 设计依据：v3 §3.4。现状缺口（实测）：
 *   · `GET /chain` 只读，链是模块级 const，全仓无写回路径
 *   · 用户只能「切当前会话模型」，不能「钉选 / 替换 / 增删 / 重排序」
 *
 * 本模块提供**纯函数**的合并与校验逻辑（无 I/O，易测），
 * 原子落盘由 storage.js 负责。
 *
 * 三条铁律（否则重演「降级链不生效」事故）：
 *  1. 生效链 = merge(builtin, overrides)，**只有一个入口**
 *  2. 页面展示与实际选路**必须走同一函数**（chainSummary 也调它）
 *  3. 写回用**整表覆盖**（简单、可审计、易还原）
 *
 * @module cs-myfree/adapter/chain-overrides
 */

/** 允许的 tier（与 v3 §3.3 的 6 层对齐：L1..L5 可配置，L0 是重试不占 tier） */
export const TIERS = Object.freeze([1, 2, 3, 4, 5])

/** 一条链成员的合法形状 */
export function isValidEntry(e) {
  return Boolean(e)
    && typeof e.provider === 'string' && e.provider.trim() !== ''
    && typeof e.model === 'string' && e.model.trim() !== ''
    && (e.tier === undefined || TIERS.includes(e.tier))
}

/** 归一化一条成员：补默认 tier、去空白、只保留已知字段（防注入） */
export function normalizeEntry(e, index = 0) {
  if (!isValidEntry(e)) return null
  const out = {
    provider: String(e.provider).trim(),
    model: String(e.model).trim(),
    tier: e.tier ?? 1,
  }
  if (e.paid === true) out.paid = true
  // 🔴 disabled：内置链里的条目无法「物理删除」，用禁用条剔除（用户实测反馈：
  //    kilo/ovh 在页面删掉后又回来 —— 因为只在覆盖层删了，内置链还在）
  if (e.disabled === true) out.disabled = true
  // 上下文容量：必须透传，否则 adapter 拿不到 ⇒ 宿主不压缩 ⇒ 会话越跑越断
  const cw = Number(e.contextWindow)
  if (Number.isInteger(cw) && cw > 0) out.contextWindow = cw
  if (typeof e.note === 'string' && e.note.trim() !== '') out.note = e.note.trim()
  out._i = index
  return out
}

/**
 * 归一化一张链（别名 → 真实源 id + 去重），**不改磁盘**（纯函数）。
 *
 * 🔴 为什么需要：用户可能在「降级链」页面手填 `kilo-free`（旧插件时代的名字），
 *    或历史配置里有别名。若不做映射，adapter 会把同一源当成两个候选，
 *    或发送时报「未知供应源」。UI 写回与 adapter 启动读取必须走**同一函数**。
 *
 * @param {Array} list 原始条目
 * @param {(id:string)=>string} resolve 别名解析器（认不出原样返回）
 * @returns {Array} 归一化后的条目（保持原顺序，同 provider+model 只留第一条）
 */
export function normalizeChainAliases(list = [], resolve = (x) => x) {
  const out = []
  const seen = new Set()
  for (const e of Array.isArray(list) ? list : []) {
    const n = normalizeEntry(e)
    if (!n) continue
    let provider = n.provider
    try { provider = String(resolve(n.provider) ?? n.provider) } catch { /* 解析失败用原值 */ }
    const key = `${provider}\u0000${n.model}`
    if (seen.has(key)) continue
    seen.add(key)
    const next = { provider, model: n.model, tier: n.tier }
    if (n.paid === true) next.paid = true
    // 🔴 disabled 必须透传：本函数用于「启动时读磁盘链 → adapter」，若在此丢弃，
    //    mergeChain() 收不到禁用标记 ⇒ 用户禁用的源（kilo/buddy/qoder）重启后又回到链里，
    //    首次失败就会降级到坏源（2026-11-06 09:36 对话输出污染事故）。
    if (n.disabled === true) next.disabled = true
    if (n.note) next.note = n.note
    out.push(next)
  }
  return out
}

/**
 * 校验并归一化整张覆盖表（整表覆盖语义）。
 * @returns {{ok:boolean, entries?:Array, errors?:string[]}}
 */
export function validateOverrides(raw) {
  const errors = []
  if (raw === null || typeof raw !== 'object') return { ok: false, errors: ['覆盖表必须是对象'] }
  const list = Array.isArray(raw.chain) ? raw.chain : null
  if (!list) return { ok: false, errors: ['缺少 chain 数组'] }
  if (list.length > 200) errors.push('链过长（>200 条）')

  const entries = []
  list.forEach((e, i) => {
    const n = normalizeEntry(e, i)
    if (!n) errors.push(`第 ${i + 1} 条无效（provider/model 必填，tier ∈ ${TIERS.join('/')}）`)
    else entries.push(n)
  })

  // 去重：同 provider+model 只保留第一条（防用户重复添加导致重复计费）
  const seen = new Set()
  const dedup = []
  for (const e of entries) {
    const k = `${e.provider}\u0000${e.model}`
    if (seen.has(k)) { errors.push(`重复条目：${e.provider}/${e.model}（已忽略后出现的）`); continue }
    seen.add(k); dedup.push(e)
  }

  return errors.length ? { ok: false, entries: dedup, errors } : { ok: true, entries: dedup, errors: [] }
}

/**
 * 合并：生效链 = builtin ∪ overrides（**唯一入口**）。
 *
 * 语义（刻意简单，避免"看不懂为什么选了这个模型"）：
 *  · overrides 里出现的 provider+model → **替换** builtin 中同键条目的 tier（保留顺序位）
 *  · overrides 里 builtin 没有的 → **追加**到对应 tier 末尾
 *  · overrides 显式 `disabled:true` 的 → 从 builtin 中剔除
 *
 * @param {Array} builtin 内置链
 * @param {Array} overrides 用户覆盖（已 validate）
 * @returns {Array} 生效链（按 tier 升序、同 tier 保持原相对顺序）
 */
export function mergeChain(builtin = [], overrides = []) {
  const base = (Array.isArray(builtin) ? builtin : []).map(normalizeEntry).filter(Boolean)
  const ov = (Array.isArray(overrides) ? overrides : []).map(normalizeEntry).filter(Boolean)

  const ovByKey = new Map()
  for (const e of ov) ovByKey.set(`${e.provider}\u0000${e.model}`, e)
  const baseKeys = new Set(base.map((e) => `${e.provider}\u0000${e.model}`))

  // 禁用集合：覆盖层里 disabled:true 的条目 ⇒ 从生效链中剔除（内置 + 覆盖都剔）
  const disabledKeys = new Set(ov.filter((e) => e.disabled === true).map((e) => `${e.provider}\u0000${e.model}`))

  const out = []
  for (const e of base) {
    const k = `${e.provider}\u0000${e.model}`
    if (disabledKeys.has(k)) continue                       // 🔴 用户禁用 ⇒ 不生效
    const o = ovByKey.get(k)
    if (o) out.push({ ...e, tier: o.tier, paid: o.paid === true ? true : e.paid, note: o.note ?? e.note })
    else out.push(e)
  }
  for (const e of ov) {
    const k = `${e.provider}\u0000${e.model}`
    if (e.disabled === true) continue                       // 禁用的是剔除，不是新增
    if (!baseKeys.has(k)) out.push(e)
  }

  // 稳定排序：tier 升序，同 tier 保持插入顺序
  return out
    .map((e, i) => ({ ...e, _i: i }))
    .sort((a, b) => (a.tier - b.tier) || (a._i - b._i))
}

/** 按 tier 分组（页面与选路共用，保证「显示 == 实际」） */
export function groupByTier(chain = []) {
  const g = new Map()
  for (const e of chain) {
    if (!g.has(e.tier)) g.set(e.tier, [])
    g.get(e.tier).push(e)
  }
  return [...g.entries()].sort((a, b) => a[0] - b[0])
}

/** 链摘要（`/state` 与页面都调它 —— 铁律2） */
export function chainSummary(chain = []) {
  return groupByTier(chain).map(([tier, list]) => ({
    tier,
    count: list.length,
    providers: [...new Set(list.map((e) => e.provider))],
    entries: list.map((e) => `${e.provider}/${e.model}`),
  }))
}
