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

    const VERSION = '1.8.0'
    const API = '/cs-myfree'
    const CASH_PATH = '/cs-myfree/cash'

    const ZONES = [
      { id: 'W0', key: 'overview', label: '总览' },
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
          if (!r.ok) {
            // 优先展示后端 JSON 里的 error 文案，而不是整段 JSON
            let reason = ''
            try { reason = String(JSON.parse(text)?.error || '') } catch (_) {}
            throw new Error('HTTP ' + r.status + (reason ? ' — ' + reason.slice(0, 200) : (text ? ' — ' + text.slice(0, 160) : '')))
          }
          try { return JSON.parse(text) } catch { throw new Error('响应不是 JSON：' + text.slice(0, 120)) }
        })
    }

    /** 找出「提交的配置」与「运行时回读的配置」不一致的字段路径（最多 6 条） */
    function findMismatch(sent, cur, path = '', out = []) {
      if (out.length >= 6) return out
      if (sent === null || typeof sent !== 'object') {
        if (!Object.is(sent, cur)) out.push(path || '(root)')
        return out
      }
      if (Array.isArray(sent)) {
        if (JSON.stringify(sent) !== JSON.stringify(cur)) out.push(path)
        return out
      }
      for (const k of Object.keys(sent || {})) {
        findMismatch(sent[k], cur == null ? undefined : cur[k], path ? path + '.' + k : k, out)
      }
      return out
    }

    /**
     * 保存后的「是否真的生效」判断。
     * 后端目前不保证回传 applied 字段：有就按后端说，没有就按诚实口径提示。
     */
    function applyVerdict(res) {
      if (res && res.applied === true) return { ok: true, text: '✅ 已保存并立即生效' }
      if (res && res.requiresRestart === true) return { ok: false, text: '✅ 已保存，需重启插件/宿主后生效' }
      if (res && res.applied === false) return { ok: false, text: '⚠️ 已写入文件，但运行时未生效（需重启插件/宿主）' }
      return { ok: null, text: '✅ 已写入文件；当前接口未报告是否热生效，若实际行为没变请重启插件/宿主' }
    }

    /** 数据加载 hook */
    function useApi(path, deps) {
      const [s, setS] = react.useState({ loading: true, data: null, error: null })
      const [tick, setTick] = react.useState(0)
      react.useEffect(() => {
        let alive = true
        setS((p) => ({ loading: true, data: p.data, error: null }))
        api(path)
          .then((d) => {
            if (!alive) return
            // 防御：非对象/非预期形状 ⇒ 当错误处理，别让下游 undefined 崩溃
            if (!d || typeof d !== 'object') {
              setS({ loading: false, data: null, error: '响应格式异常：' + String(d).slice(0, 80) })
              return
            }
            if (d.ok === false) {
              setS({ loading: false, data: null, error: d.error || (d.errors || []).join('；') || '接口返回 ok=false' })
              return
            }
            setS({ loading: false, data: d, error: null })
          })
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

    // ── 错误边界（关键：一个区崩了不能拖垮整页 → 白屏）──
    // React 的函数组件无法捕获自身渲染错误，必须用类组件做边界。
    class ErrorBoundary extends react.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error, info) {
        try { console.error('[cs-myfree] 区域渲染失败：', (error && error.message) || error, info) } catch (_) {}
      }
      render() {
        if (this.state.error) {
          const err = this.state.error
          return h('div', {
            style: {
              border: '1px solid rgba(200,80,80,0.5)', borderRadius: '8px',
              padding: '12px 14px', background: 'rgba(200,80,80,0.06)',
            },
          },
            h('div', { style: { fontWeight: 600, color: 'var(--dsw-alias-state-error-primary)' } },
              '这个区域渲染失败了（其它区域不受影响）'),
            h('div', { style: { marginTop: '6px', fontSize: '11px', fontFamily: 'ui-monospace, monospace', opacity: 0.8 } },
              String((err && err.message) || err)),
            h('div', { style: { marginTop: '8px', fontSize: '11px', opacity: 0.65 } },
              '可以把这段错误发我，我会修。'),
            h('div', { style: { marginTop: '10px' } },
              h('button', { style: S.btn(false), onClick: () => this.setState({ error: null }) }, '重试这个区域')),
          )
        }
        return this.props.children
      }
    }

    /** 把任意区域包进边界（key=当前分区：一个分区崩了不能连累其它分区） */
    function Safe(props) {
      return h(ErrorBoundary, { key: props.scope || 'zone' }, h(props.View))
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
        h('div', { style: Object.assign({ marginTop: '8px' }, S.dim) }, '只读查询，不产生费用 · 打开页面时自动查一次，点「刷新」立即重查'),
      )
    }

    // ── W0 总览 ──
    function OverviewZone() {
      const [st, reload] = useApi('/state')
      const [ch, reloadCh] = useApi('/channels')
      const d = st.data
      const c = ch.data

      const chainLen = d && d.chain ? d.chain.effectiveCount : null
      const chTotal = c ? c.total : null
      const chLogged = c ? (c.channels || []).filter((x) => x.loggedIn).length : null
      // ⚠️ /state 的 probe 只有 okCount，没有「探测了几个源」；不能拿免密源总数当分母（会显示 2/3）
      //    探测范围只覆盖默认优先源（当前 Kilo/OVH），所以这里只报「可用几个」+ 说明
      const keylessOk = d && d.probe ? d.probe.okCount + ' 个可用（探测范围：默认优先源）' : '未探测'
      const paidEnabled = !!(d && d.config && d.config.paid && d.config.paid.enabled)
      const chainProviders = d && d.chain && Array.isArray(d.chain.tiers)
        ? Array.from(new Set(d.chain.tiers.reduce((all, t) => all.concat(t.providers || []), [])))
        : []

      // 状态行：ok=null 表示「未就绪/不适用」，别用 false 假装失败
      const status = (ok, label, detail) => h('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid rgba(128,128,128,0.12)' } },
        h('span', null, (ok === true ? '✅ ' : ok === false ? '❌ ' : '⏸ ') + label),
        h('span', { style: S.dim }, detail))

      const keylessList = d && d.sources && Array.isArray(d.sources.keyless) ? d.sources.keyless : []
      const keylessLabels = keylessList.map((k) => k.label).join(' / ')

      if (st.error && !d) {
        return h('div', null,
          h(Err, { error: '状态接口读取失败：' + st.error }),
          h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
            h('button', { style: S.btn(true), onClick: () => { reload(); reloadCh() } }, '重试')),
          ch.error ? h(Err, { error: '渠道接口读取失败：' + ch.error }) : null)
      }

      return h('div', null,
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '一眼看懂当前状态'),
          status(chainLen === null ? null : chainLen > 0, '降级链', chainLen === null ? '加载中' : (chainLen + ' 条候选' + (chainLen === 0 ? '（空 ⇒ 必失败）' : ''))),
          status(d && d.probe ? !!d.probe.anyOk : null, '免密源', keylessOk),
          status(chLogged === null ? null : chLogged > 0, '渠道账号', chTotal === null ? '加载中' : (chLogged + '/' + chTotal + ' 家已登录')),
          status(null, 'DeepSeek 余额', '见上方卡片'),
          status(paidEnabled ? null : true, '付费闸门', paidEnabled ? '⚠️ 已开启（会花钱，注意限额）' : '默认全关（不会自动花钱）')),

        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '现在能用什么'),
          h('div', { style: S.dim },
            '· 免密源 ' + keylessList.length + ' 个' + (keylessLabels ? '（' + keylessLabels + '）' : '') + '，不需要任何账号'),
          h('div', { style: S.dim },
            '· 默认降级链 ' + (chainLen == null ? '…' : chainLen + ' 条') + (chainProviders.length ? '：' + chainProviders.join(' → ') : '') + '（未进链的源不会被自动调用）'),
          h('div', { style: S.dim },
            '· 你自己的账号：到「供给源」页点对应渠道的「登录」按钮'),
          h('div', { style: S.dim },
            '· 凭证只存本机 ~/.dsh/cs-myfree/accounts.json（0600），不上传')),

        h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
          h('button', { style: S.btn(false), onClick: () => { reload(); reloadCh() } }, '刷新')),
      )
    }

    // ── 渠道登录卡片（傻瓜式：优先一步，粘贴即保存）──
    // 每家渠道的推荐登录方式（与后端 login-mode.js 保持一致）
    const AK_SK_SET = ['qiniu','officeace','codearts','zcode','minimax','minimaxintl','accio','qoder','qodercn']
    function recommendModeOf(ch) {
      if (AK_SK_SET.indexOf(ch.id) >= 0) return 'aksk'
      if (ch.login === 'paste-key' || ch.login === 'none') return 'token'
      return 'oauth'
    }

    function ChannelLogin(props) {
      const ch = props.channel
      const [open, setOpen] = react.useState(false)
      const rec = recommendModeOf(ch)
      const [mode, setMode] = react.useState(rec)
      const [raw, setRaw] = react.useState('')
      const [ak, setAk] = react.useState('')
      const [sk, setSk] = react.useState('')
      const [msg, setMsg] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [autoSaved, setAutoSaved] = react.useState(false)
      const inputRef = react.useRef(null)
      const saveTimer = react.useRef(null)

      // 打开时自动聚焦输入框（省一次点击）
      react.useEffect(() => {
        if (open && inputRef.current && inputRef.current.focus) {
          setTimeout(() => { try { inputRef.current.focus() } catch (_) {} }, 80)
        }
      }, [open, mode])

      // 本地只做「有没有填」的判断；真正识别交给后端 /channels/parse
      const parsed = react.useMemo(() => {
        if (mode === 'aksk') {
          const a = ak.trim(), s = sk.trim()
          if (!a && !s) return { ok: false, error: '先填 AK 和 SK' }
          if (!a) return { ok: false, error: '还差 AK' }
          if (!s) return { ok: false, error: '还差 SK' }
          return { ok: true, credential: a + ':' + s, preview: 'AK/SK 已填齐' }
        }
        const s = String(raw || '').trim()
        if (!s) return { ok: false, error: '把链接或令牌粘贴进来' }
        // 本地不再猜测，交给后端校验（粘贴时自动触发）
        return { ok: false, error: '粘贴后会自动识别并保存' }
      }, [raw, mode, ak, sk])

      const doSave = (cred) => {
        setBusy(true); setMsg(null)
        api('/channels/save', { method: 'POST', body: JSON.stringify({ provider: ch.id, credential: cred }) })
          .then((r) => {
            if (r.ok) {
              setMsg({ ok: true, text: (r.hint ? '✅ ' + r.hint : '✅ 已保存') + '（模型会出现在「模型目录」页，可点刷新）' })
              setRaw(''); setAk(''); setSk('')
              props.onChanged && props.onChanged()
            } else {
              // 后端已支持 AK:SK；若仍报「有效令牌」类错误，给出替代方案（不假装成功）
              const shapeErr = mode === 'aksk' && /有效令牌|令牌形态/.test(String(r.error || ''))
              const hint = shapeErr ? '。AK/SK 形态被拒绝时，可先用上面的「粘贴令牌」方式登录，或用渠道自己的 API Key' : ''
              setMsg({ ok: false, error: (r.error || '保存失败') + hint })
            }
          })
          .catch((e) => setMsg({ ok: false, error: String((e && e.message) || e) }))
          .then(() => { setBusy(false); setAutoSaved(false) })
      }

      // 🔑 粘贴 → 交给**后端**统一校验（不再前端自己猜，避免规则不一致）
      const onPaste = (e) => {
        let text = ''
        try {
          text = (e.clipboardData || window.clipboardData).getData('text') || ''
        } catch (_) { return }
        if (!text.trim()) return
        setRaw(text)
        setAutoSaved(false)
        // 后端判定：只有真的识别出凭证才自动保存
        api('/channels/parse', { method: 'POST', body: JSON.stringify({ text }) })
          .then((r) => {
            if (r.ok) {
              setMsg({ ok: true, text: '✅ ' + (r.preview || '已识别') + '，正在保存…' })
              doSave(r.credential)     // 识别成功才自动保存
            } else {
              setMsg({ ok: false, error: r.error || '这段内容里没有有效令牌' })
            }
          })
          .catch((err) => setMsg({ ok: false, error: String((err && err.message) || err) }))
      }

      const del = (id) => {
        api('/channels/remove', { method: 'POST', body: JSON.stringify({ id }) })
          .then((r) => {
            if (r && r.ok === false) setMsg({ ok: false, error: r.error || '删除失败' })
            else setMsg({ ok: true, text: '✅ 已删除该账号' })
            props.onChanged && props.onChanged()
          })
          .catch((e) => setMsg({ ok: false, error: String((e && e.message) || e) }))
      }

      const accs = ch.accounts || []
      const MODES = [
        { id: 'aksk', label: 'AK / SK 永久授权', badge: '一步' },
        { id: 'token', label: '粘贴令牌', badge: '一步' },
        { id: 'oauth', label: '登录后自动识别', badge: '两步' },
      ]

      return h('div', { style: Object.assign({}, S.card, { marginBottom: '8px' }) },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' } },
          h('div', null,
            h('span', { style: { fontWeight: 600 } }, ch.label),
            ch.loggedIn ? h('span', { style: Object.assign({ marginLeft: '8px' }, S.dim, S.good) }, '✅ 已登录 ' + accs.length) : null,
            ch.checkin ? h('span', { style: Object.assign({ marginLeft: '8px' }, S.dim) }, '· 可签到') : null,
            ch.proxyRequired ? h('span', { style: Object.assign({ marginLeft: '8px' }, S.dim, S.warn) }, '· 需代理') : null),
          h('div', { style: { display: 'flex', gap: '6px' } },
            ch.loginUrl ? h('a', {
              href: ch.loginUrl, target: '_blank', rel: 'noreferrer',
              style: Object.assign({}, S.btn(false), { textDecoration: 'none', color: 'inherit' }),
            }, '去官网') : null,
            h('span', { style: S.btn(ch.loggedIn ? false : true), onClick: () => setOpen(!open) },
              open ? '收起' : (ch.loggedIn ? '再加一个' : '登录')))),

        accs.map((a) => h('div', { key: a.id, style: Object.assign({}, S.row, { marginTop: '6px' }) },
          h('span', null, a.label + ' ' + (a.masked || '')),
          h('span', { style: Object.assign({ cursor: 'pointer' }, S.dim, S.bad), onClick: () => del(a.id) }, '删除'))),

        open ? h('div', { style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid rgba(128,128,128,0.2)' } },
          // 后端给的登录指引（每家渠道步骤不同，之前完全没用上）
          (ch.guideTitle || (Array.isArray(ch.guideSteps) && ch.guideSteps.length)) ? h('div', { style: Object.assign({ marginBottom: '10px' }, S.dim) },
            ch.guideTitle ? h('div', { style: { fontWeight: 600 } }, '登录指引：' + ch.guideTitle) : null,
            (ch.guideSteps || []).map((s, i) => h('div', { key: i }, (i + 1) + '. ' + s)),
            ch.field ? h('div', { style: Object.assign({ marginTop: '4px' }, S.warn) }, '需要粘贴：' + ch.field) : null,
            ch.note ? h('div', { style: { marginTop: '4px' } }, '说明：' + ch.note) : null) : null,
          // 方式切换（默认选中推荐的那个）
          h('div', { style: { display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' } },
            MODES.map((m) => h('span', {
              key: m.id,
              style: Object.assign({}, S.btn(mode === m.id), { fontSize: '11px' }),
              onClick: () => { setMode(m.id); setMsg(null) },
            }, m.label + ' · ' + m.badge))),

          mode === 'aksk'
            ? h('div', null,
                h('div', { style: Object.assign({ marginBottom: '6px' }, S.dim) },
                  '在官网控制台的「访问密钥 / API 密钥」里创建一对，粘贴到下面两个框。配一次永久有效，不用再登录。'),
                h('input', {
                  ref: inputRef,
                  style: Object.assign({}, S.input, { marginBottom: '6px' }),
                  value: ak, placeholder: 'AK（Access Key / AccessKeyId）',
                  onChange: (e) => setAk(e.target.value),
                }),
                h('input', {
                  style: S.input, value: sk, placeholder: 'SK（Secret Key / AccessKeySecret）',
                  onChange: (e) => setSk(e.target.value),
                }))
            : h('div', null,
                mode === 'oauth'
                  ? h('div', { style: Object.assign({ marginBottom: '6px' }, S.dim) },
                      '① 点上面「去官网」完成登录　② 回来把地址栏那一整串链接直接粘贴到下面 —— 粘贴的瞬间就自动保存了，不用点按钮。')
                  : h('div', { style: Object.assign({ marginBottom: '6px' }, S.dim) },
                      '把令牌直接粘贴到下面，粘贴瞬间自动保存。'),
                h('input', {
                  ref: inputRef,
                  style: S.input, value: raw,
                  placeholder: '在这里按 Ctrl+V 粘贴' + (ch.field ? '（' + ch.field + '）' : '（支持完整链接、JSON、或裸令牌）'),
                  onPaste: onPaste,
                  onChange: (e) => setRaw(e.target.value),
                })),

          // 实时反馈
          h('div', { style: Object.assign({ marginTop: '8px' }, S.dim, parsed.ok ? S.good : S.warn) },
            busy ? '⏳ 正在保存…'
              : autoSaved ? '✅ 已自动识别并保存'
              : (parsed.ok ? '✅ ' + parsed.preview + '（点保存或直接粘贴自动存）' : '⏳ ' + parsed.error)),

          ch.loginWarn ? h('div', { style: Object.assign({ marginTop: '6px' }, S.dim, S.warn) }, '⚠️ ' + ch.loginWarn) : null,

          h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
            h('button', { style: S.btn(true), onClick: () => parsed.ok && doSave(parsed.credential), disabled: busy || !parsed.ok },
              busy ? '保存中…' : '保存'),
            h('button', { style: S.btn(false), onClick: () => { setRaw(''); setAk(''); setSk(''); setMsg(null); setOpen(false) } }, '取消')),

          h('div', { style: Object.assign({ marginTop: '8px' }, S.dim) },
            '🔒 凭证只存在你自己的电脑（~/.dsh/cs-myfree/accounts.json，仅本人可读），不上传任何服务器。'),
          msg ? h('div', { style: Object.assign({ marginTop: '8px' }, S.dim, msg.ok ? S.good : S.bad) }, msg.text || msg.error) : null) : null,
      )
    }

    // ── W1 供给源 ──
    function SourcesZone() {
      const [s, reload] = useApi('/state')
      const [cs, reloadCh] = useApi('/channels')
      const [probing, setProbing] = react.useState(false)
      const [probe, setProbe] = react.useState(null)
      const d = s.data
      const chData = cs.data

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
          '账号渠道（' + (chData ? chData.total : d.sources.counts.channels) + ' 家 · 点「登录」用你自己的账号）'),
        h('div', { style: Object.assign({ marginBottom: '10px' }, S.dim) },
          '每个渠道都可以登录多个账号。凭证只存本机，不上传。'),
        cs.error ? h(Err, { error: '渠道列表读取失败：' + cs.error }) : null,
        (chData && chData.channels ? chData.channels : []).map((c) => h(ChannelLogin, {
          key: c.id, channel: c, onChanged: () => { reloadCh(); reload() },
        })),
        !chData && !cs.error ? h('div', { style: S.dim }, '渠道列表加载中…（若一直不出现，看「诊断」页）') : null,
      )
    }

    // ── W2 模型目录 ──
    function CatalogZone() {
      const [s, reload] = useApi('/models')
      const [cm, reloadCm] = useApi('/channels/models')
      const [busy, setBusy] = react.useState(false)
      const [msg, setMsg] = react.useState(null)

      // 重新拉取渠道模型（真实请求各渠道的模型端点；后端失败会回落到内置清单）
      const refreshChannelModels = () => {
        setBusy(true); setMsg(null)
        api('/channels/models', { method: 'POST', body: JSON.stringify({}) })
          .then((r) => {
            setMsg(r.ok ? { ok: true, text: '✅ 已重新拉取：' + (r.total || 0) + ' 个渠道模型' } : { ok: false, error: r.error || '拉取失败' })
            reloadCm()
          })
          .catch((e) => setMsg({ ok: false, error: String((e && e.message) || e) }))
          .then(() => setBusy(false))
      }

      const d = s.data
      const cmData = cm.data || {}
      const models = Array.isArray(cmData.models) ? cmData.models : []
      const byChannel = cmData.byChannel || {}
      const channelIds = Object.keys(byChannel)
      const SOURCE_LABEL = {
        remote: '远端拉取（/v1/models）',
        builtin: '内置清单（该渠道无 models 端点）',
        'builtin-after-http-error': '远端失败 ⇒ 内置清单兜底',
        'builtin-empty-remote': '远端返回空 ⇒ 内置清单兜底',
        none: '无来源',
      }
      const sourceLabel = (s) => SOURCE_LABEL[s] || (s ? String(s) : '未报告')
      const defaultsOf = (id) => {
        const m = d && d.defaultModels ? d.defaultModels : {}
        return m[id] || m[String(id).replace(/-free$|-vision$/, '')] || '—'
      }
      // 按渠道分组（id 形如 <channel>/<model>）
      const groups = {}
      for (const m of models) {
        const cid = m.channelId || String(m.id || '').split('/')[0] || '未知渠道'
        if (!groups[cid]) groups[cid] = []
        groups[cid].push(m)
      }

      return h('div', null,
        h('div', { style: S.dim }, (d && d.note) || '（模型目录说明未返回）'),
        d && d.note ? h('div', { style: Object.assign({ marginTop: '4px' }, S.dim) }, '渠道模型不在这份「免密源默认模型」清单里，见下方「已登录渠道的模型」。') : null,
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
          h('button', { style: S.btn(false), onClick: () => { reload(); reloadCm() } }, '刷新'),
          h('button', { style: S.btn(true), onClick: refreshChannelModels, disabled: busy },
            busy ? '拉取中…（真实请求渠道）' : '重新拉取渠道模型')),

        msg ? h('div', { style: Object.assign({ marginTop: '8px' }, S.dim, msg.ok ? S.good : S.bad) }, msg.text || msg.error) : null,
        cm.error && cm.data === null ? h(Err, { error: '渠道模型读取失败：' + cm.error }) : null,
        s.error && s.data === null ? h(Err, { error: '免密源目录读取失败：' + s.error }) : null,
        s.data === null && s.loading ? h(Loading, { on: true }) : null,

        h('div', { style: { fontWeight: 600, margin: '14px 0 8px' } }, '免密源默认模型'),
        ((d && d.sources) || []).length === 0 && !s.loading
          ? h('div', { style: S.dim }, '（后端没有返回任何免密源）')
          : ((d && d.sources) || []).map((x) => h('div', { key: x.id, style: S.card },
              h('div', { style: { fontWeight: 600 } }, x.label),
              h(KV, { k: '默认模型', v: defaultsOf(x.id), dim: true }),
              x.note ? h(KV, { k: '说明', v: x.note, dim: true }) : null,
              h(KV, { k: '最近探测', v: x.probed ? (x.probed.ok ? '✅ ' + x.probed.ms + 'ms' : '❌ ' + (x.probed.error || '')) : '未探测', dim: true }))),

        h('div', { style: { fontWeight: 600, margin: '16px 0 8px' } },
          '已登录渠道的模型（' + (cmData.total != null ? cmData.total : models.length) + ' 个）'),
        models.length === 0
          ? h('div', { style: S.dim },
              cm.loading ? '渠道模型加载中…'
                : '（暂无渠道模型：到「供给源」登录渠道后会自动拉取；也可点上面的「重新拉取渠道模型」）')
          : channelIds.map((cid) => h('div', { key: cid, style: S.card },
              h('div', { style: { fontWeight: 600, marginBottom: '4px' } },
                cid + ' · ' + (groups[cid] ? groups[cid].length : 0) + ' 个'),
              byChannel[cid] && byChannel[cid].at
                ? h('div', { style: S.dim }, '上次拉取：' + new Date(byChannel[cid].at).toLocaleString() + ' · 来源：' + sourceLabel(byChannel[cid].source))
                : null,
              byChannel[cid] && byChannel[cid].ok === false
                ? h('div', { style: Object.assign({}, S.dim, S.warn) }, '⚠️ 上次拉取失败：' + (byChannel[cid].error || '未知原因') + '（已回落到内置清单）')
                : null,
              (groups[cid] || []).map((m) => h('div', { key: m.id, style: S.row },
                h('span', null, m.name || m.id + (m.source ? '（' + sourceLabel(m.source) + '）' : '')),
                h('span', { style: S.mono }, m.id + (Array.isArray(m.inputModalities) ? '  [' + m.inputModalities.join(',') + ']' : '')))))),

        h('div', { style: Object.assign({ marginTop: '8px' }, S.dim, S.warn) },
          '⚠️ 上面所有模型当前都只声明了 text 输入模态 ⇒ 聊天输入框不支持发图片（后端声明待修）。'),
        h('div', { style: Object.assign({ marginTop: '12px' }, S.dim) },
          '渠道模型 id 形如「渠道/模型」，登录成功后立即可用；来源（远端/内置兜底）由后端按渠道回传。'),
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
          h(KV, { k: '内置链', v: (Array.isArray(d.builtin) ? d.builtin.length : 0) + ' 条' }),
          h(KV, { k: '覆盖层', v: (Array.isArray(d.overrides) ? d.overrides : []).length + ' 条' }),
          h(KV, { k: '生效链', v: (Array.isArray(d.effective) ? d.effective : []).length + ' 条' }),
          h(KV, { k: '生效链来源', v: '内置 ' + (Array.isArray(d.builtin) ? d.builtin.length : 0) + ' + 覆盖 ' + (Array.isArray(d.overrides) ? d.overrides : []).length + ' ⇒ 合并 ' + (Array.isArray(d.effective) ? d.effective.length : 0) + ' 条' }),
          (d.tiers || []).length ? h('div', { style: Object.assign({ marginTop: '8px' }, S.dim) },
            d.tiers.map((t) => 'T' + t.tier + ':' + t.count).join('  ')) : null,
          // 诚实标注「页面显示的链」与「运行时实际选路」是否同源
          d.applied === true
            ? h('div', { style: Object.assign({ marginTop: '6px' }, S.dim, S.good) }, '✅ 页面这份链 = 运行时实际选路（同源）')
            : d.applied === false
              ? h('div', { style: Object.assign({ marginTop: '6px' }, S.dim, S.warn) }, '⚠️ 页面这份链与运行时不一致：保存后需重启插件/宿主才生效')
              : h('div', { style: Object.assign({ marginTop: '6px' }, S.dim) }, '（后端未报告该链是否已应用到运行时）')),

        h('div', { style: { fontWeight: 600, margin: '14px 0 8px' } }, '覆盖层（钉选 / 替换 / 增删 / 排序）'),
        h('div', { style: S.dim }, '同 provider+model ⇒ 替换内置条目的 tier；新的 ⇒ 追加到该层末尾。留空的条目保存时会被忽略。'),

        draft.length === 0 ? h('div', { style: Object.assign({ margin: '10px 0' }, S.dim) }, '（空 —— 保存后完全使用内置链）') : null,
        draft.map((e, i) => h('div', { key: i, style: Object.assign({}, S.tile, { marginBottom: '6px', display: 'flex', gap: '6px', alignItems: 'center' }) },
          h('span', { style: Object.assign({}, S.mono, S.dim) }, '#' + (i + 1)),
          h('input', { style: S.input, placeholder: 'provider（如 kilo）', value: e.provider, onChange: (ev) => set(i, 'provider', ev.target.value) }),
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
          h('div', { style: { fontWeight: 600 } }, msg.ok
            ? (msg.applied === true ? '✅ 已保存并立即生效'
              : msg.requiresRestart === true ? '✅ 已保存，需重启生效'
                : msg.applied === false ? '⚠️ 已写入文件，但运行时未生效'
                  : '✅ 已写入覆盖层文件（是否热生效后端未报告）')
            : '❌ 保存失败'),
          msg.ok && msg.applied !== true
            ? h('div', { style: Object.assign({}, S.dim, S.warn) }, (msg.applied === false || msg.requiresRestart === true)
                ? '需要重启插件（或宿主）后，实际选路才会用这份新链。'
                : '若保存后实际选路没变，请重启插件/宿主；把这条现象反馈给维护者。')
            : null,
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
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '免密源状态'),
          d.probe ? h('div', null,
            h(KV, { k: '最近探测', v: new Date(d.probe.at).toLocaleString() }),
            h(KV, { k: '可用', v: d.probe.okCount + ' 个（只探测默认优先源 Kilo/OVH）' + (d.probe.anyOk ? ' ✅' : ' ❌') }))
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

    // ── 可编辑配置通用组件 ──
    function ConfigEditor(props) {
      const [cfg, setCfg] = react.useState(null)
      const [msg, setMsg] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [tick, setTick] = react.useState(0)

      react.useEffect(() => {
        api('/config')
          .then((d) => setCfg((d && d.config) || {}))
          .catch((e) => setMsg({ ok: false, error: String((e && e.message) || e) }))
      }, [tick])

      if (!cfg) return h('div', { style: S.dim }, msg ? msg.error : '加载配置…')

      const setPath = (path, v) => setCfg((c) => {
        const next = JSON.parse(JSON.stringify(c || {}))
        let cur = next
        for (let i = 0; i < path.length - 1; i++) { if (!cur[path[i]]) cur[path[i]] = {}; cur = cur[path[i]] }
        cur[path[path.length - 1]] = v
        return next
      })
      const val = (path) => path.reduce((o, k) => (o == null ? undefined : o[k]), cfg)

      const save = () => {
        setBusy(true); setMsg(null)
        const sent = cfg
        api('/config', { method: 'POST', body: JSON.stringify(sent) })
          .then(async (r) => {
            if (!r.ok) {
              setMsg({ ok: false, error: r.error || (r.errors || []).join('；') || '保存失败' })
              return
            }
            // 关键：保存后**回读**运行时配置。后端只写文件不更新内存时，这里能抓到不一致
            let cur = null
            try { cur = (await api('/config')).config } catch (_) { /* 回读失败 ⇒ 按未确认处理 */ }
            const mismatch = cur ? findMismatch(sent, cur) : []
            if (cur && mismatch.length) {
              setMsg({
                ok: true,
                warn: '配置已写入文件，但运行时仍是旧值（回读不一致：' + mismatch.join('、') + '）⇒ 需重启插件/宿主后才生效',
                mismatch,
              })
            } else if (cur) {
              setMsg({ ok: true, text: '✅ 已保存并生效' })
            } else {
              setMsg({ ok: true, warn: '配置已写入文件，但无法回读确认是否生效 ⇒ 若实际行为没变请重启插件/宿主' })
            }
            props.onSaved && props.onSaved()
          })
          .catch((e) => setMsg({ ok: false, error: String((e && e.message) || e) }))
          .then(() => setBusy(false))
      }

      return h('div', null,
        (props.fields || []).map((f) => h('div', { key: f.path.join('.'), style: { marginBottom: '10px' } },
          h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, f.label),
          f.hint ? h('div', { style: Object.assign({ marginBottom: '4px' }, S.dim) }, f.hint) : null,
          f.type === 'bool'
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
                h('span', {
                  onClick: () => setPath(f.path, !(val(f.path) === true)),
                  style: {
                    cursor: 'pointer', userSelect: 'none',
                    display: 'inline-flex', alignItems: 'center',
                    width: '44px', height: '22px', borderRadius: '11px',
                    background: val(f.path) === true ? 'var(--dsw-alias-state-success-primary)' : 'rgba(128,128,128,0.35)',
                    transition: 'background 0.15s', flexShrink: 0,
                  },
                },
                  h('span', {
                    style: {
                      display: 'block', width: '18px', height: '18px', borderRadius: '50%',
                      background: '#fff', margin: '2px',
                      transform: val(f.path) === true ? 'translateX(22px)' : 'translateX(0)',
                      transition: 'transform 0.15s',
                    },
                  })),
                h('span', {
                  style: {
                    fontWeight: 600,
                    color: val(f.path) === true ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
                  },
                }, val(f.path) === true ? '已开启' : '已关闭'))
            : f.type === 'number'
              ? h('input', {
                  type: 'number', style: Object.assign({}, S.input, { width: '140px' }),
                  value: val(f.path) == null ? 0 : val(f.path),
                  onChange: (e) => setPath(f.path, Number(e.target.value)),
                })
              : f.type === 'list'
                ? h('input', {
                    style: S.input, value: (val(f.path) || []).join(', '),
                    placeholder: f.placeholder || '逗号分隔',
                    onChange: (e) => setPath(f.path, String(e.target.value).split(',').map((x) => x.trim()).filter(Boolean)),
                  })
                : h('input', {
                    style: S.input, value: val(f.path) == null ? '' : String(val(f.path)),
                    onChange: (e) => setPath(f.path, e.target.value),
                  }))),
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px' } },
          h('button', { style: S.btn(true), onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          h('button', { style: S.btn(false), onClick: () => { setCfg(null); setMsg(null); setTick((n) => n + 1) } }, '重新加载')),
        msg ? h('div', { style: Object.assign({ marginTop: '10px' }, S.card, { borderColor: msg.warn ? 'rgba(200,160,60,0.6)' : (msg.ok ? 'rgba(64,160,96,0.5)' : 'rgba(200,80,80,0.5)') }) },
          h('div', { style: { fontWeight: 600 } }, msg.ok ? (msg.warn ? '⚠️ 已写盘，但未确认生效' : '✅ 已保存') : '❌ 保存失败'),
          msg.text ? h('div', { style: Object.assign({}, S.dim, S.good) }, msg.text) : null,
          msg.warn ? h('div', { style: Object.assign({}, S.dim, S.warn) }, msg.warn) : null,
          msg.error ? h('div', { style: Object.assign({}, S.dim, S.warn) }, msg.error) : null) : null,
      )
    }

    // ── W6 保护策略（可编辑）──
    function PolicyZone() {
      const [rk, setRk] = react.useState(0)
      return h('div', null,
        h(ConfigSummary, { key: 'summary-' + rk, items: [
          { path: ['vision', 'mode'], label: '识图档位' },
          { path: ['search', 'budgetMs'], label: '搜索预算', fmt: (v) => v + ' ms' },
          { path: ['search', 'sources'], label: '搜索源' },
          { path: ['sources', 'disabled'], label: '禁用源' },
        ] }),
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, '保护策略'),
          h('div', { style: Object.assign({ marginBottom: '10px' }, S.dim, S.warn) },
            '⚠️ 图片输入说明：当前降级链上的模型都只声明了 text 模态（inputModalities: [text]），宿主不会把图片发给本模型 ⇒ 聊天输入框不能发图。下面的「识图档位」只影响已进入插件的图片预处理，不改变这个限制（后端声明待修）。'),
          h(ConfigEditor, { fields: [
            { path: ['search', 'budgetMs'], label: '搜索总预算 (ms)', type: 'number', hint: '单次搜索最多等多久；超时按已返回的部分结果用' },
            { path: ['search', 'sources'], label: '搜索源', type: 'list', hint: '逗号分隔。可选：bing-rss, bing-html, sogou, mwmbl' },
            { path: ['vision', 'mode'], label: '识图档位', type: 'text', hint: 'off（默认不出网）| local | free-cloud | paid-cloud' },
            { path: ['sources', 'disabled'], label: '禁用源', type: 'list', hint: '逗号分隔的源 id，如 kilo（注意不是旧别名 kilo-free）' },
          ], onSaved: () => setRk((n) => n + 1) })),
      )
    }

    /** 配置状态一览（一眼看到所有值，而不只是按钮） */
    function ConfigSummary(props) {
      const [s] = useApi('/config')
      if (s.error && !s.data) return h(Err, { error: '配置读取失败：' + s.error })
      if (!s.data) return h('div', { style: S.dim }, '加载中…')
      const c = s.data.config || {}
      const items = props.items || []
      const get = (path) => path.reduce((o, k) => (o == null ? undefined : o[k]), c)
      return h('div', { style: Object.assign({}, S.card, { marginBottom: '8px' }) },
        h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '当前生效值'),
        items.map((it) => {
          const v = get(it.path)
          const shown = it.fmt ? it.fmt(v) : (typeof v === 'boolean' ? (v ? '✅ 已开启' : '⛔ 已关闭') : (Array.isArray(v) ? (v.join(', ') || '（空）') : (v == null ? '—' : String(v))))
          const bad = it.bad ? it.bad(v) : false
          return h('div', { key: it.path.join('.'), style: S.row },
            h('span', null, it.label),
            h('span', { style: Object.assign({ textAlign: 'right', marginLeft: '12px', fontWeight: 500 }, bad ? S.warn : S.dim) }, shown))
        }),
      )
    }

    // ── W7 预算付费（可编辑）──
    function BudgetZone() {
      const [rk, setRk] = react.useState(0)
      return h('div', null,
        h(ConfigSummary, { key: 'summary-' + rk, items: [
          { path: ['paid', 'enabled'], label: '① 付费源' },
          { path: ['paid', 'allowAutoCall'], label: '付费是否可自动调用' },
          { path: ['paid', 'confirmEachTurn'], label: '② 逐次人工确认' },
          { path: ['budget', 'perCallCNY'], label: '④ 单次限额', fmt: (v) => '¥' + v, bad: (v) => !(v > 0) },
          { path: ['budget', 'dailyCNY'], label: '⑤ 日限额', fmt: (v) => '¥' + v, bad: (v) => !(v > 0) },
          { path: ['budget', 'monthlyCNY'], label: '⑤ 月限额', fmt: (v) => '¥' + v, bad: (v) => !(v > 0) },
        ] }),
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, '五道闸门'),
          h('div', { style: Object.assign({ marginBottom: '10px' }, S.dim) },
            '原则：deny-by-default，价格未知即拒。限额为 0 等同于禁止付费。'),
          h(ConfigEditor, { fields: [
            { path: ['paid', 'enabled'], label: '① 启用付费源', type: 'bool', hint: '关 = 付费模型永远不会被调用' },
            { path: ['paid', 'allowAutoCall'], label: '是否允许自动调用付费', type: 'bool', hint: '关 = 每次都要人工确认' },
            { path: ['paid', 'confirmEachTurn'], label: '② 逐次人工确认', type: 'bool' },
            { path: ['budget', 'perCallCNY'], label: '④ 单次限额 (¥)', type: 'number' },
            { path: ['budget', 'dailyCNY'], label: '⑤ 日限额 (¥)', type: 'number' },
            { path: ['budget', 'monthlyCNY'], label: '⑤ 月限额 (¥)', type: 'number' },
          ], onSaved: () => setRk((n) => n + 1) })),
      )
    }

    // ── W8 省 Token ──
    function SaverZone() {
      return h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, 'RTK 工具输出压缩'),
        h(KV, { k: '模块状态', v: '已内置（src/saver/rtk.js，导出 compressToolOutput）' }),
        h(KV, { k: '是否自动生效', v: '取决于宿主是否调用（当前插件未主动挂接工具输出管道）' }),
        h(KV, { k: '压缩对象', v: '仅工具输出（git diff/status/log、grep、find、构建日志）' }),
        h(KV, { k: '错误结果', v: '永不压缩（藏起来模型会重试同一调用）' }),
        h(KV, { k: '替换规则', v: '必须非空且严格更小，否则原样返回' }),
        h('div', { style: Object.assign({ marginTop: '8px' }, S.dim) },
          '⚠️ 诚实说明：本页只展示模块能力；若你的宿主版本没有把工具输出交给它，实际不会省 Token。节省统计在「可观测」里看真正发生的调用。'))
    }

    // ── W9 可观测（真实账本）──
    function ObserveZone() {
      const [s, reload] = useApi('/ledger')
      if (s.error) return h('div', null, h(Err, { error: s.error }), h('button', { style: S.btn(false), onClick: reload }, '重试'))
      if (!s.data) return h(Loading, { on: s.loading })
      const d = s.data
      const sum = d.summary || {}
      const spendDays = (d.spend && d.spend.days) || []
      const providers = (d.spend && d.spend.providers) || []
      const tokenDays = (d.token && d.token.days) || []

      return h('div', null,
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '花费汇总'),
          h(KV, { k: '今日花费', v: '¥' + (sum.todayCNY ?? 0) }),
          h(KV, { k: '本月花费', v: '¥' + (sum.monthCNY ?? 0) }),
          h(KV, { k: '今日调用', v: String(sum.todayCalls ?? 0) }),
          h(KV, { k: '累计调用', v: String(sum.totalCalls ?? 0) }),
          h(KV, { k: '付费调用', v: String(sum.paidCalls ?? 0) + (sum.costUnknown ? '（' + sum.costUnknown + ' 条价格未知）' : '') }),
          h(KV, { k: '数据源', v: d.spend && d.spend.ok ? d.spend.file : '未读到 spend.jsonl', dim: true })),

        spendDays.length ? h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '最近调用（按天）'),
          spendDays.slice(0, 7).map((x) => h('div', { key: x.date, style: S.row },
            h('span', null, x.date),
            h('span', { style: S.dim }, x.calls + ' 次  ¥' + x.costCNY + '  in ' + x.in + ' / out ' + x.out)))) : null,

        providers.length ? h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '按渠道'),
          providers.slice(0, 8).map((x) => h('div', { key: x.provider, style: S.row },
            h('span', null, x.provider),
            h('span', { style: S.dim }, x.calls + ' 次  ¥' + x.costCNY)))) : null,

        tokenDays.length ? h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '渠道 Token 账本（最近 5 天）'),
          tokenDays.slice(0, 5).map((x) => h('div', { key: x.date, style: S.row },
            h('span', null, x.date),
            h('span', { style: S.dim }, x.requests + ' 请求  in ' + x.inputTokens + ' / out ' + x.outputTokens + (x.errors ? '  错误 ' + x.errors : ''))))) : null,

        h('button', { style: S.btn(false), onClick: reload }, '刷新'),
      )
    }

    // ── W10 导入导出 ──
    function IoZone() {
      const [s, reload] = useApi('/chain')
      const [copied, setCopied] = react.useState(null)       // null | {ok,text}
      const [text, setText] = react.useState('')
      const [impMsg, setImpMsg] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const json = s.data ? JSON.stringify({ chain: s.data.overrides || [] }, null, 2) : ''
      const loadErr = s.error && !s.data ? s.error : null

      const copyText = (str) => {
        // 剪贴板 API 在非 https / 非 localhost 页面会被浏览器禁用 ⇒ 需要降级方案
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(str).then(
              () => ({ ok: true, text: '✅ 已复制到剪贴板' }),
              () => legacyCopy(str),
            )
          }
        } catch (_) { /* 走降级 */ }
        return Promise.resolve(legacyCopy(str))
      }
      const legacyCopy = (str) => {
        try {
          const doc = typeof document !== 'undefined' ? document : null
          if (!doc) return { ok: false, text: '复制失败：当前环境没有剪贴板 API，请手动选中下方文本复制' }
          const ta = doc.createElement('textarea')
          ta.value = str
          doc.body.appendChild(ta)
          ta.select()
          const ok = doc.execCommand && doc.execCommand('copy')
          doc.body.removeChild(ta)
          return ok ? { ok: true, text: '✅ 已复制到剪贴板（兼容模式）' } : { ok: false, text: '复制失败：请手动选中下方文本复制' }
        } catch (e) {
          return { ok: false, text: '复制失败：' + String((e && e.message) || e) + '（请手动选中文本复制）' }
        }
      }
      const copy = () => {
        copyText(json).then((r) => { setCopied(r); setTimeout(() => setCopied(null), 2500) })
      }

      const doImport = () => {
        let obj
        try { obj = JSON.parse(text) } catch (e) { setImpMsg({ ok: false, error: 'JSON 解析失败：' + String((e && e.message) || e) }); return }
        const list = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.chain) ? obj.chain : null)
        if (!list) { setImpMsg({ ok: false, error: '格式不对：需要 {"chain":[...]} 或直接是数组' }); return }
        const bad = list.filter((e) => !e || typeof e.provider !== 'string' || typeof e.model !== 'string' || !e.provider.trim() || !e.model.trim())
        if (bad.length) { setImpMsg({ ok: false, error: '有 ' + bad.length + ' 条缺 provider/model，未提交（第 ' + list.findIndex((e) => bad.includes(e)) + 1 + ' 条起）' }); return }
        setBusy(true); setImpMsg(null)
        api('/chain', { method: 'POST', body: JSON.stringify({ chain: list }) })
          .then((r) => {
            if (!r.ok) { setImpMsg({ ok: false, error: (r.errors || []).join('；') || r.error || '导入失败' }); return }
            const v = applyVerdict(r)
            setImpMsg({ ok: true, text: '已导入 ' + (r.count != null ? r.count : list.length) + ' 条。' + v.text })
            setText('')
            reload()
          })
          .catch((e) => setImpMsg({ ok: false, error: String((e && e.message) || e) }))
          .then(() => setBusy(false))
      }

      return h('div', null,
        loadErr ? h(Err, { error: '链路读取失败：' + loadErr }) : null,
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '导出链覆盖层'),
          h('div', { style: S.dim }, '只导出覆盖层（不含任何凭据/密钥）。'),
          h('pre', { style: Object.assign({ marginTop: '8px' }, S.pre) }, json || '（空）'),
          h('button', { style: S.btn(false), onClick: copy }, '复制 JSON'),
          copied ? h('div', { style: Object.assign({ marginTop: '6px' }, S.dim, copied.ok ? S.good : S.warn) }, copied.text) : null),

        h('div', { style: Object.assign({}, S.card, { marginTop: '12px' }) },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '导入链覆盖层'),
          h('div', { style: S.dim }, '粘贴 {"chain":[{"provider":"kilo","model":"kilo-auto/free","tier":1}]} 或直接粘贴数组；提交后整表覆盖（先清空再写入）。'),
          h('textarea', {
            style: Object.assign({}, S.input, { marginTop: '8px', minHeight: '90px', fontFamily: 'ui-monospace, monospace' }),
            value: text, placeholder: '在这里粘贴导出的 JSON',
            onChange: (e) => setText(e.target.value),
          }),
          h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
            h('button', { style: S.btn(true), onClick: doImport, disabled: busy || !text.trim() }, busy ? '导入中…' : '导入并覆盖'),
            h('button', { style: S.btn(false), onClick: () => { setText(''); setImpMsg(null) } }, '清空')),
          impMsg ? h('div', { style: Object.assign({ marginTop: '8px' }, S.dim, impMsg.ok ? S.good : S.warn) }, impMsg.text || impMsg.error) : null),
      )
    }

    // ── W11 作用域（普通人视角：卡片选择 + 表单编辑，不用写 JSON）──
    function ScopeZone() {
      const [s, reload] = useApi('/scope')
      const [pick, setPick] = react.useState('global')   // 当前选中的作用域
      const [msg, setMsg] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [form, setForm] = react.useState(null)
      const [idInput, setIdInput] = react.useState('')
      const loadFormRef = react.useRef(null)

      // 首次进入自动把「全局」现有配置填进表单（不用先点卡片）
      react.useEffect(() => {
        if (s.data && !form) loadFormRef.current && loadFormRef.current('global')
      }, [s.data])

      if (s.error) return h('div', null, h(Err, { error: s.error }), h('button', { style: S.btn(false), onClick: reload }, '重试'))

      const d = s.data || {}
      const layers = (d.effective && d.effective.layers) || {}
      const existingFiles = Array.isArray(d.files) ? d.files : []

      const CARDS = [
        { key: 'global', title: '全局', sub: '对所有对话生效', count: layers.global, tip: '最常用。改这里 = 全部生效' },
        { key: 'preset', title: '预设', sub: '只对某个智能体预设生效', count: layers.preset, tip: '需要填预设名（如 dev-steward）' },
        { key: 'session', title: '会话', sub: '只对某一次对话生效', count: layers.session, tip: '需要填会话 ID，日常基本用不到' },
      ]

      // 表单数据：选中作用域后加载
      const loadForm = (scope) => {
        setPick(scope); setMsg(null)
        if (scope === 'global') {
          api('/config').then((r) => setForm(r.config || {})).catch((e) => {
            setForm({})
            setMsg({ ok: false, error: '读取现有全局配置失败：' + String((e && e.message) || e) })
          })
        } else {
          setForm({})   // 预设/会话：后端没有单作用域读取接口，只能给空表单
        }
      }
      loadFormRef.current = loadForm

      // 简单的表单字段（覆盖最常改的几项，其余用折叠的「高级」）
      const FIELDS = [
        { path: ['budget', 'perCallCNY'], label: '单次最多花多少钱', unit: '元', type: 'number', help: '超过这个数就拒绝付费调用。填 0 = 完全禁止付费' },
        { path: ['budget', 'dailyCNY'], label: '每天最多花多少钱', unit: '元', type: 'number', help: '一天累计超过就停' },
        { path: ['budget', 'monthlyCNY'], label: '每月最多花多少钱', unit: '元', type: 'number', help: '一月累计超过就停' },
        { path: ['paid', 'enabled'], label: '允许调用付费模型', type: 'bool', help: '关掉 = 永远只用免费模型，不会花一分钱' },
        { path: ['paid', 'confirmEachTurn'], label: '每次付费都问我', type: 'bool', help: '开启后每次要花钱都会弹确认' },
        { path: ['vision', 'mode'], label: '识图方式', type: 'select', options: [
          { v: 'off', t: '关闭（最安全，图片不出本机）' },
          { v: 'free-cloud', t: '用免费云模型看图（推荐）' },
          { v: 'local', t: '只用本机模型（需自己装）' },
          { v: 'paid-cloud', t: '用付费模型看图' },
        ], help: '选「免费云模型」后，图片会发给免费的视觉模型识别成文字' },
        { path: ['search', 'budgetMs'], label: '搜索最多等多久', unit: '毫秒', type: 'number', help: '10000 = 10 秒。超时就用已拿到的部分结果' },
      ]

      const getPath = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj)
      const setPath = (path, v) => setForm((f) => {
        const next = JSON.parse(JSON.stringify(f || {}))
        let cur = next
        for (let i = 0; i < path.length - 1; i++) { if (!cur[path[i]]) cur[path[i]] = {}; cur = cur[path[i]] }
        cur[path[path.length - 1]] = v
        return next
      })

      const save = () => {
        setBusy(true); setMsg(null)
        const sent = form || {}
        if (pick === 'global') {
          api('/config', { method: 'POST', body: JSON.stringify(sent) })
            .then(async (r) => {
              if (!r.ok) { setMsg({ ok: false, error: r.error || '保存失败' }); return }
              // 回读运行时配置，确认是否真的生效（后端不保证热更新）
              let cur = null
              try { cur = (await api('/config')).config } catch (_) { /* 回读失败按未确认处理 */ }
              const mismatch = cur ? findMismatch(sent, cur) : []
              if (cur && mismatch.length) {
                setMsg({ ok: true, warn: '已写入全局配置文件，但运行时仍是旧值（' + mismatch.join('、') + '）⇒ 需重启插件/宿主后才生效' })
              } else if (cur) {
                setMsg({ ok: true, text: '✅ 已保存并生效' })
              } else {
                setMsg({ ok: true, warn: '已写入全局配置文件；无法回读确认是否生效，若行为没变请重启插件/宿主' })
              }
            })
            .catch((e) => setMsg({ ok: false, error: String((e && e.message) || e) }))
            .then(() => { setBusy(false); reload() })
        } else {
          const id = idInput.trim()
          if (!id) {
            setBusy(false)
            setMsg({ ok: false, error: pick === 'preset' ? '先填预设名（如 dev-steward）' : '先填会话 ID' })
            return
          }
          api('/scope', { method: 'POST', body: JSON.stringify({ scope: pick, id, config: sent, presetId: pick === 'preset' ? id : undefined, sessionId: pick === 'session' ? id : undefined }) })
            .then((r) => setMsg(r.ok
              ? { ok: true, warn: '已写入「' + pick + '」作用域文件；后端只回报写盘成功，运行时是否热生效需重启插件/宿主后确认' }
              : { ok: false, error: r.error || '写入失败' }))
            .catch((e) => setMsg({ ok: false, error: String((e && e.message) || e) }))
            .then(() => { setBusy(false); reload() })
        }
      }

      return h('div', null,
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '这些设置要在哪个范围内生效？'),
        h('div', { style: Object.assign({ marginBottom: '10px' }, S.dim) }, '点一张卡片选择。不知道选哪个就选「全局」。'),

        h('div', { style: Object.assign({ marginBottom: '10px' }, S.dim) },
          d.hint ? h('div', null, d.hint) : null,
          h('div', { style: { marginTop: '4px' } },
            '已有作用域文件：' + (existingFiles.length ? existingFiles.map((f) => f.name).join('、') : '（无）'))),

        h('div', { style: { display: 'flex', gap: '8px', marginBottom: '14px' } },
          CARDS.map((c) => h('div', {
            key: c.key,
            onClick: () => loadForm(c.key),
            style: {
              flex: 1, cursor: 'pointer', padding: '10px', borderRadius: '8px',
              border: '2px solid ' + (pick === c.key ? 'var(--dsw-alias-brand-primary)' : 'rgba(128,128,128,0.25)'),
              background: pick === c.key ? 'rgba(128,128,128,0.1)' : 'transparent',
            },
          },
            h('div', { style: { fontWeight: 600, marginBottom: '2px' } }, c.title),
            h('div', { style: S.dim }, c.sub),
            h('div', { style: Object.assign({ marginTop: '4px' }, S.dim) }, '已设 ' + (c.count ?? 0) + ' 个顶层键'),
            h('div', { style: Object.assign({ marginTop: '4px' }, S.dim, { fontStyle: 'italic' }) }, c.tip))) ),

        form
          ? h('div', { style: S.card },
              h('div', { style: { fontWeight: 600, marginBottom: '10px' } }, '「' + CARDS.find((c) => c.key === pick).title + '」范围的设置'),
              pick !== 'global' ? h('div', { style: { marginBottom: '14px' } },
                h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, pick === 'preset' ? '预设名' : '会话 ID'),
                h('input', {
                  style: Object.assign({}, S.input, { width: '280px', marginBottom: '4px' }),
                  value: idInput,
                  placeholder: pick === 'preset' ? '如 dev-steward' : '会话 ID',
                  onChange: (e) => setIdInput(e.target.value),
                }),
                h('div', { style: Object.assign({}, S.dim, S.warn) },
                  '后端没有「读取单个作用域已存值」的接口 ⇒ 这里显示空表单，保存只会写入你改过的字段；保存后需重启插件/宿主才确认生效。')) : null,
              FIELDS.map((f) => {
                const v = getPath(form, f.path)
                return h('div', { key: f.path.join('.'), style: { marginBottom: '14px' } },
                  h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, f.label + (f.unit ? '（' + f.unit + '）' : '')),
                  f.help ? h('div', { style: Object.assign({ marginBottom: '6px' }, S.dim) }, f.help) : null,
                  f.type === 'bool'
                    ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
                        h('span', {
                          onClick: () => setPath(f.path, !(v === true)),
                          style: {
                            cursor: 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center',
                            width: '44px', height: '22px', borderRadius: '11px', flexShrink: 0,
                            background: v === true ? 'var(--dsw-alias-state-success-primary)' : 'rgba(128,128,128,0.35)',
                          },
                        }, h('span', {
                          style: {
                            display: 'block', width: '18px', height: '18px', borderRadius: '50%',
                            background: '#fff', margin: '2px',
                            transform: v === true ? 'translateX(22px)' : 'translateX(0)',
                          },
                        })),
                        h('span', { style: { fontWeight: 600, color: v === true ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)' } },
                          v === true ? '已开启' : '已关闭'))
                    : f.type === 'select'
                      ? h('select', {
                          style: Object.assign({}, S.input, { width: '320px' }),
                          value: v ?? '', onChange: (e) => setPath(f.path, e.target.value),
                        }, f.options.map((o) => h('option', { key: o.v, value: o.v }, o.t)))
                      : h('input', {
                          type: f.type === 'number' ? 'number' : 'text',
                          style: Object.assign({}, S.input, { width: '200px' }),
                          value: v == null ? '' : v,
                          onChange: (e) => setPath(f.path, f.type === 'number' ? Number(e.target.value) : e.target.value),
                        }))
              }),
              h('div', { style: { display: 'flex', gap: '8px' } },
                h('button', { style: S.btn(true), onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
                h('button', { style: S.btn(false), onClick: () => loadForm(pick) }, '撤销修改')),
              msg ? h('div', { style: Object.assign({ marginTop: '10px' }, S.dim,
                msg.ok && !msg.warn ? S.good : (msg.ok ? S.warn : S.bad)) }, msg.text || msg.warn || msg.error) : null,
              h('div', { style: Object.assign({ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid rgba(128,128,128,0.2)' }, S.dim) },
                '生效顺序：会话 > 预设 > 全局。同一项在多处设置时，范围小的赢。'))
          : h('div', { style: S.dim }, '正在读取全局配置…（点上面卡片可切换范围）'),
      )
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
      overview: OverviewZone,
      sources: SourcesZone, catalog: CatalogZone, chain: ChainZone, pin: PinZone,
      health: HealthZone, policy: PolicyZone, budget: BudgetZone, saver: SaverZone,
      observe: ObserveZone, io: IoZone, scope: ScopeZone, diag: DiagZone,
    }

    // ── 主设置页（含 Tab）──
    function MyfreeSection() {
      const [tab, setTab] = react.useState('overview')
      const View = ZONE_VIEWS[tab] || SourcesZone
      return h('div', { style: S.root },
        h('div', { style: S.h2 }, 'Myfree'),
        h('div', { style: S.sub }, '免费模型提供方 · 零第三方依赖 · 免密源开箱可用（默认链：Kilo / OVH；Pollinations 可选、默认未入链）'),
        h(CashCard),
        h('div', { style: S.tabs }, ZONES.map((z) => h('span', {
          key: z.id, style: S.tab(tab === z.key), onClick: () => setTab(z.key), title: z.id,
        }, z.label))),
        // key=tab：切分区时重建错误边界，避免一个分区崩了让所有分区一直显示错误页
        h(Safe, { scope: tab, View: View }),
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
    exports.ErrorBoundary = ErrorBoundary
    exports.Safe = Safe
    return module.exports
  },
})
