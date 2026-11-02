/**
 * cs-myfree — 识图桥（纯逻辑部分）
 *
 * 设计依据：v3 §7。**识图是集成功能，不是独立插件**（主管明确更正）。
 *
 * 两类问题：
 *   A「让模型自己看图」 → provider 声明 inputModalities 含 image
 *   B「让看不了图的模型拿到图片信息」 → 需桥接（我们的默认模型属 B）
 *
 * 关键事实（已核实的宿主行为）：
 *  · 投影点 `dsh-llm/lib/index.js:2337`，纯文本模型收图会被替换成占位符
 *  · 拦截点是 **`agent/pre-step`**，不是 `llm/stream`
 *    （`llm/stream` 的 `next()` 不接受参数，无法改请求体）
 *  · pre-step 的改写**会落库** ⇒ 同一张图只出网一次
 *
 * 本模块只做「该不该出网 / 该用哪个后端 / 结果怎么回填」的纯逻辑。
 *
 * @module cs-myfree/vision/bridge
 */

/** 隐私档位（默认 off —— 比参考实现更保守） */
export const MODE = Object.freeze({
  OFF: 'off',                 // 完全不出网，保留占位符
  LOCAL: 'local',             // 仅 loopback（Ollama/LM Studio）
  FREE_CLOUD: 'free-cloud',   // OVH 匿名 + Kilo 免费视觉
  PAID_CLOUD: 'paid-cloud',   // 自建付费视觉 API
})

/** 各档位的出网行为 */
export const MODE_POLICY = Object.freeze({
  [MODE.OFF]: { egress: false, needConsent: false, label: '不出网（默认）' },
  [MODE.LOCAL]: { egress: true, loopbackOnly: true, needConsent: false, label: '仅本机' },
  [MODE.FREE_CLOUD]: { egress: true, loopbackOnly: false, needConsent: true, label: '免费云链（需同意）' },
  [MODE.PAID_CLOUD]: { egress: true, loopbackOnly: false, needConsent: true, paid: true, label: '付费云链（需同意+计费）' },
})

/** OVH 免费视觉链（本机实测可用：8×8 红图 → "Red"） */
export const OVH_CHAIN = Object.freeze([
  { model: 'Qwen3.5-397B-A17B', note: '质量最高' },
  { model: 'Qwen2.5-VL-72B-Instruct', note: '实测答对' },
  { model: 'Qwen3.6-27B', note: '中等' },
  { model: 'Qwen3.5-9B', note: '最快' },
])

/**
 * 🔴 免密端点的铁律（本机实测，OVH 与 Kilo 同一行为）：
 *    不发 Authorization → 200；带任何 key（含假的）→ 403
 * ⇒ 必须「不设置该头」，不是「传占位值」。
 */
export const KEYLESS_HEADER_RULE = 'keyless-endpoints-must-omit-authorization-entirely'

/** 判断某次图片处理是否允许出网 */
export function shouldEgress(mode = MODE.OFF, { consented = false } = {}) {
  const p = MODE_POLICY[mode]
  if (!p) return { allowed: false, reason: `未知档位 ${mode}` }
  if (!p.egress) return { allowed: false, reason: '当前档位不出网（默认）' }
  if (p.needConsent && !consented) return { allowed: false, reason: `${p.label} 需要显式同意` }
  return { allowed: true, reason: p.label, paid: p.paid === true }
}

/** 构造 OVH 请求头 —— 关键：绝不带 Authorization */
export function buildOvhHeaders() {
  return { 'content-type': 'application/json' }
}

/**
 * 把视觉模型的文字描述回填到消息里（替换占位符）。
 * @param {Array} messages 原始消息（含 type:'image' 块）
 * @param {(ref:any)=>Promise<string>} describe 对每个图片引用取描述
 */
export async function bridgeMessages(messages = [], describe) {
  const out = []
  for (const msg of messages) {
    if (!Array.isArray(msg?.content)) { out.push(msg); continue }
    const content = []
    for (const block of msg.content) {
      if (block?.type === 'image') {
        let text
        try { text = await describe(block) } catch (err) { text = null }
        content.push({
          type: 'text',
          text: text
            ? `[图片内容（由视觉模型转述）] ${text}`
            : '[图片未能解析（识图未开启或失败）]',
        })
      } else {
        content.push(block)
      }
    }
    out.push({ ...msg, content })
  }
  return out
}

/** 审计字段（明令不记字节/base64/密钥/prompt 原文） */
export function buildAuditRecord({ mode, backend, model, bytes, ok, ms, err }) {
  return {
    at: Date.now(),
    mode,
    backend: backend ?? null,
    model: model ?? null,
    bytes: Number.isFinite(bytes) ? bytes : null,
    ok: ok === true,
    ms: Number.isFinite(ms) ? ms : null,
    err: err ? String(err).slice(0, 200) : null,
  }
}
