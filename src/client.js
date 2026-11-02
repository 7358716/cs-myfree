/**
 * cs-myfree — 模型工作台 UI（浏览器半身，**必须单文件**）
 *
 * 设计依据：v3 §9。12 个功能区（主管要求的下限，不是上限）：
 *   W1 供给源总览   W2 模型目录      W3 降级链编辑器⭐  W4 手动钉选
 *   W5 源启停+额度  W6 保护策略      W7 预算与付费     W8 省 Token
 *   W9 可观测       W10 导入导出     W11 作用域        W12 诊断
 *
 * 约束：浏览器不支持相对路径 require ⇒ 全部逻辑内联在本文件。
 * 用自有 id `cs-myfree`（settings.section 已被 5 个内置页占用，
 * 复用会**替换别人的 cell**）。
 *
 * @module cs-myfree/client
 */

const NAME = 'cs-myfree'

export const name = `${NAME}-client`
export const version = '0.2.0'

/** 12 个功能区定义（顺序即导航顺序） */
export const ZONES = [
  { id: 'W1', key: 'sources', label: '供给源总览', desc: '有哪些源、各自状态' },
  { id: 'W2', key: 'catalog', label: '模型目录', desc: '可搜索全量模型与能力' },
  { id: 'W3', key: 'chain', label: '降级链编辑器', desc: '钉选 / 替换 / 增删 / 排序', star: true },
  { id: 'W4', key: 'pin', label: '手动钉选', desc: '选定并设为默认' },
  { id: 'W5', key: 'health', label: '源启停与额度', desc: '启停、余额、临期告警' },
  { id: 'W6', key: 'policy', label: '保护策略', desc: '并发 / 冷却 / 退避' },
  { id: 'W7', key: 'budget', label: '预算与付费', desc: '五道闸门' },
  { id: 'W8', key: 'saver', label: '省 Token', desc: '工具输出压缩' },
  { id: 'W9', key: 'observe', label: '可观测', desc: '实时日志与账本' },
  { id: 'W10', key: 'io', label: '导入导出', desc: '备份与还原' },
  { id: 'W11', key: 'scope', label: '作用域', desc: '会话 / 预设 / 全局' },
  { id: 'W12', key: 'diag', label: '诊断', desc: '一键体检' },
]

/** 客户端入口：注册设置分节 */
export function apply(ctx) {
  const slots = ctx?.slots
  if (!slots?.inject) return
  slots.inject('settings.section', () => ({
    id: `${NAME}-section`,
    name: `${NAME}-section`,
    label: '免费模型',
    order: 200,
    render: renderWorkbench,
  }))
}

/**
 * 渲染工作台（纯字符串拼装，不依赖任何 UI 库）。
 * 宿主若提供 h() 则用之；否则返回结构描述由宿主渲染。
 */
export function renderWorkbench(state = {}) {
  return {
    title: '免费模型工作台',
    version,
    zones: ZONES.map((z) => ({ ...z, body: zoneBody(z.key, state) })),
  }
}

function zoneBody(key, s) {
  switch (key) {
    case 'sources':
      return {
        rows: (s.sources ?? []).map((x) => ({ label: x.label, kind: x.kind, status: x.status ?? 'unknown' })),
        empty: '尚未探测到任何源',
      }
    case 'catalog':
      return { searchable: true, rows: (s.models ?? []).map((m) => ({ id: m.id, free: m.free, vision: m.supportsVision })) }
    case 'chain':
      return {
        editable: true,
        hint: '用 ↑↓ 调整顺序（不用拖拽：一处错字会让整条链不可解析）',
        tiers: s.chainTiers ?? [],
        overrides: s.chainOverrides ?? [],
      }
    case 'pin':
      return { current: s.currentModel ?? null, options: s.pinOptions ?? [] }
    case 'health':
      return { rows: (s.health ?? []).map((h) => ({ provider: h.provider, ready: h.ready, cooling: h.cooling, expired: h.expired, balance: h.balance })), expiring: s.expiring ?? [] }
    case 'policy':
      return { fields: [{ key: 'concurrency', label: '并发上限' }, { key: 'cooldownMs', label: '冷却时长' }, { key: 'maxRetries', label: '单源重试' }], values: s.policy ?? {} }
    case 'budget':
      return {
        gates: [
          { id: '①', label: '付费不得自动调用', value: s.paid?.allowAutoCall === true },
          { id: '②', label: '逐次人工确认', value: s.paid?.confirmEachTurn === true },
          { id: '③', label: '仅白名单预设可用', value: (s.paid?.presets ?? []).join(', ') || '未配置' },
          { id: '④', label: '单次限额', value: `¥${s.budget?.perCallCNY ?? 0}` },
          { id: '⑤', label: '月度限额', value: `¥${s.budget?.monthlyCNY ?? 0}` },
        ],
        spent: { today: s.spent?.today ?? 0, month: s.spent?.month ?? 0 },
      }
    case 'saver':
      return { enabled: s.saver?.enabled ?? true, stats: s.saver?.stats ?? { calls: 0, savedPercent: 0 } }
    case 'observe':
      return { logs: (s.logs ?? []).slice(-200), ledger: s.ledger ?? [] }
    case 'io':
      return { exports: ['配置（不含密钥）', '链覆盖层', '账本'], importsRequiresPreview: true }
    case 'scope':
      return { scopes: ['session', 'preset', 'global'], current: s.scope ?? 'session' }
    case 'diag':
      return { checks: s.diagnostics ?? [], runnable: true }
    default:
      return {}
  }
}

/** 供宿主/测试调用的自检：12 区是否齐全 */
export function selfCheck() {
  const ids = ZONES.map((z) => z.id)
  const expected = Array.from({ length: 12 }, (_, i) => `W${i + 1}`)
  return {
    ok: ids.length === 12 && expected.every((e) => ids.includes(e)),
    count: ids.length,
    missing: expected.filter((e) => !ids.includes(e)),
  }
}
