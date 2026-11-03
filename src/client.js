/**
 * cs-myfree — Myfree 工作台（浏览器半身，完整交互版）
 *
 * ⚠️ 必须用 `window.__ModuleLoader__.load({id, factory})` 包装（不是裸 ESM）。
 *
 * 12 个功能区全部接通宿主 API（前缀 /cs-myfree）。
 * 所有网络失败都在界面上**显示原因**，不静默。
 */
window.__ModuleLoader__.load({
  id: 'cs-myfree',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    const API = '/cs-myfree'
    const CASH_PATH = '/cs-myfree/cash'

    const ZONES = [
      { id: 'W1', key: 'sources', label: '供给源' },
      { id: 'W2', key: 'catalog', label: '模型目录' },
      { id: 'W3', key: 'chain', label: '降级链 ★' },
      { id: 'W4', key: 'pin', label: '钉选' },
      { id: 'W5', key: 'health', label: '额度健康' },
      { id: 'W6', key: 'policy', label: '保护策略' },
      { id: 'W7', key: 'budget', label: '预算付费' },
      { id: 'W8', key: 'saver', label: '省 Token' },
      { id: 'W9', key: 'observe', label: '可观测' },
      { id: 'W10', key: 'io', label: '导入导出' },
      { id: 'W11', key: 'scope', label: '作用域' },
      { id: 'W12', key: 'diag', label: '诊断' },
    ]

    // ── 通用样式 ──
    const S = {
      root: { padding: '16px', fontFamily: 'inherit', fontSize: '13px', lineHeight: '1.6' },
      h2: { fontSize: '15px', fontWeight: 600, margin: '0 0 4px' },
      sub: { opacity: 0.65, margin: '0 0 14px', fontSize: '12px' },
      card: { border: '1px solid rgba(128,128,128,0.25)', borderRadius: '8px', padding: '12px 14px', marginBottom: '12px', background: 'rgba(128,128,128,0.04)' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: '8px' },
      tile: { border: '1px solid rgba(128,128,128,0.25)', borderRadius: '6px', padding: '9px' },
      row: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid rgba(128,128,128,0.12)' },
      tabs: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '14px', borderBottom: '1px solid rgba(128,128,128,0.2)', paddingBottom: '8px' },
      tab: (on) => ({ cursor: 'pointer', padding: '3px 10px', borderRadius: '5px', fontSize: '12px', fontWeight: on ? 600 : 400, background: on ? 'rgba(128,128,128,0.18)' : 'transparent', border: '1px solid ' + (on ? 'rgba(128,128,128,0.4)' : 'transparent') }),
      btn: (primary) => ({ cursor: 'pointer', fontSize: '12px', padding: '3px 12px', borderRadius: '5px', border: '1px solid rgba(128,128,128,0.4)', background: primary ? 'rgba(64,160,96,0.18)' : 'transparent', color: 'inherit', fontWeight: primary ? 600 : 400 }),
      mono: { fontFamily: 'ui-monospace, monospace', fontSize: '11px' },
      dim: { opacity: 0.65, fontSize: '11px' },
      good: { color: 'var(--dsw-alias-state-success-primary)' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)' },
      bad: { color: 'var(--dsw-alias-state-error-primary)' },
      input: { width: '100%', boxSizing: 'border-box', padding: '4px 8px', fontSize: '12px', borderRadius: '5px', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit' },
      pre: { margin: 0, padding: '8px', borderRadius: '6px', background: 'rgba(128,128,128,0.1)', fontSize: '11px', overflow: 'auto', maxHeight: '260px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
    }

    // ── 通用请求 ──
    function api(path, opts) {
      return fetch(API + path, Object.assign({ credentials: 'same-origin', headers: { 'content-type': 'application/json' } }, opts || {}))
        .then(async (r) => {
          const text = await r.text().catch(() => '')
          if (!r.ok) throw new Error('HTTP ' + r.status + (text ? ' — ' + text.slice(0, 160) : ''))
          try { return JSON.parse(text) } catch { throw new Error('响应不是 JSON：' + text.slice(0, 120)) }
        })
    }

    /** 数据加载 hook */
    function useApi(path, deps) {
      const [s, setS] = react.useState({ loading: true, data: null, error: null })
      const [tick, setTick] = react.useState(0)
      react.useEffect(() => {
        let alive = true
        setS((p) => ({ loading: true, data: p.data, error: null }))
        api(path)
          .then((d) => { if (alive) setS({ loading: false, data: d, error: null }) })
          .catch((e) => { if (alive) setS({ loading: false, data: null, error: String((e && e.message) || e) }) })
        return () => { alive = false }
      }, (deps || []).concat([tick]))
      return [s, () => setTick((n) => n + 1)]
    }

    function Err(props) {
      if (!props.error) return null
      return h('div', { style: Object.assign({}, S.card, { borderColor: 'rgba(200,80,80,0.5)' }) },
        h('div', { style: Object.assign({ fontWeight: 600 }, S.bad) }, '出错了'),
        h('div', { style: Object.assign({ marginTop: '4px' }, S.mono) }, props.error))
    }
    function Loading(props) {
      if (!props.on) return null
      return h('div', { style: S.dim }, '加载中…')
    }
    function KV(props) {
      return h('div', { style: S.row },
        h('span', { style: { fontWeight: 500 } }, props.k),
        h('span', { style: Object.assign({ textAlign: 'right', marginLeft: '12px' }, props.dim ? S.dim : null) }, props.v))
    }

    // ── 余额卡片 ──
    function CashCard() {
      const [s, setS] = react.useState({ phase: 'loading', data: null, error: null })
      const [tick, setTick] = react.useState(0)
      react.useEffect(() => {
        let alive = true
        setS((p) => ({ phase: 'loading', data: p.data, error: null }))
        fetch(CASH_PATH, { credentials: 'same-origin' })
          .then(async (r) => {
            const t = await r.text().catch(() => '')
            if (!r.ok) throw new Error('HTTP ' + r.status + (t ? ' — ' + t.slice(0, 100) : ''))
            try { return JSON.parse(t) } catch { throw new Error('响应非 JSON') }
          })
          .then((d) => { if (alive) setS({ phase: 'done', data: d, error: null }) })
          .catch((e) => { if (alive) setS({ phase: 'error', data: null, error: String((e && e.message) || e) }) })
        return () => { alive = false }
      }, [tick])

      const ds = s.data && s.data.deepseek
      const amount = ds && Array.isArray(ds.balances) && ds.balances.length
        ? ds.balances.map((b) => (b.currency === 'CNY' ? '¥' : b.currency + ' ') + Number(b.total).toFixed(2)).join('   ')
        : null
      const errs = []
      if (s.error) errs.push('请求失败：' + s.error)
      if (s.data && Array.isArray(s.data.errors)) for (const e of s.data.errors) errs.push(e)

      return h('div', { style: S.card },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
          h('div', { style: { fontWeight: 600 } }, 'DeepSeek 账户余额'),
          h('span', { style: S.btn(false), onClick: () => setTick((n) => n + 1) }, s.phase === 'loading' ? '刷新中…' : '刷新')),
        h('div', { style: { fontSize: amount ? '26px' : '15px', fontWeight: 700, letterSpacing: '0.5px', margin: '2px 0 6px', color: amount ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)' } },
          s.phase === 'loading' ? '正在查询…' : (amount || '¥ \u2014')),
        ds ? h('div', { style: S.dim },
          (ds.available ? '✅ 账户可用' : '⚠️ 账户不可用 / 未知')
          + (Array.isArray(ds.balances) && ds.balances.length
            ? '　赠送 ¥' + Number(ds.balances[0].granted).toFixed(2) + '　充值 ¥' + Number(ds.balances[0].topped).toFixed(2) : '')) : null,
        errs.length ? h('div', { style: Object.assign({ marginTop: '8px' }, S.dim, S.warn) }, errs.map((e, i) => h('div', { key: i }, '· ' + e))) : null,
        h('div', { style: Object.assign({ marginTop: '8px' }, S.dim) }, '每 60 秒自动刷新 · 只读查询，不产生费用'),
      )
    }

    // ── W1 供给源 ──
    function SourcesZone() {
      const [s, reload] = useApi('/state')
      const [probing, setProbing] = react.useState(false)
      const [probe, setProbe] = react.useState(null)
      const d = s.data

      const runProbe = () => {
        setProbing(true)
        api('/probe', { method: 'POST', body: JSON.stringify({}) })
          .then((r) => setProbe(r))
          .catch((e) => setProbe({ ok: false, error: String((e && e.message) || e) }))
          .then(() => { setProbing(false); reload() })
      }

      if (s.error) return h(Err, { error: s.error })
      if (!d) return h(Loading, { on: s.loading })

      return h('div', null,
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' } },
          h('button', { style: S.btn(true), onClick: runProbe, disabled: probing }, probing ? '探测中…（真实请求）' : '探测免密源'),
          h('span', { style: S.dim }, '会发起真实推理请求，约 2–20 秒')),
        probe ? h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } },
            probe.ok ? (probe.anyOk ? '✅ 探测完成' : '❌ 全部不可用') : '❌ 探测失败'),
          (probe.results || []).map((r) => h('div', { key: r.id, style: S.row },
            h('span', null, (r.ok ? '✅ ' : '❌ ') + r.id),
            h('span', { style: Object.assign({ textAlign: 'right' }, S.dim) }, r.ok ? (r.ms + 'ms  "' + String(r.sample || '').slice(0, 30) + '"') : (r.error || '失败')))),
          probe.error ? h('div', { style: Object.assign({ marginTop: '6px' }, S.mono, S.bad) }, probe.error) : null) : null,

        h('div', { style: { fontWeight: 600, margin: '4px 0 8px' } }, '免密源（无需登录）'),
        h('div', { style: S.grid }, (d.sources.keyless || []).map((k) => h('div', { key: k.id, style: S.tile },
          h('div', { style: { fontWeight: 600 } }, k.label),
          h('div', { style: S.dim }, k.note || '')))),

        h('div', { style: { fontWeight: 600, margin: '16px 0 8px' } },
          '账号渠道（' + d.sources.counts.channels + ' 家，' +
          d.sources.counts.checkin + ' 家可签到，' + d.sources.counts.manualRefresh + ' 家需人工重登）'),
        h('div', null, (d.sources.channels || []).map((c) => h('div', { key: c.id, style: S.row },
          h('span', null, c.label + (c.note ? h('span', { style: Object.assign({ marginLeft: '6px' }, S.dim) }, '（' + c.note + '）') : '')),
          h('span', { style: S.dim }, (c.checkin ? '签到 ' : '') + c.refresh)))),
      )
    }

    // ── W2 模型目录 ──
    function CatalogZone() {
      const [s, reload] = useApi('/models')
      if (s.error) return h(Err, { error: s.error })
      if (!s.data) return h(Loading, { on: s.loading })
      const d = s.data
      return h('div', null,
        h('div', { style: S.dim + '' }, d.note || ''),
        h('button', { style: S.btn(false), marginTop: 8, onClick: reload }, '刷新'),
        h('div', { style: { marginTop: '12px' } }, (d.sources || []).map((x) => h('div', { key: x.id, style: S.card },
          h('div', { style: { fontWeight: 600 } }, x.label),
          h(KV, { k: '默认模型', v: (d.defaultModels || {})[x.id] || '—', dim: true }),
          h(KV, { k: '最近探测', v: x.probed ? (x.probed.ok ? '✅ ' + x.probed.ms + 'ms' : '❌ ' + (x.probed.error || '')) : '未探测', dim: true })))),
      )
    }

    // ── W3 降级链编辑器（核心）──
    function ChainZone() {
      const [s, reload] = useApi('/chain')
      const [draft, setDraft] = react.useState([])
      const [msg, setMsg] = react.useState(null)
      const [busy, setBusy] = react.useState(false)

      react.useEffect(() => { if (s.data) setDraft((s.data.overrides || []).slice()) }, [s.data])

      if (s.error) return h(Err, { error: s.error })
      if (!s.data) return h(Loading, { on: s.loading })
      const d = s.data

      const set = (i, k, v) => setDraft((arr) => arr.map((e, j) => (j === i ? Object.assign({}, e, { [k]: v }) : e)))
      const del = (i) => setDraft((arr) => arr.filter((_, j) => j !== i))
      const add = () => setDraft((arr) => arr.concat([{ provider: '', model: '', tier: 1 }]))
      const move = (i, dir) => setDraft((arr) => {
        const j = i + dir
        if (j < 0 || j >= arr.length) return arr
        const c = arr.slice(); const t = c[i]; c[i] = c[j]; c[j] = t; return c
      })
      const save = () => {
        setBusy(true); setMsg(null)
        api('/chain', { method: 'POST', body: JSON.stringify({ chain: draft.filter((e) => e.provider && e.model) }) })
          .then((r) => { setMsg(r); reload() })
          .catch((e) => setMsg({ ok: false, errors: [String((e && e.message) || e)] }))
          .then(() => setBusy(false))
      }

      return h('div', null,
        h('div', { style: S.card },
          h(KV, { k: '内置链', v: d.builtin.length + ' 条' }),
          h(KV, { k: '覆盖层', v: (d.overrides || []).length + ' 条' }),
          h(KV, { k: '生效链', v: (d.effective || []).length + ' 条' }),
          (d.tiers || []).length ? h('div', { style: Object.assign({ marginTop: '8px' }, S.dim) },
            d.tiers.map((t) => 'T' + t.tier + ':' + t.count).join('  ')) : null),

        h('div', { style: { fontWeight: 600, margin: '14px 0 8px' } }, '覆盖层（钉选 / 替换 / 增删 / 排序）'),
        h('div', { style: S.dim }, '同 provider+model ⇒ 替换内置条目的 tier；新的 ⇒ 追加到该层末尾。留空的条目保存时会被忽略。'),

        draft.length === 0 ? h('div', { style: Object.assign({ margin: '10px 0' }, S.dim) }, '（空 —— 当前完全使用内置链）') : null,
        draft.map((e, i) => h('div', { key: i, style: Object.assign({}, S.tile, { marginBottom: '6px', display: 'flex', gap: '6px', alignItems: 'center' }) },
          h('span', { style: Object.assign({}, S.mono, S.dim) }, '#' + (i + 1)),
          h('input', { style: S.input, placeholder: 'provider（如 kilo-free）', value: e.provider, onChange: (ev) => set(i, 'provider', ev.target.value) }),
          h('input', { style: S.input, placeholder: 'model（如 kilo-auto/free）', value: e.model, onChange: (ev) => set(i, 'model', ev.target.value) }),
          h('input', { style: Object.assign({}, S.input, { width: '56px' }), type: 'number', min: 1, max: 5, value: e.tier, onChange: (ev) => set(i, 'tier', Number(ev.target.value) || 1) }),
          h('span', { style: S.btn(false), onClick: () => move(i, -1), title: '上移' }, '↑'),
          h('span', { style: S.btn(false), onClick: () => move(i, 1), title: '下移' }, '↓'),
          h('span', { style: S.btn(false), onClick: () => del(i), title: '删除' }, '✕'))),

        h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
          h('button', { style: S.btn(false), onClick: add }, '+ 加一条'),
          h('button', { style: S.btn(true), onClick: save, disabled: busy }, busy ? '保存中…' : '保存覆盖层'),
          h('button', { style: S.btn(false), onClick: () => { setDraft([]); setMsg(null) } }, '清空草稿')),

        msg ? h('div', { style: Object.assign({ marginTop: '10px' }, S.card,
          { borderColor: msg.ok ? 'rgba(64,160,96,0.5)' : 'rgba(200,80,80,0.5)' }) },
          h('div', { style: { fontWeight: 600 } }, msg.ok ? '✅ 已保存' : '❌ 保存失败'),
          (msg.errors || []).map((x, i) => h('div', { key: i, style: Object.assign({}, S.dim, S.warn) }, '· ' + x))) : null,
      )
    }

    // ── W4 钉选 ──
    function PinZone() {
      const [s] = useApi('/chain')
      if (s.error) return h(Err, { error: s.error })
      if (!s.data) return h(Loading, { on: s.loading })
      const eff = s.data.effective || []
      return h('div', null,
        h('div', { style: S.dim }, '生效链里 tier 最小的就是当前首选。要改首选 ⇒ 去「降级链」把某条的 tier 改成 1。'),
        h('div', { style: { marginTop: '10px' } }, eff.length === 0
          ? h('div', { style: S.dim }, '（生效链为空）')
          : eff.map((e, i) => h('div', { key: i, style: S.row },
            h('span', null, (i === 0 ? '★ ' : '') + e.provider + ' / ' + e.model),
            h('span', { style: S.dim }, 'T' + e.tier)))),
      )
    }

    // ── W5 额度健康 ──
    function HealthZone() {
      const [s, reload] = useApi('/state')
      if (s.error) return h(Err, { error: s.error })
      if (!s.data) return h(Loading, { on: s.loading })
      const d = s.data
      return h('div', null,
        h(CashCard),
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '免密源状态'),
          d.probe ? h('div', null,
            h(KV, { k: '最近探测', v: new Date(d.probe.at).toLocaleString() }),
            h(KV, { k: '可用', v: d.probe.okCount + '/' + d.sources.counts.keyless + (d.probe.anyOk ? ' ✅' : ' ❌') }))
            : h('div', { style: S.dim }, '尚未探测 ⇒ 去「供给源」点探测')),
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '签到与续期'),
          h('div', { style: Object.assign({}, S.dim, { marginBottom: '6px' }) }, d.checkin.note),
          h(KV, { k: '可签到渠道', v: d.checkin.supported.join(', ') || '无' }),
          h(KV, { k: '需人工重登', v: d.sources.counts.manualRefresh + ' 家（见供给源）', dim: true }),
          h(KV, { k: '需代理', v: d.sources.counts.proxyRequired + ' 家', dim: true })),
        h('button', { style: S.btn(false), onClick: reload }, '刷新'),
      )
    }

    // ── W6 保护策略 ──
    function PolicyZone() {
      const [s] = useApi('/config')
      if (s.error) return h(Err, { error: s.error })
      if (!s.data) return h(Loading, { on: s.loading })
      const c = s.data.config
      return h('div', null, h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '当前策略'),
        h(KV, { k: '识图档位', v: c.vision && c.vision.mode }),
        h(KV, { k: '搜索源', v: (c.search && c.search.sources || []).join(', ') }),
        h(KV, { k: '搜索预算', v: (c.search && c.search.budgetMs) + ' ms' }),
        h('div', { style: Object.assign({ marginTop: '10px' }, S.dim) },
          '编辑保护策略（并发/冷却/退避）需对应后端实现，当前版本先只读展示。')))
    }

    // ── W7 预算付费 ──
    function BudgetZone() {
      const [s] = useApi('/config')
      if (s.error) return h(Err, { error: s.error })
      if (!s.data) return h(Loading, { on: s.loading })
      const c = s.data.config
      const b = c.budget || {}
      return h('div', null, h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '五道闸门'),
        h(KV, { k: '① 付费不得自动调用', v: c.paid && c.paid.allowAutoCall ? '未开启（会阻断）' : '已开启' }),
        h(KV, { k: '② 逐次人工确认', v: c.paid && c.paid.confirmEachTurn ? '开启' : '关闭' }),
        h(KV, { k: '③ 仅白名单预设', v: (c.paid && c.paid.presets || []).join(', ') || '未配置（=禁止付费）' }),
        h(KV, { k: '④ 单次限额', v: '¥' + (b.perCallCNY ?? 0) }),
        h(KV, { k: '⑤ 月度限额', v: '¥' + (b.monthlyCNY ?? 0) + '（日 ¥' + (b.dailyCNY ?? 0) + '）' }),
        h('div', { style: Object.assign({ marginTop: '10px' }, S.dim) },
          '原则：deny-by-default，价格未知即拒。所有限额为 0 时等同于**禁止付费**。')))
    }

    // ── W8 省 Token ──
    function SaverZone() {
      return h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, 'RTK 工具输出压缩'),
        h(KV, { k: '状态', v: '已内置（自动生效）' }),
        h(KV, { k: '压缩对象', v: '仅工具输出（git diff/status/log、grep、find、构建日志）' }),
        h(KV, { k: '错误结果', v: '永不压缩（藏起来模型会重试同一调用）' }),
        h(KV, { k: '替换规则', v: '必须非空且严格更小，否则原样返回' }),
        h('div', { style: Object.assign({ marginTop: '8px' }, S.dim) }, '节省统计在「可观测」里看。'))
    }

    // ── W9 可观测 ──
    function ObserveZone() {
      const [s, reload] = useApi('/ledger')
      return h('div', null,
        h(Err, { error: s.error }),
        s.data ? h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '用量账本'),
          h(KV, { k: '记录数', v: (s.data.records || []).length }),
          h(KV, { k: '今日花费', v: '¥' + Number(s.data.todayCNY || 0).toFixed(4) }),
          h(KV, { k: '本月花费', v: '¥' + Number(s.data.monthCNY || 0).toFixed(4) }),
          h(KV, { k: '失明率（UNKNOWN 占比）', v: (s.data.blindRate ?? 0) + '% （目标 <5%）' }),
          h('div', { style: Object.assign({ marginTop: '10px' }, S.dim) }, '账本由宿主消费侧写入；本页展示聚合视图。'))
          : h(Loading, { on: s.loading }),
        h('button', { style: S.btn(false), onClick: reload }, '刷新'))
    }

    // ── W10 导入导出 ──
    function IoZone() {
      const [s] = useApi('/chain')
      const [copied, setCopied] = react.useState(false)
      const json = s.data ? JSON.stringify({ chain: s.data.overrides || [] }, null, 2) : ''
      const copy = () => {
        try { navigator.clipboard.writeText(json); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch (_) {}
      }
      return h('div', null, h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '导出链覆盖层'),
        h('div', { style: S.dim }, '只导出覆盖层（不含任何凭据/密钥）。'),
        h('pre', { style: Object.assign({ marginTop: '8px' }, S.pre) }, json || '（空）'),
        h('button', { style: S.btn(false), onClick: copy }, copied ? '✅ 已复制' : '复制 JSON'),
        h('div', { style: Object.assign({ marginTop: '12px' }, S.dim) },
          '导入：把 JSON 粘到「降级链」页逐条添加，或后续版本提供导入框。')))
    }

    // ── W11 作用域 ──
    function ScopeZone() {
      return h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '作用域'),
        h(KV, { k: '当前', v: '全局（写入 ~/.dsh/cs-myfree/）' }),
        h(KV, { k: '会话级 / 预设级', v: '后续版本' }),
        h('div', { style: Object.assign({ marginTop: '8px' }, S.dim) },
          '全局配置对所有会话生效。会话级覆盖会让同一台机器上不同会话用不同链。'))
    }

    // ── W12 诊断 ──
    function DiagZone() {
      const [res, setRes] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const run = () => {
        setBusy(true); setRes(null)
        api('/diag', { method: 'POST', body: JSON.stringify({}) })
          .then((r) => setRes(r))
          .catch((e) => setRes({ ok: false, summary: String((e && e.message) || e), checks: [] }))
          .then(() => setBusy(false))
      }
      return h('div', null,
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' } },
          h('button', { style: S.btn(true), onClick: run, disabled: busy }, busy ? '体检中…' : '一键体检'),
          h('span', { style: S.dim }, '检查路由 / 状态目录 / 链 / 免密源 / 余额 / 渠道')),
        res ? h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, (res.ok ? '✅ ' : '❌ ') + (res.summary || '')),
          (res.checks || []).map((c, i) => h('div', { key: i, style: S.row },
            h('span', null, (c.ok === true ? '✅ ' : c.ok === false ? '❌ ' : '⏸ ') + c.name),
            h('span', { style: Object.assign({ textAlign: 'right', marginLeft: '12px' }, S.dim) }, String(c.detail || '')))))
          : null)
    }

    const ZONE_VIEWS = {
      sources: SourcesZone, catalog: CatalogZone, chain: ChainZone, pin: PinZone,
      health: HealthZone, policy: PolicyZone, budget: BudgetZone, saver: SaverZone,
      observe: ObserveZone, io: IoZone, scope: ScopeZone, diag: DiagZone,
    }

    // ── 主设置页（含 Tab）──
    function MyfreeSection() {
      const [tab, setTab] = react.useState('sources')
      const View = ZONE_VIEWS[tab] || SourcesZone
      return h('div', { style: S.root },
        h('div', { style: S.h2 }, 'Myfree'),
        h('div', { style: S.sub }, '免费模型提供方 · 零第三方依赖 · 3 个免密源装完即用'),
        h(CashCard),
        h('div', { style: S.tabs }, ZONES.map((z) => h('span', {
          key: z.id, style: S.tab(tab === z.key), onClick: () => setTab(z.key), title: z.id,
        }, z.label))),
        h(View),
      )
    }

    // ── 左下角余额 chip ──
    function CashChip() {
      const [cash, setCash] = react.useState(null)
      const [tick, setTick] = react.useState(0)
      react.useEffect(() => {
        let alive = true
        const load = () => {
          fetch(CASH_PATH, { credentials: 'same-origin' })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
            .then((d) => { if (alive) setCash(d) })
            .catch(() => { if (alive) setCash((p) => p || { ok: false, errors: ['查询失败'] }) })
        }
        load()
        const t = setInterval(load, 60000)
        return () => { alive = false; clearInterval(t) }
      }, [tick])
      const ds = cash && cash.deepseek
      const text = ds && Array.isArray(ds.balances) && ds.balances.length
        ? ds.balances.map((b) => (b.currency === 'CNY' ? '¥' : b.currency + ' ') + Number(b.total).toFixed(2)).join(' ')
        : '¥ \u2014'
      const avail = ds && ds.available
      return h('span', {
        title: (avail ? 'DeepSeek 余额可用' : '余额未知 / 未配置 Key') + '（每 60 秒刷新，点击立即刷新）',
        style: {
          cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
          height: 28, padding: '0 8px', marginRight: 2, borderRadius: 6,
          fontSize: 13, lineHeight: '28px', fontWeight: 600, whiteSpace: 'nowrap',
          color: avail ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
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
          name: 'settings.section', id: 'cs-myfree', order: 200, label: () => 'Myfree',
        }, MyfreeSection))
      } catch (err) {
        try { console.warn('[cs-myfree] 设置分节注册失败：', (err && err.message) || err) } catch (_) {}
      }
      try {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'cs-myfree-cash', order: 40, label: () => '余额',
        }, CashChip))
      } catch (err) {
        try { console.warn('[cs-myfree] 余额 chip 槽位不可用：', (err && err.message) || err) } catch (_) {}
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.ZONES = ZONES
    exports.MyfreeSection = MyfreeSection
    exports.CashCard = CashCard
    exports.CashChip = CashChip
    return module.exports
  },
})
