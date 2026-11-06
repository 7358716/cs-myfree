/**
 * cs-myfree — Phase 4 策略开关（**唯一的对照测量入口**）
 *
 * 背景（契约 v1.2 / Lead 裁决）：`failRate` 排在第 5 位会被第 3 位 `loadRatio`
 * 完全压制——弱源「空闲即优先」是错的；同时 429（请求级限流）用 15s（上游会话
 * 未归还的实测窗口）当冷却，会把免费池整段踢出，把 paid_allowed 会话推向付费源。
 *
 * 三种候选策略（只影响「排序」与「429 冷却时长」，**billing 硬过滤/pinned/
 * 空集兜底/降级链语义完全不变**）：
 *
 *   'v1.1'    tier→billing→loadRatio→last429At→failRate→_i ；429 冷却 = 15s（指数退避）
 *   'p2'      同上，但 failRate 提到 loadRatio 之前；429 冷却仍 15s
 *   'p3'      = p2 + 429 使用独立短冷却（3s 起，指数退避封顶 120s）
 *   'blended' tier→billing→(loadRatio+failRate)→last429At→_i ；429 冷却 15s
 *
 * 默认值 = **'blended'（契约 v1.3 定稿）**：paid 均值 6.46%→3.58%（−44.6%）、
 * 尝试均值 −12.5%、CV 0.642→0.414、子智能体重试 0.371→0.221（5 种子实测，见
 * test/evidence/phase4-policies.md）。'p2'/'p3' 已实测放弃（failRate 提前会加剧付费外溢）。
 *
 * @module cs-myfree/adapter/policy-switch
 */

/** 当前生效策略：'v1.1' | 'p2' | 'p3' | 'blended' */
export const PHASE4_POLICY = 'blended'

/** 429（请求级限流）的独立冷却基础值（仅 'p3' 生效；并发满仍走 15s 实测窗口） */
export const RATE_LIMIT_COOLDOWN_MS = 3_000

/** 排序是否把可靠性（failRate）放到负载之前 */
export function usesFailRateFirst() {
  return PHASE4_POLICY === 'p2' || PHASE4_POLICY === 'p3'
}

/** 排序是否使用「负载 + 失败率」合成分数 */
export function usesBlendedScore() {
  return PHASE4_POLICY === 'blended'
}

/** 429 是否使用独立短冷却（与并发满的 15s 分开） */
export function usesShortRateLimitCooldown() {
  return PHASE4_POLICY === 'p3'
}
