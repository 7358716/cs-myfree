/**
 * cs-myfree — 免费模型提供方（骨架 v0.1.0）
 *
 * 设计依据：design/08-架构设计方案-v3终版.md
 *
 * ⚠️ 三条必须遵守的纪律（来自 v3 §4.4 / 评审 M4/M6）：
 *  1. `inject` 只声明 ['llm'] —— 缺服务只降级功能，绝不让整插件不激活
 *  2. 所有 `@deepseek-ai/*` 的 import 只允许出现在 adapter/kernel.js 一处
 *  3. 对内联渠道层：切断 agent 钩子（见 cordis.patch.yml 与验收断言）
 *
 * @module cs-myfree
 */

const NAME = 'cs-myfree'
const VERSION = '0.1.0'

export const name = NAME
export const version = VERSION

/**
 * 插件入口。
 *
 * ⚠️ 刻意只声明 `llm`：cordis 对**未声明**的服务会让整条 fiber 停在 PENDING
 *（历史事故：v1.2.1 因缺 webServer 整插件不激活）。webServer 等一律走嵌套
 * `ctx.inject` 子 fiber，缺哪个只掉一个功能。
 */
export function apply(ctx) {
  const log = (m) => ctx.logger?.info?.(m)

  // ① 供给层：注册 adapter（后续接 §3.3 的 6 层降级链）
  //    当前为骨架，只建立 fiber 与日志，不做真实注册。
  ctx.inject(['llm'], (scoped) => {
    log(`[${NAME}] llm 服务已就绪（骨架：尚未注册 adapter）`)
    scoped.effect(() => () => { log(`[${NAME}] llm 子 fiber 已释放`) }, `${NAME}: llm`)
  })

  log(`[${NAME}] v${VERSION} 已加载（骨架版）`)
}
