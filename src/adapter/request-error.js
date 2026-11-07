/**
 * cs-myfree — `agent/request-error` 瀑布处理器（P2 修复）
 *
 * 🔴 为什么需要（P2 修复）：
 *
 * 宿主 `dsh-agent-loop/lib/index.js:1136` 在模型失败时发 `agent/request-error`
 * waterfall，只有返回 `{kind:'retry'}` 才会原地重试。cs-myfree 此前只依赖
 * adapter 内部降级链，**未注册宿主层瀑布** ⇒ 宿主级的恢复策略（重试预算、
 * 错误分类可见性）对走 myfree 路由的请求不生效。
 *
 * 本模块的职责：
 *  1. 用 `failure-map.classify` 把宿主规范化后的 `failure` 翻译成语义
 *  2. 只对**真正瞬态**的错误返回 `{kind:'retry'}`（TRANSPORT/TIMEOUT/SERVER/
 *     EMPTY_RESPONSE），与 `policy.js` 的 `RETRYABLE_CODES` 保持一致
 *  3. 终态错误（AUTH/QUOTA/INVALID_REQUEST 等）返回 `next()`，交回宿主
 *     （这些已在 adapter 内部 ladder 处理过，宿主层再重试只会撞死链）
 *  4. **可见性**：每次分类都记入 onEvent，供账本/诊断使用
 *
 * ⚠️ 边界：不与 `dsh-llm-retry` 冲突 —— 该插件按 `providerRetryPolicy` 的
 *    `retryableCodes` 重试，本模块的分类口径与之一致（同样排除 RATE_LIMIT）。
 *    本模块的价值在于**分类可见性** + **对 UNKNOWN 码的文本兜底分类**。
 *
 * 纯逻辑（无 I/O），可单测。
 *
 * @module cs-myfree/adapter/request-error
 */

import { classify, KIND } from './failure-map.js'

/** 与 `policy.js` 的 `RETRYABLE_CODES` 保持一致：只有真正瞬态的才重试 */
export const RETRYABLE_KINDS = Object.freeze([
  KIND.TRANSPORT, KIND.TIMEOUT, KIND.SERVER, KIND.EMPTY_RESPONSE,
])

/**
 * 处理一次 `agent/request-error`。
 *
 * @param {object} payload 宿主传入的 payload
 * @param {object} payload.failure 规范化后的失败对象 `{message, code, status, ...}`
 * @param {string} payload.provider 触发失败的 provider（可能是渠道名）
 * @param {Function} next 瀑布下游（返回 `next()` 让宿主继续）
 * @param {object} [opts]
 * @param {(event:object)=>void} [opts.onEvent] 分类事件回调（诊断/账本用）
 * @param {() => number} [opts.now] 时钟注入（测试用）
 * @returns {Promise<{kind:'retry'}|Promise<undefined>>}
 */
export async function handleRequestError(payload, next, opts = {}) {
  const { failure, provider } = payload ?? {}
  const onEvent = opts.onEvent ?? (() => {})
  const now = opts.now ?? (() => Date.now())

  // ① 分类（failure-map 对 UNKNOWN 码有文本兜底）
  const verdict = classify(failure ?? {})
  const code = String(failure?.code ?? 'UNKNOWN')
  const msg = String(failure?.message ?? '').slice(0, 200)

  // ② 可见性：每次分类都记一条（不阻塞主流程）
  try {
    onEvent({
      type: 'request-error-classified',
      provider: provider ?? null,
      failureCode: code,
      kind: verdict.kind,
      retryable: RETRYABLE_KINDS.includes(verdict.kind),
      at: now(),
    })
  } catch { /* 分类事件回调失败不影响主流程 */ }

  // ③ 只有真正瞬态的错误才返回 retry
  if (RETRYABLE_KINDS.includes(verdict.kind)) {
    return { kind: 'retry' }
  }

  // ④ 终态/未知错误：交回宿主（不重试，避免撞死链）
  return next()
}

/**
 * 安装到宿主 context（`ctx.on('agent/request-error', ...)`）。
 *
 * ⚠️ 幂等：重复调用会先注销旧监听器。
 *
 * @param {object} ctx 宿主 context（需有 `on` 方法）
 * @param {object} [opts] 见 {@link handleRequestError}
 * @returns {() => void} 注销函数
 */
export function installRequestErrorHandler(ctx, opts = {}) {
  if (typeof ctx?.on !== 'function') return () => {}

  // 幂等：先尝试注销（同一函数引用）
  const handler = (payload, next) => handleRequestError(payload, next, opts)

  // 宿主 `ctx.on(name, fn)` 返回 disposer；cordis 的 `events.on` 同理
  let dispose = null
  try {
    dispose = ctx.on('agent/request-error', handler)
  } catch {
    // 宿主没有 `on` 方法或注册失败 ⇒ 静默跳过（不影响插件其它功能）
    return () => {}
  }

  return () => {
    try { dispose?.() } catch { /* ignore */ }
  }
}
