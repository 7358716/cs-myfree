/**
 * cs-myfree — 模型工作台（浏览器半身）
 *
 * ⚠️ 关键格式约束（本机实测，与官方插件对齐）：
 *    客户端插件必须用 `window.__ModuleLoader__.load({ id, factory })` 包装，
 *    **不是普通 ESM**。写成 ESM 会导致设置页根本不出现（静默失效）。
 *
 * 契约：
 *   · factory(require) 里可 require: react / react/jsx-runtime /
 *     @deepseek-ai/dsh-client-ui-primitives 等（由宿主提供，不需要我们打包）
 *   · 导出 `apply(ctx)` 与 `inject = ['slots']`
 *   · 注册：ctx.slots.inject('settings.section', () => ctx.slots.register(desc, Component))
 *   · `label` 必须是**函数**，不是字符串
 *
 * 12 个功能区（主管要求的下限，不是上限）。
 * 本版为**只读展示版**：不依赖宿主 API 调用，确保一定能渲染出来。
 */
window.__ModuleLoader__.load({
  id: 'cs-myfree',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    /** 12 个功能区定义 */
    const ZONES = [
      { id: 'W1', key: 'sources', label: '供给源总览', desc: '有哪些源、各自状态' },
      { id: 'W2', key: 'catalog', label: '模型目录', desc: '可搜索全量模型与能力' },
      { id: 'W3', key: 'chain', label: '降级链编辑器 ★', desc: '钉选 / 替换 / 增删 / 排序' },
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

    /** 免密源（内置常量，无需联网即可展示） */
    const KEYLESS = [
      { id: 'kilo', label: 'Kilo 免费池', note: '382 模型 / 11 免费' },
      { id: 'ovh', label: 'OVH 免费视觉', note: '4 模型（含视觉）' },
      { id: 'pollinations', label: 'Pollinations', note: '纯文本，最快' },
    ]

    const styles = {
      root: { padding: '16px', fontFamily: 'inherit', fontSize: '13px', lineHeight: '1.6' },
      h2: { fontSize: '15px', fontWeight: 600, margin: '0 0 4px' },
      sub: { opacity: 0.65, margin: '0 0 16px', fontSize: '12px' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '8px', marginBottom: '20px' },
      card: { border: '1px solid rgba(128,128,128,0.25)', borderRadius: '6px', padding: '10px' },
      cardTitle: { fontWeight: 600, marginBottom: '2px' },
      cardDesc: { opacity: 0.65, fontSize: '11px' },
      row: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid rgba(128,128,128,0.12)' },
      tag: { display: 'inline-block', padding: '0 6px', borderRadius: '4px', background: 'rgba(64,160,96,0.15)', color: '#2e8b57', fontSize: '11px' },
      hint: { marginTop: '12px', padding: '8px', borderRadius: '6px', background: 'rgba(128,128,128,0.08)', fontSize: '11px', opacity: 0.8 },
    }

    /** 设置页组件 */
    function CsMyfreeSection() {
      return h('div', { style: styles.root },
        h('div', { style: styles.h2 }, '免费模型 · cs-myfree'),
        h('div', { style: styles.sub }, 'v1.0.2 · 零第三方依赖 · 装完即用（3 个免密源无需账号）'),

        h('div', { style: { ...styles.cardTitle, marginBottom: '8px' } }, '免密源（无需登录）'),
        h('div', { style: styles.grid },
          KEYLESS.map((s) => h('div', { key: s.id, style: styles.card },
            h('div', { style: styles.cardTitle }, s.label),
            h('div', { style: styles.cardDesc }, s.note),
          )),
        ),

        h('div', { style: { ...styles.cardTitle, marginBottom: '8px' } }, '工作台功能区'),
        h('div', { style: styles.grid },
          ZONES.map((z) => h('div', { key: z.id, style: styles.card },
            h('div', { style: styles.cardTitle }, `${z.id} ${z.label}`),
            h('div', { style: styles.cardDesc }, z.desc),
          )),
        ),

        h('div', { style: { ...styles.cardTitle, marginBottom: '6px' } }, '内置能力'),
        h('div', null,
          [
            ['降级链', '6 层：重试→换号→换渠道→换模型→降档→上报'],
            ['提交点', 'reasoning 不算提交，「想很久才撞墙」可静默切换'],
            ['链覆盖层', '钉选 / 替换 / 增删 / 排序（唯一 merge 入口）'],
            ['渠道层', '18 个账号渠道 + 3 个免密源'],
            ['本地网关', 'OpenAI / Anthropic 原生 / Gemini 四方言'],
            ['付费闸门', '五道全实现，deny-by-default'],
            ['省 Token', 'RTK 压缩（错误结果永不压缩）'],
            ['识别', '识图四档位，默认不出网'],
          ].map(([k, v]) => h('div', { key: k, style: styles.row },
            h('span', { style: { fontWeight: 500 } }, k),
            h('span', { style: { opacity: 0.75, textAlign: 'right', marginLeft: '12px' } }, v),
          )),
        ),

        h('div', { style: styles.hint },
          '提示：本版为只读展示。完整交互（链编辑、额度刷新、诊断）在后续版本接入宿主 API 后开放。',
        ),
      )
    }

    /** 必需服务：slot 注册表 */
    const inject = ['slots']

    /**
     * 客户端入口。
     * ⚠️ 绝不让异常外泄 —— 客户端抛错会导致整个设置页白屏。
     */
    function apply(ctx) {
      try {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'cs-myfree',
          order: 200,
          label: () => '免费模型',
        }, CsMyfreeSection))
      } catch (err) {
        // 静默降级：不渲染也不影响其它设置页
        try { console.warn('[cs-myfree] 设置分节注册失败：', err && err.message) } catch {}
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.ZONES = ZONES
    return module.exports
  },
})
