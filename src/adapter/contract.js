/**
 * cs-myfree — 宿主 LlmAdapter 契约适配
 *
 * 🔴 血泪教训（v1.1.1 之前 myfree 完全不可用的根因）：
 *    宿主对 adapter 的返回有**严格校验**，任何不符都会抛错，
 *    而我们的注册被 safeRegisterAdapter 静默吞掉 ⇒ 模型选择器里根本看不到。
 *
 * 实测契约（源码 `dsh-llm/lib/index.js`）：
 *   ① `registerAdapter(providers, adapter)` —— 第一参数是**数组**
 *   ② `providerInfo(p)` → `{ id: p, name }` —— **必须含 id 且等于 p**
 *   ③ `listModels(p)`   → 每项 `.provider === p`，`.id`/`.name` 非空
 *   ④ `resolveModel(p, m)` → `.provider === p` 且 `.id === m`
 *   ⑤ `context` 是**嵌套** `{ contextWindow }`，不是顶层 `contextWindow`
 *   ⑥ `prepareCall(p, m)` → `{ model: <modelInfo>, stream(options) }`
 *
 * @module cs-myfree/adapter/contract
 */

/** 构造符合契约的 providerInfo */
export function makeProviderInfo(provider, { name, label } = {}) {
  return { id: provider, name: name || label || provider }
}

/**
 * 构造符合契约的 modelInfo。
 * @param {string} provider
 * @param {{id:string, name?:string, contextWindow?:number, inputModalities?:string[], supportsVision?:boolean}} m
 */
export function makeModelInfo(provider, m = {}) {
  const mods = Array.isArray(m.inputModalities)
    ? m.inputModalities
    : (m.supportsVision ? ['text', 'image'] : ['text'])
  const info = {
    provider,
    id: String(m.id),
    name: String(m.name || m.id),
    inputModalities: mods,
  }
  // context 必须是嵌套对象且 contextWindow 为正整数
  const cw = Number(m.contextWindow)
  if (Number.isInteger(cw) && cw > 0) info.context = { contextWindow: cw }
  return info
}

/** 校验 providerInfo 是否合规（自检用） */
export function checkProviderInfo(info, provider) {
  const errs = []
  if (!info || typeof info !== 'object') errs.push('不是对象')
  else {
    if (typeof info.id !== 'string' || info.id !== provider) errs.push(`id 必须是 ${provider}`)
    if (typeof info.name !== 'string' || info.name.length === 0) errs.push('name 非空')
  }
  return { ok: errs.length === 0, errors: errs }
}

/** 校验 modelInfo 是否合规 */
export function checkModelInfo(info, provider, model) {
  const errs = []
  if (!info || typeof info !== 'object') errs.push('不是对象')
  else {
    if (info.provider !== provider) errs.push(`provider 必须是 ${provider}`)
    if (typeof info.id !== 'string' || info.id.length === 0) errs.push('id 非空')
    if (model !== undefined && info.id !== model) errs.push(`id 必须等于 ${model}`)
    if (typeof info.name !== 'string' || info.name.length === 0) errs.push('name 非空')
    if (info.context !== undefined) {
      const cw = info.context?.contextWindow
      if (!Number.isInteger(cw) || cw <= 0) errs.push('context.contextWindow 必须是正整数')
    }
    if (info.inputModalities !== undefined && !Array.isArray(info.inputModalities)) errs.push('inputModalities 必须是数组')
  }
  return { ok: errs.length === 0, errors: errs }
}
