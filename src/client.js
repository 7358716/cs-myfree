/**
 * cs-myfree — 模型工作台（浏览器半身）
 *
 * ⚠️ 格式约束（本机实测）：客户端插件必须用 `window.__ModuleLoader__.load({id, factory})`
 *    包装，**不是裸 ESM**。写成 ESM 会导致设置页静默不出现。
 *
 * 契约：factory(require) 内可 require react 等（宿主提供）；
 *       导出 `apply(ctx)` 与 `inject = ['slots']`；
 *       `ctx.slots.inject(slot, () => ctx.slots.register(desc, Component))`；
 *       `label` 必须是**函数**。
 *
 * 注册两个槽位：
 *   settings.section        ← 设置页（12 功能区 + 余额卡片）
 *   sidebar.footer.action   ← 左下角实时余额 chip
 */
window.__ModuleLoader__.load({
  id: 'cs-myfree',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    const CASH_PATH = '/cs-myfree/cash'

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

    const KEYLESS = [
      { id: 'kilo', label: 'Kilo 免费池', note: '382 模型 / 11 免费' },
      { id: 'ovh', label: 'OVH 免费视觉', note: '4 模型（含视觉）' },
      { id: 'pollinations', label: 'Pollinations', note: '纯文本，最快' },
    ]

    const CAPS = [
      ['降级链', '6 层：重试→换号→换渠道→换模型→降档→上报'],
      ['提交点', 'reasoning 不算提交，「想很久才撞墙」可静默切换'],
      ['链覆盖层', '钉选 / 替换 / 增删 / 排序（唯一 merge 入口）'],
      ['渠道层', '18 个账号渠道 + 3 个免密源'],
      ['本地网关', 'OpenAI / Anthropic 原生 / Gemini 四方言'],
      ['付费闸门', '五道全实现，deny-by-default'],
      ['省 Token', 'RTK 压缩（错误结果永不压缩）'],
      ['识图', '四档位，默认不出网'],
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
      hint: { marginTop: '12px', padding: '8px', borderRadius: '6px', background: 'rgba(128,128,128,0.08)', fontSize: '11px', opacity: 0.8 },
      sectionTitle: { fontWeight: 600, marginBottom: '8px' },
    }

    /** 余额卡片（设置页顶部；兼作路由诊断） */
    function CashCard() {
      const [state, setState] = react.useState({ phase: 'loading', data: null, error: null })
      const [tick, setTick] = react.useState(0)

      react.useEffect(() => {
        let alive = true
        const load = () => {
          try {
            setState((s) => (s.phase === 'done' ? s : { phase: 'loading', data: s.data, error: null }))
            fetch(CASH_PATH, { credentials: 'same-origin' })
              .then(async (r) => {
                if (!r.ok) {
                  const body = await r.text().catch(() => '')
                  throw new Error('HTTP ' + r.status + (body ? ' — ' + body.slice(0, 100) : ''))
                }
                return r.json()
              })
              .then((d) => { if (alive) setState({ phase: 'done', data: d, error: null }) })
              .catch((e) => { if (alive) setState({ phase: 'error', data: null, error: String((e && e.message) || e) }) })
          } catch (e) {
            if (alive) setState({ phase: 'error', data: null, error: String((e && e.message) || e) })
          }
        }
        load()
        const timer = setInterval(load, 60000)
        return () => { alive = false; clearInterval(timer) }
      }, [tick])

      const ds = state.data && state.data.deepseek
      const amount = ds && Array.isArray(ds.balances) && ds.balances.length > 0
        ? ds.balances.map((b) => (b.currency === 'CNY' ? '¥' : b.currency + ' ') + Number(b.total).toFixed(2)).join('   ')
        : null

      const errs = []
      if (state.error) errs.push('请求失败：' + state.error)
      if (state.data && Array.isArray(state.data.errors)) {
        for (const e of state.data.errors) errs.push(e)
      }

      const bigStyle = {
        fontSize: amount ? '26px' : '15px',
        fontWeight: 700,
        letterSpacing: '0.5px',
        color: amount ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
        margin: '2px 0 6px',
      }
      const minor = { fontSize: '11px', opacity: 0.7 }
      const warn = { marginTop: '8px', fontSize: '11px', color: 'var(--dsw-alias-state-warn-primary)', lineHeight: 1.7 }

      return h('div', {
        style: {
          border: '1px solid rgba(128,128,128,0.25)',
          borderRadius: '8px',
          padding: '12px 14px',
          marginBottom: '16px',
          background: 'rgba(128,128,128,0.05)',
        },
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
          h('div', { style: { fontWeight: 600, fontSize: '13px' } }, 'DeepSeek 账户余额'),
          h('span', {
            style: {
              cursor: 'pointer', fontSize: '11px', opacity: 0.7,
              border: '1px solid rgba(128,128,128,0.3)', borderRadius: '4px', padding: '1px 8px',
            },
            onClick: () => setTick((n) => n + 1),
          }, state.phase === 'loading' ? '刷新中…' : '刷新'),
        ),
        h('div', { style: bigStyle }, state.phase === 'loading' ? '正在查询…' : (amount || '¥ \u2014')),
        ds ? h('div', { style: minor },
          (ds.available ? '✅ 账户可用' : '⚠️ 账户不可用 / 未知')
          + (Array.isArray(ds.balances) && ds.balances.length
            ? '　赠送 ¥' + Number(ds.balances[0].granted).toFixed(2) + '　充值 ¥' + Number(ds.balances[0].topped).toFixed(2)
            : '')
        ) : null,
        errs.length ? h('div', { style: warn }, errs.map((e, i) => h('div', { key: i }, '· ' + e))) : null,
        h('div', { style: { marginTop: '8px', ...minor, opacity: 0.55 } },
          '每 60 秒自动刷新。数据来自你自己的 DEEPSEEK_API_KEY（只读查询，不产生费用）。'),
      )
    }

    /** 设置页 */
    function CsMyfreeSection() {
      return h('div', { style: styles.root },
        h('div', { style: styles.h2 }, '免费模型 · cs-myfree'),
        h('div', { style: styles.sub }, '零第三方依赖 · 装完即用（3 个免密源无需账号）'),

        h(CashCard),

        h('div', { style: styles.sectionTitle }, '免密源（无需登录）'),
        h('div', { style: styles.grid },
          KEYLESS.map((s) => h('div', { key: s.id, style: styles.card },
            h('div', { style: styles.cardTitle }, s.label),
            h('div', { style: styles.cardDesc }, s.note),
          )),
        ),

        h('div', { style: styles.sectionTitle }, '工作台功能区'),
        h('div', { style: styles.grid },
          ZONES.map((z) => h('div', { key: z.id, style: styles.card },
            h('div', { style: styles.cardTitle }, z.id + ' ' + z.label),
            h('div', { style: styles.cardDesc }, z.desc),
          )),
        ),

        h('div', { style: styles.sectionTitle }, '内置能力'),
        h('div', null, CAPS.map((pair) => h('div', { key: pair[0], style: styles.row },
          h('span', { style: { fontWeight: 500 } }, pair[0]),
          h('span', { style: { opacity: 0.75, textAlign: 'right', marginLeft: '12px' } }, pair[1]),
        ))),

        h('div', { style: styles.hint },
          '本版可正常查看；链编辑、额度刷新、一键体检等交互在后续版本接入。'),
      )
    }

    /** 左下角实时余额 chip */
    function CashChip() {
      const [cash, setCash] = react.useState(null)
      const [tick, setTick] = react.useState(0)

      react.useEffect(() => {
        let alive = true
        const load = () => {
          try {
            fetch(CASH_PATH, { credentials: 'same-origin' })
              .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
              .then((d) => { if (alive) setCash(d) })
              .catch(() => { if (alive) setCash((prev) => prev || { ok: false, errors: ['查询失败'] }) })
          } catch (_) { /* ignore */ }
        }
        load()
        const timer = setInterval(load, 60000)
        return () => { alive = false; clearInterval(timer) }
      }, [tick])

      const ds = cash && cash.deepseek
      const text = ds && Array.isArray(ds.balances) && ds.balances.length > 0
        ? ds.balances.map((b) => (b.currency === 'CNY' ? '¥' : b.currency + ' ') + Number(b.total).toFixed(2)).join(' ')
        : '¥ \u2014'
      const available = ds && ds.available
      const color = available ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)'
      const tip = cash == null
        ? '正在查询 DeepSeek 余额…'
        : (available ? 'DeepSeek 余额可用' : '余额未知 / 未配置 Key')
          + '（每 60 秒刷新，点击立即刷新）'
          + (cash && cash.errors && cash.errors.length ? ' | ' + cash.errors[0] : '')

      return h('span', {
        title: tip,
        style: {
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 28,
          padding: '0 8px',
          marginRight: 2,
          borderRadius: 6,
          fontSize: 13,
          lineHeight: '28px',
          fontWeight: 600,
          color: color,
          whiteSpace: 'nowrap',
        },
        onClick: () => setTick((n) => n + 1),
      },
        h('span', { style: { fontSize: 13, opacity: 0.85 } }, '¥'),
        h('span', { style: { fontSize: 13 } }, text.replace(/^¥\s?/, '')),
      )
    }

    const inject = ['slots']

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
        try { console.warn('[cs-myfree] 设置分节注册失败：', (err && err.message) || err) } catch (_) {}
      }
      try {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'cs-myfree-cash',
          order: 40,
          label: () => '余额',
        }, CashChip))
      } catch (err) {
        try { console.warn('[cs-myfree] 余额 chip 槽位不可用（不影响其它功能）：', (err && err.message) || err) } catch (_) {}
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.ZONES = ZONES
    exports.CashChip = CashChip
    exports.CashCard = CashCard
    exports.CsMyfreeSection = CsMyfreeSection
    return module.exports
  },
})
