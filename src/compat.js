/**
 * cs-myfree — 宿主兼容层（永不抛错）
 *
 * 背景：DSH 0.1.x/0.2.0-rc1/0.2.1-rc2 之间 API 有差异。
 * 插件一旦在加载期抛错，宿主会报 `N entry did not activate`
 * 并**落进恢复模式自动禁用插件** —— 表现为「重启就起不来，必须禁用插件」。
 *
 * 铁律：**本模块任何函数都不允许抛错**。拿不到能力就降级，绝不让宿主挂掉。
 *
 * @module cs-myfree/compat
 */

/** 安全地探测一个对象上是否有某方法 */
export function has(obj, key) {
  try { return obj != null && typeof obj[key] === 'function' } catch { return false }
}

/** 安全调用（吞掉异常，返回 fallback） */
export function safeCall(fn, fallback = undefined, ...args) {
  try {
    if (typeof fn !== 'function') return fallback
    return fn(...args)
  } catch {
    return fallback
  }
}

/** 解析宿主版本（拿不到返回 null，不抛） */
export function detectHostVersion(ctx) {
  try {
    const v = ctx?.app?.version ?? ctx?.version ?? ctx?.reflect?.version ?? null
    return typeof v === 'string' ? v : null
  } catch { return null }
}

/** 解析主版本号（如 '0.2.1-rc.2' → [0,2,1]） */
export function parseVersion(v) {
  try {
    const m = String(v ?? '').match(/^(\d+)\.(\d+)\.(\d+)/)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  } catch { return null }
}

/**
 * 日志器：宿主没 logger 就退化到 console，再不行就静默。
 * ⚠️ 任何情况下都不抛。
 */
export function makeLogger(ctx, name) {
  const prefix = `[${name}]`
  const tryLog = (level, msg, extra) => {
    try {
      const l = ctx?.logger
      if (l && typeof l[level] === 'function') { l[level](`${prefix} ${msg}`, extra); return }
      if (l && typeof l.info === 'function') { l.info(`${prefix} ${msg}`); return }
      if (typeof console !== 'undefined' && console[level]) console[level](`${prefix} ${msg}`)
    } catch { /* 连日志都失败就算了，绝不抛 */ }
  }
  return {
    info: (m, e) => tryLog('info', m, e),
    warn: (m, e) => tryLog('warn', m, e),
    debug: (m, e) => tryLog('debug', m, e),
    error: (m, e) => tryLog('error', m, e),
  }
}

/**
 * 安全地注册 effect（宿主没有 effect 就跳过）。
 * @returns {boolean} 是否注册成功
 */
export function safeEffect(ctx, factory, label) {
  try {
    if (!has(ctx, 'effect')) return false
    ctx.effect(factory, label)
    return true
  } catch { return false }
}

/**
 * 安全地注入服务（宿主没有 inject 就跳过）。
 * ⚠️ 关键：inject 等待的服务若不存在，子 fiber 会一直 pending ——
 *    但这**不影响**父插件激活。真正危险的是 inject 本身不存在时抛错。
 * @returns {boolean} 是否注册成功
 */
export function safeInject(ctx, services, callback, label) {
  try {
    if (!has(ctx, 'inject')) return false
    ctx.inject(services, callback, label)
    return true
  } catch { return false }
}

/** 安全地 provide（宿主没有 provide 就跳过） */
export function safeProvide(ctx, key, value) {
  try {
    if (!has(ctx, 'provide')) return false
    ctx.provide(key, value)
    return true
  } catch { return false }
}

/** 安全地注册 adapter（宿主没有 registerAdapter 就跳过） */
export function safeRegisterAdapter(llm, id, adapter) {
  try {
    if (!has(llm, 'registerAdapter')) return false
    llm.registerAdapter(id, adapter)
    return true
  } catch { return false }
}

/** 安全地注册搜索 provider */
export function safeRegisterSearch(web, provider) {
  try {
    if (!has(web, 'registerSearchProvider')) return false
    web.registerSearchProvider(provider)
    return true
  } catch { return false }
}

/**
 * 兜底包装：把整个 apply 包起来，**任何异常都不外泄**。
 * @param {(ctx:any, config:any)=>void} fn
 * @param {string} name
 */
export function guardApply(fn, name) {
  return function guardedApply(ctx, config) {
    let log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
    try { log = makeLogger(ctx, name) } catch { /* ignore */ }
    try {
      log.info(`加载中（宿主版本 ${detectHostVersion(ctx) ?? '未知'}）`)
      fn(ctx, config)
      log.info('加载完成')
    } catch (err) {
      // 🔴 绝不 rethrow：让宿主继续启动，只是本插件功能不可用
      try {
        log.error(`加载失败（已降级，不影响宿主启动）：${err?.message ?? err}`)
        if (err?.stack) log.debug(String(err.stack).slice(0, 800))
      } catch { /* ignore */ }
    }
  }
}
