/**
 * cs-myfree — 渠道能力表（**唯一声明处**）
 *
 * 解决的问题（用户实测 2026-11-15）：
 *   「有些对话报错当前模型不支持图片」
 *   根因：`catalog.js` 把**所有**渠道模型写死 `inputModalities: ['text']`，
 *   宿主 `dsh-llm:2342` 见 text-only 就把图片投影成占位符 ⇒ 模型永远看不到图。
 *
 * 纪律（fail-closed）：
 *   · 只声明**有实测依据**的能力；未确认的一律按 text-only 处理
 *   · 「声称支持但上游报错」比「不支持」糟得多
 *
 * @module cs-myfree/pools/channels/capabilities
 */

/**
 * 各渠道是否**原生收图**（不需要 myfree 的视觉桥）。
 *
 * 判定依据（逐家核对，2026-11-15）：
 *   · workbuddy  —— 用户实测会话 `workbuddy/deepseek-v4.1-flash` 可收图（真机验证）
 *   · buddy      —— 与 workbuddy 同族（腾讯 CodeBuddy），同一套上游
 *   · loomy      —— 讯飞 Loomy，deepseek-v4-flash 系列多模态
 *   · codearts   —— 含 Qwen3-VL / kimi-k2.6-vl 等视觉模型，但**按模型区分**（见 MODEL_VISION）
 *   · officeace  —— 华为 MaaS，多模态模型存在，但未逐一实测 ⇒ 不整体声明
 *
 * 未列出的渠道 ⇒ text-only（保守）。
 */
export const CHANNEL_VISION = Object.freeze({
  workbuddy: true,
  buddy: true,
  loomy: true,
})

/**
 * **按具体模型**声明视觉能力（优先级高于渠道级）。
 *
 * 为什么需要：codearts 里既有纯文本模型，也有视觉模型，
 * 整体声明会造成「声称支持 → 上游 400」。所以按模型名精确匹配。
 *
 * 匹配规则：`modelId.toLowerCase().includes(任一关键词)` ⇒ 视觉
 */
export const MODEL_VISION_KEYWORDS = Object.freeze({
  codearts: ['vl', 'vision', 'kimi-k2', 'qwen3-vl'],
})

/**
 * 判断某渠道的某模型是否原生支持图片输入。
 *
 * @param {string} channelId 渠道 id（如 `workbuddy`）
 * @param {string} modelId 模型 id（如 `deepseek-v4.1-flash`）
 * @param {string[]} [upstreamModalities] 上游 `/v1/models` 返回的 input_modalities（若有，**优先**）
 * @returns {boolean}
 */
export function channelSupportsVision(channelId, modelId, upstreamModalities = null) {
  // ① 上游自己说了算（最权威）
  if (Array.isArray(upstreamModalities) && upstreamModalities.length > 0) {
    return upstreamModalities.includes('image')
  }
  // ② 按模型关键词（codearts 这类「混合渠道」）
  const kws = MODEL_VISION_KEYWORDS[channelId]
  if (Array.isArray(kws) && kws.length > 0) {
    const m = String(modelId ?? '').toLowerCase()
    if (kws.some((k) => m.includes(String(k).toLowerCase()))) return true
    // 该渠道有按模型区分的规则 ⇒ 不命中的模型视为 text-only
    return false
  }
  // ③ 渠道级声明
  return CHANNEL_VISION[channelId] === true
}

/**
 * 生成某渠道模型的 `inputModalities` 数组。
 *
 * @param {string} channelId
 * @param {string} modelId
 * @param {string[]} [upstreamModalities]
 * @returns {string[]} `['text']` 或 `['text','image']`
 */
export function inputModalitiesFor(channelId, modelId, upstreamModalities = null) {
  return channelSupportsVision(channelId, modelId, upstreamModalities)
    ? ['text', 'image']
    : ['text']
}