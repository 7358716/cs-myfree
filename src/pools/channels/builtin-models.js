/**
 * cs-myfree — 内置模型兜底清单
 *
 * 🔴 为什么必须有（2026-11-03 实测）：
 *    多数渠道**不提供 OpenAI 形状的 `/v1/models` 端点**。
 *    ⇒ 只靠 API 拉清单 ⇒ 登录后模型列表永远为空 ⇒ 用户「登录了但选不到模型」。
 *
 * 修正（2026-11-03 渠道调研）：codearts **有**模型清单端点
 * `GET https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin`
 * （需 AK/SK 签名 + 头 `Agent-Type: PromptCenter`，实测 200 / 12 个模型）；
 * 旧注释「5 种路径全 404」是查错了 host（当时用的是 officeace 网关）。
 *
 * 策略：**拉 API 优先，失败回落内置清单**。
 *   内置清单宁可少而准，不要多而错（错的模型名会导致 404 / 静默错配）。
 *
 * 来源：本机 hub 源码（dsh-codearts-auth）里的模型常量 + 实测。
 *
 * @module cs-myfree/pools/channels/builtin-models
 */

/** 各渠道的 models 端点（实测/hub 源码，`null` = 该渠道不提供） */
export const MODELS_PATH = Object.freeze({
  codearts: '/v1/model/builtin',                   // 需签名 + Agent-Type: PromptCenter（实测 200/12 模型）
  buddy: null,
  workbuddy: null,
  lobsterai: null,
  qoder: null,
  qodercn: null,
  trae: null,
  cline: '/api/v1/ai/cline/recommended-models',
  loomy: null,
  raccoon: null,
  minimax: '/mavis/api/v1/models',
  minimaxintl: '/mavis/api/v1/models',
  zcode: null,
  opencode: '/v1/models',
  gemini: '/v1beta/models',
  officeace: '/v2/models',
  accio: null,
  qiniu: '/v1/models',
})

/**
 * 内置兜底模型清单。
 * ⚠️ 只放**确认存在**的模型名；不确定的不放（错名字比没有更糟）。
 */
export const BUILTIN_MODELS = Object.freeze({
  // ✅ 远端实测（2026-11-03，GET /v1/model/builtin 返回的 12 条，避免错名导致 404）
  codearts: [
    { id: 'GLM-5.2', name: 'GLM-5.2' },
    { id: 'Qwen3-VL-235B', name: 'Qwen3-VL-235B' },
    { id: 'kimi-k2.6-vl', name: 'Kimi K2.6 VL' },
    { id: 'openpangu-2.0-flash', name: 'openPangu 2.0 Flash' },
    { id: 'openpangu-2.0-pro', name: 'openPangu 2.0 Pro' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
    { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash' },
    { id: 'glm-5.2-sft-harmony', name: 'GLM-5.2 SFT Harmony' },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash (1017)' },
    { id: 'kimi-k3', name: 'Kimi K3' },
    { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro' },
  ],
  buddy: [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  ],
  workbuddy: [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'deepseek-v4.1-flash-sg', name: 'DeepSeek V4.1 Flash (SG)' },
  ],
  loomy: [
    { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  ],
  zcode: [
    { id: 'glm-5.3', name: 'GLM-5.3' },
    { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash' },
    { id: 'glm-5.2', name: 'GLM-5.2' },
    { id: 'glm-5v-turbo', name: 'GLM-5V Turbo' },
  ],
  trae: [
    { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek V4 Flash (Official)' },
  ],
  qoder: [
    { id: 'qfmodel', name: 'GLM-5.3-Flash' },
    { id: 'gfmodel', name: 'GLM-5.3' },
  ],
  qodercn: [
    { id: 'qfmodel', name: 'GLM-5.3-Flash' },
    { id: 'gfmodel', name: 'GLM-5.3' },
  ],
  lobsterai: [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  ],
  raccoon: [
    { id: 'sn-glm-5-3', name: 'GLM-5-3' },
  ],
  minimax: [
    { id: 'MiniMax-M2', name: 'MiniMax M2' },
  ],
  minimaxintl: [
    { id: 'MiniMax-M2', name: 'MiniMax M2' },
  ],
  cline: [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  ],
  opencode: [],
  gemini: [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  ],
  officeace: [],
  accio: [
    { id: 'deepseek-v4-1-flash', name: 'DeepSeek V4.1 Flash' },
  ],
  qiniu: [],
})

/** 取某渠道的内置模型（没有则空数组） */
export function builtinModelsOf(channelId) {
  return BUILTIN_MODELS[channelId] ?? []
}

/** 该渠道是否有内置兜底 */
export function hasBuiltin(channelId) {
  return builtinModelsOf(channelId).length > 0
}
