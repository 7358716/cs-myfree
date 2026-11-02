/**
 * cs-myfree — 信任围栏（谁能改什么）
 *
 * 设计依据：v3 §12.4 权限收窄。核心是**默认拒绝**：
 *  · 读日志/审计做诊断          ✅ 允许
 *  · 改自己所属插件的配置        ✅ 允许（自动备份 + 审计）
 *  · 改全局 patch/profile 配置   ❌ 禁止
 *  · 重启 DSH                   ⚠️ 受限（仅无活跃轮次 + 限速 + 全审计）
 *  · 安装/升级依赖               ❌ 禁止
 *  · 删除/移动文件               ❌ 禁止（**永远人工确认**）
 *
 * @module cs-myfree/ops/trust
 */

export const ACTION = Object.freeze({
  READ_DIAG: 'read-diag',
  EDIT_OWN_CONFIG: 'edit-own-config',
  EDIT_GLOBAL_CONFIG: 'edit-global-config',
  RESTART: 'restart',
  INSTALL_DEPS: 'install-deps',
  DELETE_FILE: 'delete-file',
})

export const VERDICT = Object.freeze({ ALLOW: 'allow', DENY: 'deny', NEED_HUMAN: 'need-human' })

/** 默认策略：默认拒绝，只有明确列出的才放行 */
export const DEFAULT_POLICY = Object.freeze({
  [ACTION.READ_DIAG]: VERDICT.ALLOW,
  [ACTION.EDIT_OWN_CONFIG]: VERDICT.ALLOW,
  [ACTION.EDIT_GLOBAL_CONFIG]: VERDICT.DENY,
  [ACTION.RESTART]: VERDICT.ALLOW,          // 但有附加条件，见 check()
  [ACTION.INSTALL_DEPS]: VERDICT.DENY,
  [ACTION.DELETE_FILE]: VERDICT.NEED_HUMAN, // 永远人工确认
})

/** 重启限速：最小间隔 */
export const RESTART_MIN_INTERVAL_MS = 10 * 60 * 1000

/**
 * 判定一个动作是否允许。
 * @param {string} action
 * @param {{policy?:object, activeTurns?:number, lastRestartAt?:number, now?:number, humanConfirmed?:boolean}} ctx
 */
export function check(action, ctx = {}) {
  const policy = { ...DEFAULT_POLICY, ...(ctx.policy ?? {}) }
  const verdict = policy[action] ?? VERDICT.DENY

  if (verdict === VERDICT.NEED_HUMAN && ctx.humanConfirmed !== true) {
    return { verdict: VERDICT.NEED_HUMAN, reason: `${action} 需要人工确认（不可自动执行）` }
  }
  if (verdict === VERDICT.DENY) {
    return { verdict: VERDICT.DENY, reason: `${action} 被策略禁止` }
  }

  // 重启有附加闸门
  if (action === ACTION.RESTART) {
    const now = ctx.now ?? Date.now()
    if ((ctx.activeTurns ?? 0) > 0) {
      return { verdict: VERDICT.DENY, reason: `有 ${ctx.activeTurns} 个活跃轮次，此时重启会打断工作` }
    }
    if (ctx.lastRestartAt && now - ctx.lastRestartAt < RESTART_MIN_INTERVAL_MS) {
      const waitS = Math.ceil((RESTART_MIN_INTERVAL_MS - (now - ctx.lastRestartAt)) / 1000)
      return { verdict: VERDICT.DENY, reason: `重启限速中，还需等 ${waitS}s` }
    }
    return { verdict: VERDICT.ALLOW, reason: '无活跃轮次且未触发限速', mustAudit: true }
  }

  if (action === ACTION.EDIT_OWN_CONFIG) {
    return { verdict: VERDICT.ALLOW, reason: '允许改自有配置', mustBackup: true, mustAudit: true }
  }

  return { verdict: VERDICT.ALLOW, reason: '默认放行' }
}
