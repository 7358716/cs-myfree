/**
 * cs-myfree — 浏览器半身（骨架 v0.1.0）
 *
 * ⚠️ 约束（v3 §9.3）：客户端半身**必须单文件**（浏览器 require 不支持相对路径）。
 * 当前为骨架：只注册一个占位设置分节，不做渲染。
 *
 * @module cs-myfree/client
 */

const NAME = 'cs-myfree'

export const name = `${NAME}-client`
export const version = '0.1.0'

/**
 * 客户端入口。
 * 用自有 id `cs-myfree`（settings.section 已被 5 个内置页占用，复用会替换别人 cell）。
 */
export function apply(ctx) {
  ctx.slots?.inject?.('settings.section', () => ({
    id: `${NAME}-section`,
    name: `${NAME}-section`,
    label: 'cs-myfree',
    order: 200,
    render: () => null,
  }))
}
