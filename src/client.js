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

    const VERSION = '1.9.20'
    const API = '/cs-myfree'
    const CASH_PATH = '/cs-myfree/cash'

    // ── 极简二维码编码器（byte 模式 / 纠错 M / 版本 1-10 / 零依赖）──
    //
    // 为什么内联：零第三方依赖红线，而扫码登录必须显示**可扫的二维码**。
    // 实现与 Python qrcode 参考实现逐模块对比过（4 组文本 × 8 个 mask 全一致），
    // 见 test/client-login.test.mjs 的固定快照用例。
    const QR_RS = {
      1: [[26, 16]],
      2: [[44, 28]],
      3: [[70, 44]],
      4: [[50, 32], [50, 32]],
      5: [[67, 43], [67, 43]],
      6: [[43, 27], [43, 27], [43, 27], [43, 27]],
      7: [[49, 31], [49, 31], [49, 31], [49, 31]],
      8: [[60, 38], [60, 38], [61, 39], [61, 39]],
      9: [[58, 36], [58, 36], [58, 36], [59, 37], [59, 37]],
      10: [[69, 43], [69, 43], [69, 43], [69, 43], [70, 44]],
    }
    const QR_ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] }

    const QR_EXP = new Array(512)
    const QR_LOG = new Array(256)
    ;(() => {
      let x = 1
      for (let i = 0; i < 255; i++) {
        QR_EXP[i] = x
        QR_LOG[x] = i
        x <<= 1
        if (x & 0x100) x ^= 0x11d
      }
      for (let i = 255; i < 512; i++) QR_EXP[i] = QR_EXP[i - 255]
    })()

    function gfMul(a, b) {
      if (a === 0 || b === 0) return 0
      return QR_EXP[QR_LOG[a] + QR_LOG[b]]
    }

    function rsPoly(n) {
      let poly = [1]
      for (let i = 0; i < n; i++) {
        const next = new Array(poly.length + 1).fill(0)
        for (let j = 0; j < poly.length; j++) {
          next[j] ^= poly[j]
          next[j + 1] ^= gfMul(poly[j], QR_EXP[i])
        }
        poly = next
      }
      return poly
    }

    function rsEcc(data, ecLen) {
      const gen = rsPoly(ecLen)
      const rem = new Array(ecLen).fill(0)
      for (const d of data) {
        const factor = d ^ rem[0]
        rem.shift(); rem.push(0)
        if (factor !== 0) for (let i = 0; i < ecLen; i++) rem[i] ^= gfMul(gen[i + 1], factor)
      }
      return rem
    }

    function utf8Bytes(str) {
      if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(str))
      const out = []
      for (const ch of String(str)) {
        let c = ch.codePointAt(0)
        if (c < 0x80) out.push(c)
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
      }
      return out
    }

    function dataCodewords(version) {
      return QR_RS[version].reduce((n, b) => n + b[1], 0)
    }

    function pushBits(bits, value, len) {
      for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1)
    }

    function pickVersion(text) {
      const len = utf8Bytes(text).length
      for (let v = 1; v <= 10; v++) {
        const header = 4 + (v >= 10 ? 16 : 8)
        const bits = header + len * 8
        if (bits <= dataCodewords(v) * 8) return v
      }
      throw new Error('二维码内容过长（超过版本 10 容量）')
    }

    function encodeBytes(text, version) {
      const bytes = utf8Bytes(text)
      const total = dataCodewords(version)
      const bits = []
      pushBits(bits, 0b0100, 4)
      pushBits(bits, bytes.length, version >= 10 ? 16 : 8)
      for (const b of bytes) pushBits(bits, b, 8)
      if (bits.length > total * 8) throw new Error('容量不足')
      pushBits(bits, 0, Math.min(4, total * 8 - bits.length))
      while (bits.length % 8) bits.push(0)
      const data = []
      for (let i = 0; i < bits.length; i += 8) {
        let v = 0
        for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]
        data.push(v)
      }
      const pad = [0xec, 0x11]
      let k = 0
      while (data.length < total) data.push(pad[k++ % 2])
      return data
    }

    function makeCodewords(data, version) {
      const blocks = QR_RS[version]
      const dataBytes = []
      const eccBytes = []
      let offset = 0
      for (const [total, dlen] of blocks) {
        const chunk = data.slice(offset, offset + dlen)
        offset += dlen
        dataBytes.push(chunk)
        eccBytes.push(rsEcc(chunk, total - dlen))
      }
      const out = []
      const maxD = Math.max(...dataBytes.map((b) => b.length))
      for (let i = 0; i < maxD; i++) for (const b of dataBytes) if (i < b.length) out.push(b[i])
      const maxE = Math.max(...eccBytes.map((b) => b.length))
      for (let i = 0; i < maxE; i++) for (const b of eccBytes) if (i < b.length) out.push(b[i])
      return out
    }

    function bchDigit(data) {
      let digit = 0
      while (data !== 0) { digit++; data >>>= 1 }
      return digit
    }
    const G15 = 0x537
    const G18 = 0x1f25
    const G15_MASK = 0x5412
    function bchTypeInfo(data) {
      let d = data << 10
      while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15))
      return ((data << 10) | d) ^ G15_MASK
    }
    function bchTypeNumber(data) {
      let d = data << 12
      while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18))
      return (data << 12) | d
    }
    function maskFn(pattern, i, j) {
      switch (pattern) {
        case 0: return (i + j) % 2 === 0
        case 1: return i % 2 === 0
        case 2: return j % 3 === 0
        case 3: return (i + j) % 3 === 0
        case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0
        case 5: return (i * j) % 2 + (i * j) % 3 === 0
        case 6: return ((i * j) % 2 + (i * j) % 3) % 2 === 0
        case 7: return ((i * j) % 3 + (i + j) % 2) % 2 === 0
        default: return false
      }
    }

    function buildMatrix(version, codewords, mask) {
      const size = version * 4 + 17
      const m = Array.from({ length: size }, () => new Array(size).fill(null))

      const finder = (row, col) => {
        for (let r = -1; r <= 7; r++) {
          for (let c = -1; c <= 7; c++) {
            const rr = row + r
            const cc = col + c
            if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
            m[rr][cc] = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
              (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
              (r >= 2 && r <= 4 && c >= 2 && c <= 4)
          }
        }
      }
      finder(0, 0)
      finder(size - 7, 0)
      finder(0, size - 7)

      // timing
      for (let r = 8; r < size - 8; r++) if (m[r][6] === null) m[r][6] = r % 2 === 0
      for (let c = 8; c < size - 8; c++) if (m[6][c] === null) m[6][c] = c % 2 === 0

      // alignment
      const pos = QR_ALIGN[version]
      for (const row of pos) {
        for (const col of pos) {
          if (m[row][col] !== null) continue
          for (let r = -2; r <= 2; r++) {
            for (let c = -2; c <= 2; c++) {
              m[row + r][col + c] = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0)
            }
          }
        }
      }

      // 预留格式信息区（先填值占位，避免数据覆盖；最终再覆盖正确值）
      const typeInfo = bchTypeInfo((0 << 3) | mask) // 0 = M
      for (let i = 0; i < 15; i++) {
        const mod = ((typeInfo >> i) & 1) === 1
        if (i < 6) m[i][8] = mod
        else if (i < 8) m[i + 1][8] = mod
        else m[size - 15 + i][8] = mod
      }
      for (let i = 0; i < 15; i++) {
        const mod = ((typeInfo >> i) & 1) === 1
        if (i < 8) m[8][size - i - 1] = mod
        else if (i < 9) m[8][15 - i - 1 + 1] = mod
        else m[8][15 - i - 1] = mod
      }
      m[size - 8][8] = true
      if (version >= 7) {
        const bits = bchTypeNumber(version)
        for (let i = 0; i < 18; i++) {
          const mod = ((bits >> i) & 1) === 1
          m[Math.floor(i / 3)][i % 3 + size - 8 - 3] = mod
          m[i % 3 + size - 8 - 3][Math.floor(i / 3)] = mod
        }
      }

      // 数据放置
      let inc = -1
      let row = size - 1
      let bitIndex = 7
      let byteIndex = 0
      for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col--
        for (;;) {
          for (let c = 0; c < 2; c++) {
            if (m[row][col - c] === null) {
              let dark = false
              if (byteIndex < codewords.length) dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1
              if (maskFn(mask, row, col - c)) dark = !dark
              m[row][col - c] = dark
              bitIndex--
              if (bitIndex === -1) { byteIndex++; bitIndex = 7 }
            }
          }
          row += inc
          if (row < 0 || row >= size) { row -= inc; inc = -inc; break }
        }
      }
      return m
    }

    function penalty(m, size) {
      let lost = 0
      for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
          let same = 0
          const dark = m[row][col]
          for (let r = -1; r <= 1; r++) {
            if (row + r < 0 || row + r >= size) continue
            for (let c = -1; c <= 1; c++) {
              if (col + c < 0 || col + c >= size) continue
              if (r === 0 && c === 0) continue
              if (dark === m[row + r][col + c]) same++
            }
          }
          if (same > 5) lost += 3 + same - 5
        }
      }
      for (let row = 0; row < size - 1; row++) {
        for (let col = 0; col < size - 1; col++) {
          let count = 0
          if (m[row][col]) count++
          if (m[row + 1][col]) count++
          if (m[row][col + 1]) count++
          if (m[row + 1][col + 1]) count++
          if (count === 0 || count === 4) lost += 3
        }
      }
      for (let row = 0; row < size; row++) {
        for (let col = 0; col < size - 6; col++) {
          if (m[row][col] && !m[row][col + 1] && m[row][col + 2] && m[row][col + 3] && m[row][col + 4] && !m[row][col + 5] && m[row][col + 6]) lost += 40
        }
      }
      for (let col = 0; col < size; col++) {
        for (let row = 0; row < size - 6; row++) {
          if (m[row][col] && !m[row + 1][col] && m[row + 2][col] && m[row + 3][col] && m[row + 4][col] && !m[row + 5][col] && m[row + 6][col]) lost += 40
        }
      }
      let darkCount = 0
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) darkCount++
      const ratio = Math.abs((100 * darkCount) / (size * size) - 50) / 5
      lost += Math.floor(ratio) * 10
      return lost
    }

    function qrMatrix(text, opts = {}) {
      const version = opts.version || pickVersion(text)
      const data = encodeBytes(text, version)
      const codewords = makeCodewords(data, version)
      const masks = opts.mask != null ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7]
      let best = null
      let bestScore = Infinity
      for (const mask of masks) {
        const m = buildMatrix(version, codewords, mask)
        const score = penalty(m, version * 4 + 17)
        if (score < bestScore) { bestScore = score; best = { version, size: version * 4 + 17, mask, modules: m } }
      }
      return best
    }

    // design/21 §1：5 Tab 信息架构（旧 14 区组件源码保留，仅不再进 ZONES）
    const ZONES = [
      { id: 'W0', key: 'overview', label: '总览' },
      { id: 'W1', key: 'sources', label: '供给源' },
      { id: 'W2', key: 'models', label: '模型与路由' },
      { id: 'W3', key: 'settings', label: '设置' },
    ]

    // ── 通用样式 ──
    /** 时间戳 ⇒ 本地「月-日 时:分」（验证时间戳用；非法/缺失返回空串，不显示 "Invalid Date"） */
    const fmtDate = (ts) => {
      const n = Number(ts)
      if (!Number.isFinite(n) || n <= 0) return ''
      try {
        const d = new Date(n)
        const p = (x) => String(x).padStart(2, '0')
        return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
      } catch { return '' }
    }
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
      badge: (kind) => ({
        display: 'inline-block', marginLeft: '8px', padding: '0 6px', borderRadius: '4px',
        fontSize: '10px', lineHeight: '16px', fontWeight: 600, verticalAlign: 'middle', whiteSpace: 'nowrap',
        background: kind === 'warn' ? 'rgba(220,160,40,0.20)' : kind === 'good' ? 'rgba(64,160,96,0.16)' : 'rgba(128,128,128,0.16)',
        color: kind === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : kind === 'good' ? 'var(--dsw-alias-state-success-primary)' : 'inherit',
      }),
      codeBlock: {
        margin: '6px 0', padding: '8px', borderRadius: '6px', background: 'rgba(128,128,128,0.10)',
        fontFamily: 'ui-monospace, monospace', fontSize: '12px', whiteSpace: 'pre-wrap',
        wordBreak: 'break-all', maxWidth: '100%', boxSizing: 'border-box',
      },
      bigCode: {
        fontSize: '20px', fontWeight: 700, letterSpacing: '1px', fontFamily: 'ui-monospace, monospace',
        wordBreak: 'break-all', padding: '8px 10px', borderRadius: '6px',
        background: 'rgba(64,160,96,0.10)', border: '1px dashed rgba(128,128,128,0.4)', display: 'inline-block', maxWidth: '100%', boxSizing: 'border-box',
      },
      skeleton: { height: '16px', borderRadius: '4px', background: 'rgba(128,128,128,0.15)', margin: '8px 0' },
      primaryBtn: {
        cursor: 'pointer', fontSize: '13px', padding: '6px 16px', borderRadius: '8px',
        border: '1px solid rgba(64,160,96,0.55)', background: 'rgba(64,160,96,0.20)',
        color: 'inherit', fontWeight: 600, whiteSpace: 'nowrap',
      },
      secondaryLink: {
        color: 'inherit', opacity: 0.65, fontSize: '11px', cursor: 'pointer',
        textDecoration: 'underline', whiteSpace: 'nowrap',
      },
      wizard: {
        marginTop: '12px', paddingTop: '12px', borderTop: '1px solid rgba(128,128,128,0.18)',
        display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start',
      },
      link: { color: 'var(--dsw-alias-brand-primary)', cursor: 'pointer', textDecoration: 'underline', wordBreak: 'break-all', fontSize: '12px' },
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
    /** 复制纯文本（兼容非 https 页面：navigator.clipboard 会被浏览器禁用） */
    function legacyCopyText(str) {
      try {
        const doc = typeof document !== 'undefined' ? document : null
        if (!doc) return { ok: false, text: '复制失败：当前环境没有剪贴板 API，请手动选中文本复制' }
        const ta = doc.createElement('textarea')
        ta.value = str
        doc.body.appendChild(ta)
        ta.select()
        const ok = doc.execCommand && doc.execCommand('copy')
        doc.body.removeChild(ta)
        return ok ? { ok: true, text: '✅ 已复制到剪贴板（兼容模式）' } : { ok: false, text: '复制失败：请手动选中文本复制' }
      } catch (e) {
        return { ok: false, text: '复制失败：' + String((e && e.message) || e) + '（请手动选中文本复制）' }
      }
    }
    function copyPlainText(str) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(str).then(
            () => ({ ok: true, text: '✅ 已复制到剪贴板' }),
            () => legacyCopyText(str),
          )
        }
      } catch (_) { /* 走降级 */ }
      return Promise.resolve(legacyCopyText(str))
    }

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

    /**
     * 通用开关（滑块）。与设置页里内联的开关**同一套样式**，抽出来是为了新增卡片
     * 不再复制 30 行 DIV；`label` 不传 ⇒ 显示「已开启 / 已关闭」。
     * disabled=true ⇒ 置灰且不可点（识图 mode=off 时下方子项全部置灰就靠它）。
     */
    function Toggle(props) {
      const on = props.value === true
      const dis = props.disabled === true
      const flip = () => { if (!dis && typeof props.onChange === 'function') props.onChange(!on) }
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        h('span', {
          onClick: dis ? undefined : flip,
          style: {
            cursor: dis ? 'not-allowed' : 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center',
            width: '44px', height: '22px', borderRadius: '11px', flexShrink: 0, opacity: dis ? 0.5 : 1,
            background: on ? 'var(--dsw-alias-state-success-primary)' : 'rgba(128,128,128,0.35)',
          },
        }, h('span', {
          style: {
            display: 'block', width: '18px', height: '18px', borderRadius: '50%',
            background: '#fff', margin: '2px',
            transform: on ? 'translateX(22px)' : 'translateX(0)',
          },
        })),
        h('span', {
          onClick: dis ? undefined : flip,
          style: Object.assign(
            { fontWeight: 600, cursor: dis ? 'not-allowed' : 'pointer', userSelect: 'none', opacity: dis ? 0.5 : 1 },
            on ? S.good : { color: 'var(--dsw-alias-label-secondary)' },
          ),
        }, props.label !== undefined ? props.label : (on ? '已开启' : '已关闭')))
    }

    /**
     * 账本「表格」的一行。**本文件全是 flex，刻意不用 <table>**（窄屏会溢出）。
     * 列宽固定 ⇒ 表头 / 渠道行 / 模型子行天然对齐；indent=true 用于 per-model 子行缩进。
     * 列序：渠道/模型 | 切换成功 | 调用 | 失败 | token(in/out)
     *
     * 单元格可以直接给字符串，也可以给 `{ text, warn }`：warn=true ⇒ 该格用 S.warn 高亮
     * （失败数 > 0 的格子就靠它标红，不用为了一格颜色重写整行）。
     */
    function spendRow(opts, cells) {
      const o = opts || {}
      const widths = ['1 1 180px', '62px', '58px', '58px', '104px']
      return h('div', {
        style: {
          display: 'flex', gap: '6px', alignItems: 'baseline',
          padding: o.indent ? '2px 0 2px 16px' : '4px 0',
          borderBottom: o.head ? '1px solid rgba(128,128,128,0.35)' : '1px solid rgba(128,128,128,0.10)',
        },
      }, (cells || []).map((c, i) => {
        const cell = (c && typeof c === 'object') ? c : { text: c }
        return h('span', {
          key: i,
          style: Object.assign({
            flex: widths[i] || '1 1 60px', minWidth: 0, textAlign: i === 0 ? 'left' : 'right',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }, o.head ? S.dim : null, o.dim && !o.head ? { opacity: 0.75, fontSize: '11px' } : null,
          cell.warn ? S.warn : null),
        }, cell.text)
      }))
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
      return h(ErrorBoundary, { key: props.scope || 'zone' }, h(props.View, props.viewProps || {}))
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
      // 契约 A4：切换成功统计（/state → routing.switches）。
      // 口径：分母 = 成功调用数，不是账本行数 ⇒ 后端拿不到时分母 0、成功率 null（显示「—」，不假装 0%）。
      const sw = (d && d.routing && d.routing.switches) || null
      // 成功率 null = 还没有「成功调用」当分母 ⇒ **只报次数**，不要显示「成功率 —」或 0%
      const swRate = sw && sw.switchSuccessRate != null ? sw.switchSuccessRate + '%' : null
      const swText = !sw
        ? '未就绪（后端未返回 routing.switches）'
        : (Number(sw.total) || 0) + ' 次' + (swRate ? '（成功率 ' + swRate + '）' : '')
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
          status(paidEnabled ? null : true, '付费闸门', paidEnabled ? '⚠️ 已开启（会花钱，注意限额）' : '默认全关（不会自动花钱）'),
          // 「切换成功」：换了候选才成功的调用数（口径 A；失败行不构成"切换机会"）
          status(sw ? (Number(sw.total) || 0) > 0 : null, '切换成功', swText)),

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

        // design/21 §0.3/§1：诊断并入总览（复用旧 DiagZone 渲染，不删源码）
        h('div', { style: { marginTop: '14px', borderTop: '1px solid rgba(128,128,128,0.18)', paddingTop: '12px' } },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '一键体检'),
          h(DiagZone)),
        // design/21 §1：可观测花费汇总并入总览（复用旧 ObserveZone 渲染）
        h('div', { style: { marginTop: '14px', borderTop: '1px solid rgba(128,128,128,0.18)', paddingTop: '12px' } },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '花费与用量'),
          h(ObserveZone)),
      )
    }

    // ── 渠道登录向导（5 种 flow：browser / device / qr / paste / aksk）──
    //
    // 设计依据：用户投诉「点去官网拿不到授权」。
    // 根因：把 redirect 写成 127.0.0.1（用户浏览器在另一台机器）＋ 让用户手工复制授权码。
    // 现在：browser/device/qr 全部走后端状态机（公网回调 + 轮询），UI 只展示状态；
    //       paste/aksk 保留一步粘贴（后端解析原始文本，前端不再持有/回显凭据原文）。
    const FLOW_META = {
      browser: { label: '浏览器授权', tip: '点「打开登录页」，在浏览器完成授权后会自动回来' },
      device: { label: '设备码', tip: '打开验证页，输入设备码确认' },
      qr: { label: '扫码登录', tip: '用手机扫码确认' },
      paste: { label: '粘贴 API Key', tip: '官方只提供 API Key：粘贴即可（支持整段回调链接自动识别）' },
      aksk: { label: 'AK / SK', tip: '在官网「访问密钥」创建一对，一次配置永久有效' },
    }
    // 轮询间隔：默认 1.5s；测试可注入 window.__CS_MYFREE_POLL_MS 加速（生产不受影响）
    const LOGIN_POLL_MS = (typeof window !== 'undefined' && Number(window.__CS_MYFREE_POLL_MS) > 0)
      ? Number(window.__CS_MYFREE_POLL_MS)
      : 1500
    const flowMeta = (flow) => FLOW_META[flow] || { label: flow || '登录', tip: '' }
    /**
     * flow 的「人话」名称。device 流有两种形态：
     *  · 有 url（如 qoder：浏览器授权页 + 纯轮询，userCode 为空）⇒ 浏览器授权（轮询）
     *  · 无 url + userCode ⇒ 设备码
     */
    const flowLabelOf = (flow, sess) => {
      if (flow === 'device') return (sess && sess.url) ? '浏览器授权（轮询）' : '设备码'
      if (flow === 'browser') return (sess && sess.pollingOnly) ? '浏览器授权（轮询）' : '浏览器授权'
      return flowMeta(flow).label
    }

    /** 把 QR 内容渲染成 SVG（单个 path：v10 也只有一个 DOM 节点，窄屏不溢出） */
    function QrCode(props) {
      let qr = null
      try {
        qr = qrMatrix(String(props.text || ''))
      } catch (e) {
        return h('div', { style: Object.assign({ marginTop: '6px' }, S.dim, S.warn) }, '二维码生成失败：' + String((e && e.message) || e) + '（可复制下方内容用手机打开）')
      }
      const size = qr.size
      const px = Number(props.size) > 0 ? Number(props.size) : 168
      const path = []
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) if (qr.modules[r][c]) path.push('M' + c + ' ' + r + 'h1v1h-1z')
      }
      return h('svg', {
        width: px, height: px, viewBox: '0 0 ' + size + ' ' + size,
        shapeRendering: 'crispEdges', role: 'img', 'aria-label': '登录二维码',
        style: { display: 'block', background: '#fff', borderRadius: '6px', padding: '4px', maxWidth: '100%', boxSizing: 'border-box' },
      },
        h('rect', { width: size, height: size, fill: '#fff' }),
        h('path', { d: path.join(''), fill: '#000' }),
      )
    }

    function Badge(props) {
      return h('span', { style: S.badge(props.kind || 'dim'), title: props.title || '' }, props.children)
    }

    /**
     * 一个渠道的登录卡片：
     *  · 头部：渠道名 + 登录状态 + 已验证/未验证徽标 + flow 类型 + 一键登录/再加一个
     *  · 账号列表：掩码 + 测试 / 续期 / 删除（二次确认）
     *  · 展开后：按 flow 渲染向导；轮询到 ok 显示掩码 + 立即测试连通
     */
    function ChannelCard(props) {
      const ch = props.channel || {}
      const st = props.status || {}
      const flow = (st && st.flow) || ch.flow || 'paste'
      const verified = ch.loginVerified === true || st.loginVerified === true
      const loginNote = ch.loginNote || st.note || ''
      const refreshable = st.refreshable !== false
      const accs = Array.isArray(ch.accounts) ? ch.accounts : []
      // 能力实况：implemented=false ⇒ 登录换取尚未实现/渠道不可用，必须显示「暂不可用」+ reason
      const implemented = ch.implemented !== false
      const capabilityReason = ch.reason || (implemented ? '' : '该渠道登录换取尚未实现')

      const [open, setOpen] = react.useState(false)
      const [sess, setSess] = react.useState(null)          // /login/start 的会话
      const [pasteText, setPasteText] = react.useState('')
      const [ak, setAk] = react.useState('')
      const [sk, setSk] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [msg, setMsg] = react.useState(null)            // {ok,text,error}
      const [accMsg, setAccMsg] = react.useState(null)      // {key,ok,text}
      const [accBusy, setAccBusy] = react.useState(null)    // 'test:<key>' / 'refresh:<key>' / 'del:<id>'
      const [confirmDel, setConfirmDel] = react.useState(null)
      const [fallback, setFallback] = react.useState(false)
      const aliveRef = react.useRef(true)
      react.useEffect(() => () => { aliveRef.current = false }, [])

      /**
       * 🔴 弹窗拦截根因：window.open 必须在**用户点击的同一个 task** 里调用。
       * 在 Promise 回调里调会被浏览器判定「非用户手势」而拦截（用户看到「点了没反应」）。
       * ⇒ 点击时先同步开 about:blank，拿到 URL 后再改 location。
       */
      const preOpenWindow = () => {
        try {
          if (typeof window === 'undefined' || typeof window.open !== 'function') return null
          return window.open('about:blank', '_blank') || null
        } catch (_) { return null }
      }
      /** 直接打开 URL（只在用户手势里调用）；返回是否成功开出窗口 */
      const openUrl = (url) => {
        try {
          if (typeof window !== 'undefined' && typeof window.open === 'function') {
            return !!window.open(String(url), '_blank', 'noopener')
          }
        } catch (_) { /* 被拦截 */ }
        return false
      }
      /** 给已开的空白窗口导航；失败（被拦/已关闭）返回 false */
      const navigateWindow = (w, url) => {
        if (!w) return false
        try { w.location.href = String(url); return true } catch (_) {}
        try { w.location.replace(String(url)); return true } catch (_) {}
        return false
      }

      // ── 轮询：只在 waiting 时跑，1.5s 一次；到 ok/error/expired/cancelled 自动停 ──
      const sessStatus = sess && sess.status
      const sessId = sess && sess.sessionId
      const sessPolls = sess && sess.polls
      react.useEffect(() => {
        if (!sess || sess.status !== 'waiting' || !sess.sessionId) return
        let alive = true
        const timer = setTimeout(() => {
          if (!alive) return
          api('/login/poll?sessionId=' + encodeURIComponent(sess.sessionId))
            .then((r) => {
              if (!alive) return
              const code = String(r.state || (r.ok ? 'ok' : 'error'))
              const done = code === 'ok' || code === 'success'
              const failed = !done && (code === 'error' || code === 'expired' || code === 'cancelled')
              setSess((prev) => {
                if (!prev || prev.sessionId !== sess.sessionId) return prev
                return Object.assign({}, prev, {
                  status: done ? 'ok' : (failed ? 'error' : 'waiting'),
                  hint: r.hint || prev.hint,
                  maskedAccount: r.maskedAccount || prev.maskedAccount,
                  error: failed ? (r.error || r.hint || '登录失败') : null,
                  polls: (prev.polls || 0) + 1,
                })
              })
              if (done && props.onChanged) props.onChanged()
            })
            .catch((e) => {
              if (!alive) return
              setSess((prev) => (prev ? Object.assign({}, prev, { status: 'error', error: String((e && e.message) || e), polls: (prev.polls || 0) + 1 }) : prev))
            })
        }, LOGIN_POLL_MS)
        return () => { alive = false; clearTimeout(timer) }
      }, [sessStatus, sessId, sessPolls])

      /**
       * @param {Window|null|undefined} preOpened 点击时同步开出的空白窗口；
       *   undefined ⇒ 函数自己按 flow 同步开窗（必须仍在用户手势内）
       */
      const startLogin = (preOpened) => {
        // 同步开窗（在用户手势内）；flow 未知时也先开，paste/aksk 回来再关掉
        const win = preOpened === undefined ? ((flow === 'browser' || flow === 'device') ? preOpenWindow() : null) : preOpened
        setBusy(true); setMsg(null); setSess(null); setFallback(false)
        api('/login/start', { method: 'POST', body: JSON.stringify({ provider: ch.id }) })
          .then((r) => {
            if (!r.ok) {
              try { if (win && win.close) win.close() } catch (_) {}
              setMsg({ ok: false, error: r.error || '发起登录失败，可点「重试」或改用「粘贴凭据」' })
              setFallback(true)
              return
            }
            const f = r.flow || flow
            const manual = f === 'paste' || f === 'aksk'
            const next = {
              sessionId: r.sessionId,
              flow: f,
              url: r.url || null,
              qr: r.qr || null,
              shortLink: r.shortLink || null,
              userCode: r.userCode || null,
              verificationUri: r.verificationUri || null,
              interval: Number(r.interval) > 0 ? Number(r.interval) : 5,
              instructions: Array.isArray(r.instructions) ? r.instructions : [],
              loginVerified: r.loginVerified,
              loginNote: r.loginNote,
              pollingOnly: r.pollingOnly === true,
              popup: 'pending',           // pending | opened | blocked | not-needed
              status: manual ? 'manual' : 'waiting',
              hint: '',
              maskedAccount: null,
              error: null,
              polls: 0,
            }
            // 响应回来：给预开窗口导航（这才是真正的用户手势窗口，不会被拦）
            // device 流可能是「有授权页 URL」（qoder）或「只有设备码」两种形态
            const navUrl = (!manual && next.url) ? next.url : ''
            const deviceUrl = (!manual && next.flow === 'device' && !next.url) ? next.verificationUri : ''
            if (navUrl) {
              if (navigateWindow(win, navUrl)) next.popup = 'opened'
              else {
                // 没预开成功（浏览器拦截）⇒ 页面里必须有可点的「打开登录页」按钮 + 明确提示
                next.popup = 'blocked'
                setMsg({ ok: false, error: '浏览器拦截了新窗口，请点下面的「打开登录页」继续。' })
              }
            } else if (deviceUrl) {
              // 真设备码：没有 url，验证页作为辅助入口
              try { if (win && win.close) win.close() } catch (_) {}
              next.popup = 'not-needed'
            } else {
              // qr / 都没有：不需要新窗口，关掉空白页
              try { if (win && win.close) win.close() } catch (_) {}
              next.popup = 'not-needed'
            }
            if (!manual && !next.url && !next.qr && !next.userCode) setFallback(true)
            setSess(next)
          })
          .catch((e) => {
            try { if (win && win.close) win.close() } catch (_) {}
            setMsg({ ok: false, error: String((e && e.message) || e) }); setFallback(true)
          })
          .then(() => setBusy(false))
      }

      const cancelLogin = () => {
        const sid = sess && sess.sessionId
        setSess(null)
        setMsg({ ok: true, text: '已取消登录' })
        if (!sid) return
        api('/login/cancel', { method: 'POST', body: JSON.stringify({ sessionId: sid }) }).catch(() => {})
      }

      const setAcc = (key, ok, text) => setAccMsg({ key, ok, text })

      const runTest = (payload, key) => {
        setAccBusy('test:' + key)
        setAccMsg(null)
        api('/login/test', { method: 'POST', body: JSON.stringify(payload) })
          .then((r) => {
            if (r.ok) setAcc(key, true, '✅ 连通 ' + (r.ms || 0) + 'ms · ' + (r.model || ''))
            else setAcc(key, false, '❌ ' + (r.error || '失败') + (r.kind ? '（' + r.kind + '）' : ''))
          })
          .catch((e) => setAcc(key, false, '❌ ' + String((e && e.message) || e)))
          .then(() => setAccBusy(null))
      }

      /**
       * 账号级真机验证（需求 #3）。
       * 与「测试」的区别：验证结果会**落盘**到账号（verifiedAt / verifyError），
       * 让徽标从此有据可依；测试只回一次结果、不留痕。
       */
      const runVerify = (payload, key) => {
        setAccBusy('verify:' + key)
        setAccMsg(null)
        api('/channels/verify', { method: 'POST', body: JSON.stringify(payload) })
          .then((r) => {
            if (r.ok) setAcc(key, true, '✅ ' + (r.note || '已验证') + ' · ' + (r.ms || 0) + 'ms')
            else if (r.kind === 'CHANNEL_BUSY') setAcc(key, false, '⏳ 并发已满，稍后再试（本次没有写验证结果）')
            else setAcc(key, false, '❌ ' + (r.error || '验证未通过') + (r.note ? ' · ' + r.note : ''))
            props.onChanged && props.onChanged()
          })
          .catch((e) => setAcc(key, false, '❌ ' + String((e && e.message) || e)))
          .then(() => setAccBusy(null))
      }

      const runRefresh = (payload, key) => {
        setAccBusy('refresh:' + key)
        setAccMsg(null)
        api('/login/refresh', { method: 'POST', body: JSON.stringify(payload) })
          .then((r) => {
            if (r.ok) {
              setAcc(key, true, '✅ ' + (r.note || '已续期') + (r.maskedAccount ? ' · ' + r.maskedAccount : ''))
              props.onChanged && props.onChanged()
            } else {
              setAcc(key, false, '❌ ' + (r.error || '续期失败') + (r.reloginRequired ? '（该渠道需人工重新登录）' : ''))
            }
          })
          .catch((e) => setAcc(key, false, '❌ ' + String((e && e.message) || e)))
          .then(() => setAccBusy(null))
      }

      const removeAccount = (id) => {
        setAccBusy('del:' + id)
        api('/accounts/remove', { method: 'POST', body: JSON.stringify({ id }) })
          .then((r) => {
            setConfirmDel(null)
            if (r.ok === false) {
              setAcc(id, false, '❌ ' + (r.error || '删除失败'))
              setMsg({ ok: false, error: '删除失败：' + (r.error || '未知原因') })
            } else {
              setAcc(id, true, '✅ 已删除')
              setMsg({ ok: true, text: '✅ 已删除该账号（剩余 ' + (r.remaining != null ? r.remaining : '?') + ' 个账号）' })
              props.onChanged && props.onChanged()
            }
          })
          .catch((e) => setAcc(id, false, '❌ ' + String((e && e.message) || e)))
          .then(() => setAccBusy(null))
      }

      // 粘贴凭据：先让后端判定（不回凭据原文），再提交**原始文本**由后端解析
      const savePaste = (text) => {
        const value = String(text == null ? pasteText : text).trim()
        if (!value) { setMsg({ ok: false, error: '先粘贴 API Key、回调链接或令牌' }); return }
        setBusy(true); setMsg(null)
        api('/channels/parse', { method: 'POST', body: JSON.stringify({ text: value }) })
          .then((p) => {
            if (!p.ok) {
              setMsg({ ok: false, error: p.error || '这段内容里没有可识别的凭据（普通网址不算）' })
              return null
            }
            setMsg({ ok: true, text: '识别成功：' + (p.preview || '（已识别）') + '，正在保存…' })
            return api('/channels/save', { method: 'POST', body: JSON.stringify({ provider: ch.id, text: value }) })
          })
          .then((r) => {
            if (!r) return
            if (!r.ok) { setMsg({ ok: false, error: r.error || '保存失败' }); return }
            setPasteText('')
            setMsg({ ok: true, text: (r.hint || '✅ 已保存') + '（模型会出现在「模型目录」页）' })
            props.onChanged && props.onChanged()
          })
          .catch((e) => setMsg({ ok: false, error: String((e && e.message) || e) }))
          .then(() => setBusy(false))
      }

      const saveAksk = () => {
        const a = ak.trim(), s = sk.trim()
        if (!a && !s) { setMsg({ ok: false, error: '先填 AK 和 SK' }); return }
        if (!a) { setMsg({ ok: false, error: '还差 AK' }); return }
        if (!s) { setMsg({ ok: false, error: '还差 SK' }); return }
        setBusy(true); setMsg(null)
        api('/channels/save', { method: 'POST', body: JSON.stringify({ provider: ch.id, ak: a, sk: s }) })
          .then((r) => {
            if (!r.ok) { setMsg({ ok: false, error: r.error || '保存失败' }); return }
            setAk(''); setSk('')
            setMsg({ ok: true, text: (r.hint || '✅ AK/SK 已保存') + '（永久有效；模型会出现在「模型目录」）' })
            props.onChanged && props.onChanged()
          })
          .catch((e) => setMsg({ ok: false, error: String((e && e.message) || e) }))
          .then(() => setBusy(false))
      }

      const onPaste = (e) => {
        let text = ''
        try { text = (e.clipboardData || window.clipboardData).getData('text') || '' } catch (_) { return }
        if (!text.trim()) return
        setPasteText(text)
        savePaste(text)     // 粘贴即识别并保存（普通网址会被后端明确拒绝）
      }

      const pasteBox = (hint) => h('div', null,
        h('div', { style: Object.assign({ marginBottom: '6px' }, S.dim) }, hint),
        h('input', {
          style: S.input,
          value: pasteText,
          placeholder: '在这里按 Ctrl+V 粘贴' + (ch.field ? '（' + ch.field + '）' : '（API Key / 整段回调链接 / 令牌）'),
          onPaste: onPaste,
          onChange: (e) => setPasteText(e.target.value),
        }),
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
          h('button', { style: S.btn(true), onClick: () => savePaste(), disabled: busy || !pasteText.trim() }, busy ? '保存中…' : '保存'),
          h('button', { style: S.btn(false), onClick: () => { setPasteText(''); setMsg(null) } }, '清空')))

      const akskBox = () => h('div', null,
        h('div', { style: Object.assign({ marginBottom: '6px' }, S.dim) },
          '在官网控制台「访问密钥 / API 密钥」创建一对，粘贴到下面两个框。配一次永久有效，不用再登录。'),
        h('input', { style: Object.assign({}, S.input, { marginBottom: '6px' }), value: ak, placeholder: 'AK（Access Key / AccessKeyId）', onChange: (e) => setAk(e.target.value) }),
        h('input', { style: S.input, value: sk, placeholder: 'SK（Secret Key / AccessKeySecret）', onChange: (e) => setSk(e.target.value) }),
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
          h('button', { style: S.btn(true), onClick: saveAksk, disabled: busy }, busy ? '保存中…' : '保存 AK/SK'),
          h('button', { style: S.btn(false), onClick: () => { setAk(''); setSk(''); setMsg(null) } }, '清空')))

      // 会话向导（browser / device / qr 三种）
      // 信息层级：① 主操作大按钮 → ② 状态行 → ③ 次要操作（取消/重试/厂商官网）
      const renderSession = () => {
        const stt = sess.status
        const blocked = sess.popup === 'blocked'
        const deviceHasUrl = sess.flow === 'device' && !!sess.url
        const statusText =
          stt === 'waiting'
            ? (sess.flow === 'qr'
                ? '等待扫码确认…（已查 ' + (sess.polls || 0) + ' 次）'
                : (sess.pollingOnly || deviceHasUrl)
                  ? '已打开登录页，等待你在浏览器完成授权…（纯轮询，已查 ' + (sess.polls || 0) + ' 次）'
                  : sess.flow === 'device' && sess.userCode
                    ? '已打开验证页，等待你输入设备码确认…（已查 ' + (sess.polls || 0) + ' 次）'
                    : '等待你在浏览器完成授权…（已轮询 ' + (sess.polls || 0) + ' 次）')
            : stt === 'ok' ? '✅ 登录成功' + (sess.maskedAccount ? '：' + sess.maskedAccount : '')
              : stt === 'error' ? '❌ ' + (sess.error || '登录失败') : ''
        const statusStyle = Object.assign({}, S.dim,
          stt === 'ok' ? S.good : stt === 'error' ? S.bad : null,
          stt === 'waiting' && sess.flow === 'qr' ? { textAlign: 'center' } : null)

        const openSessionUrl = () => {
          // device 流：有 url 用 url；没有 url 才退回 verificationUri
          const url = (sess.flow === 'device' && sess.url) ? sess.url
            : (sess.flow === 'device' ? sess.verificationUri : sess.url)
          if (!url) return
          if (!openUrl(url)) setMsg({ ok: false, error: '浏览器拦截了新窗口。请允许本页弹窗后重试，或手动复制链接打开。' })
        }

        // device 流三种形态：有授权页 url / 有设备码 userCode / 都没有（诚实提示）
        const deviceView = sess.flow === 'device'
          ? (sess.url
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', width: '100%' } },
                  h('div', { style: S.dim }, '本渠道是浏览器授权 + 纯轮询（没有设备码）：点「① 打开登录页」完成授权，回到本页自动完成。'),
                  h('div', { style: Object.assign({}, S.dim, { wordBreak: 'break-all', opacity: 0.55, fontSize: '11px' }) }, sess.url))
              : sess.userCode
                ? h('div', null,
                    h('div', { style: S.bigCode }, sess.userCode),
                    sess.verificationUri
                      ? h('div', { style: Object.assign({ marginTop: '6px' }, S.dim) }, '打开验证页后输入上面的设备码；本页自动轮询结果。')
                      : h('div', { style: Object.assign({ marginTop: '6px' }, S.dim, S.warn) }, '后端没有返回验证页地址（verificationUri 为空），可手动在厂商官网输入设备码。'))
                : h('div', { style: Object.assign({}, S.dim, S.warn) },
                    '后端未返回登录地址（既没有 url 也没有设备码）⇒ 可用下方「粘贴凭据」备用方式。'))
          : null

        const bigBtn = (sess.flow === 'browser' && sess.url)
          ? h('button', { style: S.primaryBtn, onClick: openSessionUrl }, '① 打开登录页')
          : (sess.flow === 'device' && sess.url)
            ? h('button', { style: S.primaryBtn, onClick: openSessionUrl }, '① 打开登录页')
            : (sess.flow === 'device' && sess.verificationUri)
              ? h('button', { style: S.primaryBtn, onClick: openSessionUrl }, '① 打开验证页')
              : null

        const qrView = sess.flow === 'qr'
          ? (sess.qr
              ? h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', width: '100%' } },
                  h(QrCode, { text: String(sess.qr), size: 200 }),
                  h('div', { style: { fontWeight: 600, fontSize: '13px' } }, '用手机微信扫码'),
                  sess.shortLink ? h('div', { style: S.secondaryLink, onClick: () => openUrl(sess.shortLink) }, sess.shortLink) : null,
                  h('span', {
                    style: S.secondaryLink,
                    onClick: () => { copyPlainText(String(sess.qr)).then((r) => setMsg({ ok: r.ok, text: r.text })) },
                  }, '复制二维码内容'))
              : h('div', { style: Object.assign({}, S.dim, S.warn) },
                  '后端没有返回二维码内容（该渠道登录端点可能未取证）⇒ 可用下方「粘贴凭据」备用方式'))
          : null

        return h('div', { style: S.wizard },
          // ① 主操作
          bigBtn,
          // device：三种形态（url / 设备码 / 都没有）
          deviceView,
          // 二维码（大图居中）
          qrView,
          // ② 状态行
          statusText ? h('div', { style: statusStyle }, statusText) : null,
          blocked
            ? h('div', { style: Object.assign({}, S.dim, S.warn) },
                '⚠️ 浏览器拦截了新窗口，请点上面的「打开登录页」；或允许本页弹窗后点「重试」。')
            : null,
          // ③ 次要操作
          stt === 'ok' ? h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' } },
            h('button', { style: S.primaryBtn, onClick: () => runTest({ provider: ch.id }, 'provider'), disabled: accBusy === 'test:provider' }, accBusy === 'test:provider' ? '测试中…' : '立即测试连通'),
            h('span', { style: S.secondaryLink, onClick: () => setSess(null) }, '完成')) : null,
          stt === 'waiting' ? h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center' } },
            h('span', { style: S.secondaryLink, onClick: cancelLogin }, '取消登录'),
            ch.loginUrl ? h('span', { style: S.secondaryLink, onClick: () => openUrl(ch.loginUrl) }, '或在浏览器打开厂商页面') : null) : null,
          stt === 'error' ? h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center' } },
            h('button', { style: S.primaryBtn, onClick: () => startLogin((flow === 'browser' || flow === 'device') ? preOpenWindow() : null) }, '重试'),
            h('span', { style: S.secondaryLink, onClick: () => setSess(null) }, '关闭')) : null,
          // 登录指引（最后，不抢注意力）
          (sess.instructions || []).length
            ? h('div', { style: Object.assign({ marginTop: '2px' }, S.dim) },
                (sess.instructions || []).map((x, i2) => h('div', { key: i2 }, (i2 + 1) + '. ' + x)))
            : null,
          accMsg && accMsg.key === 'provider'
            ? h('div', { style: Object.assign({}, S.dim, accMsg.ok ? S.good : S.warn) }, accMsg.text)
            : null)
      }

      const wizard = () => {
        if (sess) {
          // 后端可能把 paste/aksk 也回成会话（manual）：这类没有可轮询的东西，直接给表单
          if (sess.flow === 'paste') return pasteBox('把 API Key / 回调链接 / 令牌粘贴到这里（后端会识别并保存）。')
          if (sess.flow === 'aksk') return akskBox()
          return h('div', null,
            renderSession(),
            (flow !== 'paste' && flow !== 'aksk' && (fallback || sess.status === 'error'))
              ? h('div', { style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid rgba(128,128,128,0.2)' } },
                  h('div', { style: Object.assign({ fontWeight: 600, marginBottom: '6px' }, S.dim) }, '备用：直接粘贴凭据 / 回调链接'),
                  pasteBox('如果一键登录拿不到授权，可从浏览器地址栏复制带 ?code= 的链接，或渠道的 API Key 粘贴到这里。'))
              : null)
        }
        if (flow === 'paste') {
          return h('div', { style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid rgba(128,128,128,0.2)' } },
            pasteBox('官方只提供 API Key。粘贴后立刻校验并保存（支持整段回调链接自动识别）。'))
        }
        if (flow === 'aksk') {
          return h('div', { style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid rgba(128,128,128,0.2)' } },
            akskBox())
        }
        // browser / device / qr：一键开始（自动打开 + 自动轮询）
        return h('div', { style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid rgba(128,128,128,0.2)' } },
          h('div', { style: Object.assign({ marginBottom: '8px' }, S.dim) }, flowMeta(flow).tip),
          (ch.guideSteps || []).length
            ? h('div', { style: Object.assign({ marginBottom: '8px' }, S.dim) },
                (ch.guideSteps || []).map((x, i) => h('div', { key: i }, (i + 1) + '. ' + x)))
            : null,
          h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' } },
            h('button', {
              style: S.primaryBtn,
              // 🔴 同步开窗：必须在点击的同一个 task 里（否则 Promise 回调里会被弹窗拦截）
              onClick: () => startLogin((flow === 'browser' || flow === 'device') ? preOpenWindow() : null),
              disabled: busy,
            }, busy ? '发起中…' : '一键登录'),
            h('span', { style: S.secondaryLink, onClick: () => setFallback(!fallback) }, fallback ? '收起粘贴框' : '拿不到授权？直接粘贴'),
            ch.loginUrl ? h('span', { style: S.secondaryLink, onClick: () => openUrl(ch.loginUrl) }, '厂商官网') : null),
          fallback
            ? h('div', { style: { marginTop: '10px' } },
                h('div', { style: Object.assign({ fontWeight: 600, marginBottom: '6px' }, S.dim) }, '备用：直接粘贴凭据'),
                pasteBox('从浏览器地址栏复制带 ?code= 的整段链接，或渠道的 API Key 粘贴到这里。'))
            : null)
      }

      const msgView = msg
        ? h('div', { style: Object.assign({ marginTop: '8px' }, S.dim, msg.ok ? S.good : S.warn) }, msg.text || msg.error)
        : null

      return h('div', {
        'data-channel': ch.id,
        'data-flow': flow,
        'data-verified': verified ? '1' : '0',
        'data-implemented': implemented ? '1' : '0',
        style: Object.assign({}, S.card, { marginBottom: '8px', maxWidth: '100%', boxSizing: 'border-box' }),
      },
        // 卡片头：左=渠道名+状态徽标（最多 2 个）；右=主按钮「一键登录」+ 小号「厂商官网」次链接
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '8px' } },
          h('div', { style: { minWidth: 0, flex: '1 1 220px' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
              h('span', { style: { fontWeight: 600, fontSize: '13px' } }, ch.label || ch.id),
              ch.loggedIn
                ? h(Badge, { kind: 'good' }, '已登录 ' + accs.length)
                : h(Badge, { kind: 'dim' }, '未登录'),
              implemented
                ? (verified
                    ? h(Badge, { kind: 'good', title: loginNote }, '已验证')
                    : h(Badge, { kind: 'warn', title: loginNote || '该渠道登录端点尚未真机验证' }, '未验证'))
                : h(Badge, { kind: 'warn', title: capabilityReason }, '暂不可用')),
            h('div', { style: Object.assign({ marginTop: '4px', wordBreak: 'break-all' }, S.dim) },
              flowLabelOf(flow, sess)
              + (ch.checkin ? ' · 可签到' : '')
              + (ch.proxyRequired ? ' · 需代理' : '')
              + (implemented
                  ? (loginNote ? ' · ' + loginNote : '')
                  : ' · ' + (capabilityReason || '登录换取尚未实现')))),
          h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
            h('span', {
              style: open ? S.btn(false) : S.primaryBtn,
              title: implemented ? '' : ('暂不可用：' + capabilityReason + '（仍可尝试，失败会如实提示）'),
              onClick: () => {
                const nextOpen = !open
                // 收起时若还有等待中的会话，顺手取消（避免后端会话占着 5 分钟）
                if (!nextOpen && sess && sess.status === 'waiting' && sess.sessionId) {
                  api('/login/cancel', { method: 'POST', body: JSON.stringify({ sessionId: sess.sessionId }) }).catch(() => {})
                }
                setOpen(nextOpen); setMsg(null); setAccMsg(null); setSess(null); setFallback(false)
                if (!nextOpen) return
                // 🔴 browser/device 流：在点击的同一个 task 里同步开空白窗口（否则 Promise 回调里会被拦截）
                if (flow === 'browser' || flow === 'device') startLogin(preOpenWindow())
                else if (flow !== 'paste' && flow !== 'aksk') startLogin(null)   // qr 不需要新窗口
              },
            }, open ? '收起' : (ch.loggedIn ? '再加一个' : '一键登录')),
            ch.loginUrl
              ? h('a', { href: ch.loginUrl, target: '_blank', rel: 'noreferrer', style: S.secondaryLink }, '厂商官网')
              : null)),

        accs.map((a) => {
          const key = a.id
          // ── 账号级真机验证（需求 #3）：时间戳是**真跑通过**的证据，不是二值 flag ──
          const verifiedAt = Number.isFinite(a.verifiedAt) ? a.verifiedAt : null
          const vErr = typeof a.verifyError === 'string' && a.verifyError ? a.verifyError : null
          return h('div', { key, style: Object.assign({}, S.row, { marginTop: '6px', flexWrap: 'wrap', gap: '6px' }) },
            h('span', { style: { minWidth: 0, wordBreak: 'break-all', flex: '1 1 180px' } },
              (a.label || ch.label) + '  ' + (a.masked || ''),
              a.kind ? h('span', { style: Object.assign({ marginLeft: '6px' }, S.dim) }, '· ' + a.kind) : null,
              // 徽标三态：已验证（绿，带日期）/ 未验证（黄）/ 过期（红，需重登）
              a.expired === true
                ? h('span', { style: Object.assign({ marginLeft: '6px' }, S.badge('warn')) }, '凭据已过期，需重新登录')
                : (verifiedAt
                    ? h('span', { style: Object.assign({ marginLeft: '6px' }, S.badge('good')) }, '已验证 ' + fmtDate(verifiedAt))
                    : h('span', { style: Object.assign({ marginLeft: '6px' }, S.badge('warn')) }, '未验证')),
              (vErr && !a.expired)
                ? h('span', { style: Object.assign({ marginLeft: '6px' }, S.dim, S.warn), title: vErr }, '上次验证失败：' + String(vErr).slice(0, 40))
                : null),
            h('span', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' } },
              h('span', {
                style: S.btn(false),
                title: '用真实最小推理验一次，通过后记下时间（不通过会如实记原因）',
                onClick: () => runVerify({ id: key }, key),
              }, accBusy === 'verify:' + key ? '验证中…' : '验证'),
              h('span', { style: S.btn(false), onClick: () => runTest({ id: key }, key) }, accBusy === 'test:' + key ? '测试中…' : '测试'),
              h('span', {
                style: Object.assign({}, S.btn(false), refreshable ? null : { opacity: 0.6 }),
                title: refreshable ? '用 refresh_token 续期' : '该渠道无续期端点，需重新登录',
                onClick: () => runRefresh({ id: key }, key),
              }, accBusy === 'refresh:' + key ? '续期中…' : '续期'),
              confirmDel === key
                ? h('span', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
                    h('span', { style: Object.assign({}, S.btn(false), S.bad), onClick: () => removeAccount(key) }, accBusy === 'del:' + key ? '删除中…' : '确认删除'),
                    h('span', { style: S.btn(false), onClick: () => setConfirmDel(null) }, '取消'))
                : h('span', { style: Object.assign({ cursor: 'pointer', fontSize: '12px', padding: '3px 6px' }, S.dim, S.bad), onClick: () => setConfirmDel(key) }, '删除')),
            accMsg && accMsg.key === key
              ? h('div', { style: Object.assign({ width: '100%', marginTop: '4px', wordBreak: 'break-all' }, S.dim, accMsg.ok ? S.good : S.warn) }, accMsg.text)
              : null)
        }),

        open ? wizard() : null,
        // 结果消息不受展开状态影响：删除/测试/续期在收起态也要有反馈
        msgView,
        open ? h('div', { style: Object.assign({ marginTop: '8px' }, S.dim) },
          '🔒 凭证只存在本机 ~/.dsh/cs-myfree/accounts.json（0600），不上传任何服务器；页面只显示掩码。') : null,
      )
    }

    // ── W1 供给源 ──
    function SourcesZone() {
      const [s, reload] = useApi('/state')
      const [cs, reloadCh] = useApi('/channels')
      const [ls, reloadLs] = useApi('/login/status')
      const [probing, setProbing] = react.useState(false)
      const [probe, setProbe] = react.useState(null)
      const [bulk, setBulk] = react.useState(null)
      // 模型搜索探测（一键串行三步）：结果 + 关键词过滤（纯前端本地过滤）
      const [scan, setScan] = react.useState(null)
      const [scanning, setScanning] = react.useState(false)
      const [scanStep, setScanStep] = react.useState('')   // 正在跑第几步（按钮上显示进度）
      const [scanQ, setScanQ] = react.useState('')
      const aliveRef = react.useRef(true)
      react.useEffect(() => () => { aliveRef.current = false }, [])

      const d = s.data
      const chData = cs.data
      const statusList = ls.data && Array.isArray(ls.data.channels) ? ls.data.channels : []
      const statusById = {}
      for (const x of statusList) statusById[x.id] = x
      const channels = chData && Array.isArray(chData.channels) ? chData.channels : []
      const loggedChannels = channels.filter((c) => c.loggedIn)
      const verifiedCount = statusList.filter((x) => x.loginVerified === true).length

      const runProbe = () => {
        setProbing(true)
        api('/probe', { method: 'POST', body: JSON.stringify({}) })
          .then((r) => setProbe(r))
          .catch((e) => setProbe({ ok: false, error: String((e && e.message) || e) }))
          .then(() => { setProbing(false); reload() })
      }

      // ── 模型搜索探测（一键串行三步）────────────────────────────────────────
      // 串行而不是并发：/probe 会发**真实推理请求**，/channels/models 会**真打渠道端点**，
      // 一起打会把上游打爆（也可能互相抢限流桶）。
      //   a) POST /probe            免密源真实探测（每个源的 ms / error）
      //   b) POST /channels/models  拉取渠道模型（远端优先，失败回落内置并如实标来源）
      //   c) GET /models + /channels/models 聚合（模型名 / 来源 / 状态）
      const runModelScan = () => {
        setScanning(true)
        setScan(null)
        setScanStep('① 探测免密源')
        ;(async () => {
          const steps = []
          const out = { ok: false, at: Date.now(), probe: null, models: null, channels: null, steps, error: null }
          // stage 只用于「失败时告诉用户卡在哪一步」（可读错误 > 一句 HTTP 500）
          let stage = '① 免密源探测'
          try {
            const p = await api('/probe', { method: 'POST', body: JSON.stringify({}) })
            out.probe = p
            steps.push('① 免密源探测：' + (p.anyOk ? (p.okCount + '/' + (p.results || []).length + ' 可用') : '全部不可用'))
            if (aliveRef.current) { stage = '② 渠道模型拉取'; setScanStep('② 渠道模型拉取') }
            const cmPost = await api('/channels/models', { method: 'POST', body: JSON.stringify({}) })
            steps.push('② 渠道模型拉取：' + (cmPost.total ?? 0) + ' 个模型')
            if (aliveRef.current) { stage = '③ 聚合结果'; setScanStep('③ 聚合结果') }
            const m = await api('/models')
            const cm = await api('/channels/models')
            out.models = m
            out.channels = cm
            steps.push('③ 聚合：免密源 ' + ((m.sources || []).length) + ' 个平台 + 渠道模型 ' + ((cm.models || []).length) + ' 条')
            out.ok = true
          } catch (e) {
            out.error = String((e && e.message) || e)
            steps.push('✗ 中断于 ' + stage + '：' + out.error)
          }
          if (!aliveRef.current) return
          setScan(out)
          setScanning(false)
          setScanStep('')
          if (out.ok) reload()
        })()
      }

      /**
       * 把 probe / models / channels.models 拼成「按平台分组」的行。
       * 来源字段原样透传（remote / builtin / builtin-after-http-error / builtin-empty-remote / none）
       * ——不猜、不改写；`ok` 单独给出布尔值，供「共 K 个可用」汇总与 S.warn 高亮使用。
       */
      const scanGroups = (sc) => {
        if (!sc) return []
        const groups = []
        const probed = {}
        for (const r of (sc.probe && sc.probe.results) || []) probed[r.id] = r
        const dm = (sc.models && sc.models.defaultModels) || {}
        // ① 免密源平台（单独一组）：状态 = 真实探测的 ms / error
        for (const src of (sc.models && sc.models.sources) || []) {
          const pid = src.probeId || src.id
          const p = probed[pid]
          const model = dm[pid] || dm[src.id] || ''
          const ok = p ? p.ok === true : null
          groups.push({
            id: 'keyless:' + pid,
            platform: src.label || pid,
            kind: 'keyless',
            note: p ? null : '未探测（本次 probe 没有该源结果）',
            rows: model
              ? [{
                  model,
                  source: 'builtin',
                  ok,
                  status: p ? (p.ok ? (p.ms != null ? p.ms + 'ms' : '可用') : (p.error || '失败')) : '未探测',
                }]
              : [],
          })
        }
        // ② 渠道平台：模型清单 + 拉取来源（失败原因如实显示在平台行与状态列）
        const byChannel = {}
        for (const m of (sc.channels && sc.channels.models) || []) {
          const cid = m.channelId || m.id || '?'
          if (!byChannel[cid]) byChannel[cid] = []
          byChannel[cid].push(m)
        }
        const meta = (sc.channels && sc.channels.byChannel) || {}
        for (const [cid, list] of Object.entries(byChannel)) {
          const mt = meta[cid] || {}
          const fetchOk = mt.ok !== false
          groups.push({
            id: 'channel:' + cid,
            platform: cid,
            kind: 'channel',
            note: fetchOk ? null : '拉取失败：' + (mt.error || '未知原因'),
            rows: list.map((m) => ({
              model: m.modelId || m.id || m.name,
              source: m.source || mt.source || '—',
              ok: fetchOk,
              status: fetchOk ? '可用' : (mt.error || '失败'),
            })),
          })
        }
        // ③ 拉了但一个模型都没回来的渠道（多半是失败）也要露出来，否则「失败」无从看见
        for (const [cid, mt] of Object.entries(meta)) {
          if (byChannel[cid]) continue
          groups.push({
            id: 'channel:' + cid,
            platform: cid,
            kind: 'channel',
            note: mt && mt.ok === false ? '拉取失败：' + (mt.error || '未知原因') : '（该渠道没有返回模型）',
            rows: [],
          })
        }
        return groups
      }

      /** 关键词过滤（平台名 / 模型名，纯前端；空关键词 = 不过滤） */
      const scanFiltered = (groups) => {
        const kw = String(scanQ || '').trim().toLowerCase()
        if (!kw) return groups
        const out = []
        for (const g of groups) {
          const platformHit = String(g.platform).toLowerCase().includes(kw)
          const rows = (g.rows || []).filter((r) => String(r.model).toLowerCase().includes(kw))
          if (platformHit || rows.length) {
            // 平台名命中 ⇒ 保留该平台全部模型；只有模型名命中 ⇒ 只留命中的模型
            out.push(Object.assign({}, g, { rows: rows.length ? rows : (g.rows || []) }))
          }
        }
        return out
      }

      // 全部测试 / 全部续期：逐个账号操作（串行，避免把宿主/上游打爆）
      const bulkTargets = (kind) => {
        const out = []
        for (const c of loggedChannels) {
          for (const a of (c.accounts || [])) {
            const st = statusById[c.id] || {}
            out.push({
              provider: c.id, id: a.id, label: c.label, masked: a.masked,
              skip: kind === 'refresh' && st.refreshable === false,
              skipNote: '该渠道无续期端点，需重新登录',
            })
          }
        }
        return out
      }
      const runBulk = (kind) => {
        const targets = bulkTargets(kind)
        if (!targets.length) {
          setBulk({ kind, total: 0, done: 0, results: [], finished: true })
          return
        }
        setBulk({ kind, total: targets.length, done: 0, results: [], finished: false })
        ;(async () => {
          for (const t of targets) {
            if (!aliveRef.current) return
            let r
            if (t.skip) {
              r = { ok: false, error: t.skipNote }
            } else {
              try {
                r = await api(kind === 'test' ? '/login/test' : '/login/refresh', { method: 'POST', body: JSON.stringify({ id: t.id, provider: t.provider }) })
              } catch (e) {
                r = { ok: false, error: String((e && e.message) || e) }
              }
            }
            if (!aliveRef.current) return
            setBulk((prev) => {
              if (!prev) return prev
              const done = (prev.done || 0) + 1
              return Object.assign({}, prev, {
                done,
                finished: done >= prev.total,
                results: prev.results.concat([{
                  provider: t.provider, label: t.label, masked: t.masked,
                  ok: r.ok === true, ms: r.ms, error: r.error || null, note: r.note || null,
                }]),
              })
            })
          }
          if (aliveRef.current) { reloadCh(); reloadLs() }
        })()
      }

      if (s.error) return h('div', null, h(Err, { error: s.error }), h('button', { style: S.btn(false), onClick: reload }, '重试'))
      if (!d) return h('div', { style: S.card }, h('div', { style: S.skeleton }), h('div', { style: S.skeleton }), h('div', { style: S.skeleton }))

      const bulkRunning = bulk && !bulk.finished
      return h('div', null,
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '10px' } },
          h('button', { style: S.btn(true), onClick: runProbe, disabled: probing }, probing ? '探测中…（真实请求）' : '探测免密源'),
          h('span', { style: S.dim }, '会发起真实推理请求，约 2–20 秒'),
          h('button', { style: S.btn(false), onClick: () => runBulk('test'), disabled: bulkRunning, title: '对每个已登录账号发一条最小推理请求' },
            '全部测试' + (bulk && bulk.kind === 'test' && !bulk.finished ? ' ' + bulk.done + '/' + bulk.total : '')),
          h('button', { style: S.btn(false), onClick: () => runBulk('refresh'), disabled: bulkRunning, title: '对每个已登录账号续期（无续期端点的会如实标出）' },
            '全部续期' + (bulk && bulk.kind === 'refresh' && !bulk.finished ? ' ' + bulk.done + '/' + bulk.total : '')),
          h('button', { style: S.btn(false), onClick: runModelScan, disabled: scanning, title: '串行三步：真实探测免密源 → 拉取渠道模型 → 聚合 /models + /channels/models' },
            scanning ? ('模型搜索探测中…' + (scanStep ? ' ' + scanStep : '')) : '模型搜索探测'),
          h('input', {
            style: Object.assign({}, S.input, { width: '190px' }),
            placeholder: '按平台 / 模型名过滤',
            value: scanQ,
            onChange: (e) => setScanQ(e.target.value),
          })),

        probe ? h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } },
            probe.ok ? (probe.anyOk ? '✅ 探测完成' : '❌ 全部不可用') : '❌ 探测失败'),
          (probe.results || []).map((r) => h('div', { key: r.id, style: S.row },
            h('span', null, (r.ok ? '✅ ' : '❌ ') + r.id),
            h('span', { style: Object.assign({ textAlign: 'right' }, S.dim) }, r.ok ? (r.ms + 'ms  "' + String(r.sample || '').slice(0, 30) + '"') : (r.error || '失败')))),
          probe.error ? h('div', { style: Object.assign({ marginTop: '6px' }, S.mono, S.bad) }, probe.error) : null) : null,

        bulk ? h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } },
            (bulk.kind === 'test' ? '全部测试' : '全部续期') + (bulk.finished ? '完成' : '进行中… ') + '（' + bulk.done + '/' + bulk.total + '）'),
          bulk.total === 0 ? h('div', { style: S.dim }, '还没有已登录的账号 ⇒ 先在下面登录一个渠道') : null,
          (bulk.results || []).map((r, i) => h('div', { key: i, style: S.row },
            h('span', { style: { minWidth: 0, wordBreak: 'break-all' } }, (r.ok ? '✅ ' : '❌ ') + r.label + ' ' + (r.masked || '')),
            h('span', { style: Object.assign({ textAlign: 'right' }, S.dim, r.ok ? null : S.warn) },
              r.ok ? ((r.ms || 0) + 'ms' + (r.note ? ' · ' + r.note : '')) : (r.error || '失败')))),
          (bulk.results || []).some((r) => r.ok === false)
            ? h('div', { style: Object.assign({ marginTop: '6px' }, S.dim, S.warn) }, '有失败项：先看行内错误；「未验证」渠道的端点可能未取证，登录器修好后重试。')
            : null) : null,

        // ── 模型搜索探测结果（按平台分组：模型 | 来源 | 状态）──
        scan ? (() => {
          const all = scanGroups(scan)
          const groups = scanFiltered(all)
          // 总览口径：平台数 / 模型数 / 其中「可用」的模型数（ok===true 才算可用，未探测不计）
          const tally = (list) => {
            let models = 0
            let usable = 0
            for (const g of list) {
              for (const r of (g.rows || [])) {
                models++
                if (r.ok === true) usable++
              }
            }
            return { platforms: list.length, models, usable }
          }
          const cur = tally(groups)
          const whole = tally(all)
          const kw = String(scanQ || '').trim()
          const summary = '共 ' + cur.platforms + ' 个平台 / ' + cur.models + ' 个模型 / 其中 ' + cur.usable + ' 个可用'
            + (kw
              ? '（已按「' + kw + '」过滤；全部 ' + whole.platforms + ' 个平台 / ' + whole.models + ' 个模型 / ' + whole.usable + ' 个可用）'
              : '')
          const totalRows = cur.models
          // 表头用 S.dim 小字（本文件全是 flex ⇒ 手写「表格」，不用 <table>）
          const head = h('div', { style: { display: 'flex', gap: '8px', padding: '3px 0', borderBottom: '1px solid rgba(128,128,128,0.35)' } },
            h('span', { style: Object.assign({ flex: '1 1 220px' }, S.dim) }, '模型'),
            h('span', { style: Object.assign({ width: '150px', flexShrink: 0 }, S.dim) }, '来源'),
            h('span', { style: Object.assign({ width: '130px', flexShrink: 0, textAlign: 'right' }, S.dim) }, '状态'))
          const groupNodes = groups.map((g) => {
            const rowNodes = (g.rows || []).map((r, i) => h('div', {
              key: i,
              style: { display: 'flex', gap: '8px', padding: '2px 0 2px 10px', borderBottom: '1px solid rgba(128,128,128,0.10)' },
            },
              h('span', { style: Object.assign({ flex: '1 1 220px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, S.mono) }, r.model),
              h('span', { style: { width: '150px', flexShrink: 0, fontSize: '11px', opacity: 0.8 } }, r.source),
              // 状态：可用=正常色；失败= S.warn 高亮并显示后端 error 原文；未探测=暗色
              h('span', {
                style: Object.assign(
                  { width: '130px', flexShrink: 0, textAlign: 'right', fontSize: '11px' },
                  r.ok === true ? { opacity: 0.8 } : (r.ok === false ? S.warn : { opacity: 0.6 }),
                ),
              }, r.status)))
            return h('div', { key: g.id, style: { marginTop: '8px' } },
              h('div', { style: { fontWeight: 600, fontSize: '12px' } }, g.platform,
                h('span', { style: Object.assign({ marginLeft: '8px' }, S.dim) },
                  (g.rows || []).length + ' 个模型' + (g.kind === 'keyless' ? '（免密源）' : ''))),
              g.note ? h('div', { style: Object.assign({ marginTop: '2px' }, S.dim, S.warn) }, '· ' + g.note) : null,
              rowNodes)
          })
          return h('div', { style: S.card },
            h('div', { style: { fontWeight: 600, marginBottom: '4px' } },
              scan.ok ? '✅ 模型搜索探测完成' : '❌ 模型搜索探测失败'),
            h('div', { style: { marginBottom: '4px', fontWeight: 600, fontSize: '12px' } }, summary),
            (scan.steps || []).map((t, i) => h('div', { key: i, style: S.dim }, t)),
            scan.error ? h('div', { style: Object.assign({ marginTop: '4px' }, S.mono, S.bad) }, scan.error) : null,
            scan.ok && totalRows === 0
              ? h('div', { style: Object.assign({ marginTop: '6px' }, S.dim, S.warn) },
                  kw ? '没有匹配「' + kw + '」的平台或模型（清空过滤词看全部）' : '（没有拿到任何模型：先登录一个渠道，或看上面三步的状态）')
              : null,
            groups.length ? h('div', { style: { marginTop: '6px' } }, head, groupNodes) : null)
        })() : null,

        h('div', { style: { fontWeight: 600, margin: '4px 0 8px' } }, '免密源（无需登录）'),
        h('div', { style: S.grid }, (d.sources.keyless || []).map((k) => h('div', { key: k.id, style: S.tile },
          h('div', { style: { fontWeight: 600 } }, k.label),
          h('div', { style: S.dim }, k.note || '')))),

        h('div', { style: { fontWeight: 600, margin: '16px 0 4px' } },
          '账号渠道（' + (chData ? chData.total : d.sources.counts.channels) + ' 家 · 已登录 ' + loggedChannels.length + ' 家' +
          (statusList.length ? ' · 已验证 ' + verifiedCount + '/' + statusList.length : '') + '）'),
        h('div', { style: Object.assign({ marginBottom: '10px' }, S.dim) },
          '「一键登录」按各渠道流程自动完成；未验证 = 后端登录端点尚未真机验证，可能失败，请以实际结果为准。凭证只存本机。'),
        cs.error ? h(Err, { error: '渠道列表读取失败：' + cs.error }) : null,
        ls.error ? h(Err, { error: '登录状态读取失败：' + ls.error }) : null,
        (!chData && !cs.error)
          ? h('div', null, h('div', { style: S.skeleton }), h('div', { style: S.skeleton }), h('div', { style: S.skeleton }))
          : channels.map((c) => h(ChannelCard, {
              key: c.id, channel: c, status: statusById[c.id] || null,
              onChanged: () => { reloadCh(); reload(); reloadLs() },
            })),

        // design/21 §1：额度健康并入供给源（复用旧 HealthZone 渲染，不删源码）
        h('div', { style: { marginTop: '16px', borderTop: '1px solid rgba(128,128,128,0.18)', paddingTop: '12px' } },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '额度与签到'),
          h(HealthZone)),
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

    // ── W3 降级链编辑器（下拉选择版，不要求手输 provider/model）──
    function ChainZone() {
      const [s, reload] = useApi('/chain')
      const [cat, reloadCat] = useApi('/chain/catalog')
      const [draft, setDraft] = react.useState([])
      const [msg, setMsg] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      // 每行的「跨平台模型搜索」关键词（空 = 只看所选平台的模型）。
      // 用 ChainZone 级别的 map（row 不是组件，不能在里面放 hook）。
      // 🔴 key 用「行身份 = provider+model」，不用行号：删/移一行后行号会整体错位，
      //    关键词若按行号存就会串到别人的行上；身份一变（选了别的模型）关键词自然失效，
      //    正好回到「只列该平台模型」的常规状态。
      const [mq, setMq] = react.useState({})
      const mqKey = (e) => String(e.provider || '') + '\u0000' + String(e.model || '')

      react.useEffect(() => {
        if (!s.data) return
        const ov = Array.isArray(s.data.overrides) ? s.data.overrides.slice() : []
        const builtin = Array.isArray(s.data.builtin) ? s.data.builtin : []
        const key = (e) => e.provider + '\u0000' + e.model
        const ovKeys = new Set(ov.map(key))
        // 🔴 内置链里「没有被覆盖、也没有被禁用」的条目也要显示成行 ——
        //    否则用户看不到 kilo/ovh，自然「无法删除」（用户实测反馈）。
        const builtinRows = builtin
          .filter((e) => e && e.provider && e.model && !ovKeys.has(key(e)))
          .map((e) => ({ provider: e.provider, model: e.model, tier: e.tier ?? 1, _fromBuiltin: true }))
        setDraft(ov.concat(builtinRows))
      }, [s.data])

      if (s.error) return h(Err, { error: s.error })
      if (!s.data) return h(Loading, { on: s.loading })
      const d = s.data
      const sources = (cat.data && Array.isArray(cat.data.sources)) ? cat.data.sources : []
      const byProvider = {}
      for (const src of sources) byProvider[src.provider] = src
      const providerOpts = sources.map((src) => ({
        value: src.provider,
        label: src.label + (src.kind === 'channel-unlogged' ? '（未登录）' : src.kind === 'keyless' ? '（免密）' : ''),
      }))

      /** 取某 provider 的可选模型 */
      const modelsOf = (provider) => {
        const src = byProvider[provider]
        return src && Array.isArray(src.models) ? src.models : []
      }

      /**
       * 跨平台模型关键词匹配 ⇒ [{provider, model, platformLabel, label}]。
       * 为什么需要：用户常常只记得模型名、不记得它在哪家平台；「平台 + 模型」两层分立后
       * 逐层点太慢，所以给一个只看模型名的搜索口，命中就把模型下拉换成跨平台清单。
       * ⚠️ 提交给后端的仍然是 { provider, model } 两项（chain-overrides 存储格式不变）。
       */
      const crossMatches = (kw) => {
        const k = String(kw || '').trim().toLowerCase()
        if (!k) return []
        const out = []
        for (const src of sources) {
          for (const m of (Array.isArray(src.models) ? src.models : [])) {
            const id = String(m.id || '')
            const name = String(m.name || id)
            if (!id.toLowerCase().includes(k) && !name.toLowerCase().includes(k)) continue
            out.push({ provider: src.provider, model: m.id, platformLabel: src.label || src.provider, label: name })
            if (out.length >= 60) return out   // 防御：极端关键词别把下拉撑爆
          }
        }
        return out
      }

      const set = (i, k, v) => setDraft((arr) => arr.map((e, j) => {
        if (j !== i) return e
        const next = Object.assign({}, e, { [k]: v })
        // 换 provider ⇒ 自动选该 provider 的第一个模型
        if (k === 'provider') {
          const ms = modelsOf(v)
          next.model = ms.length > 0 ? ms[0].id : ''
        }
        return next
      }))
      const del = (i) => setDraft((arr) => arr.filter((_, j) => j !== i))
      /** 成对设置平台 + 模型（跨平台选择时用：两者必须同源，不能拆开设） */
      const setPair = (i, provider, model) => setDraft((arr) => arr.map((e, j) => (
        j === i ? Object.assign({}, e, { provider, model }) : e
      )))
      const add = () => setDraft((arr) => {
        const first = sources[0]
        if (!first) return arr.concat([{ provider: '', model: '', tier: 1 }])
        return arr.concat([{ provider: first.provider, model: (first.models[0] || {}).id || '', tier: 1 }])
      })
      const move = (i, dir) => setDraft((arr) => {
        const j = i + dir
        if (j < 0 || j >= arr.length) return arr
        const c = arr.slice(); const t = c[i]; c[i] = c[j]; c[j] = t; return c
      })
      const save = () => {
        setBusy(true); setMsg(null)
        // 组装 payload：
        //  · disabled 条目 ⇒ { provider, model, disabled:true }（剔除规则）
        //  · 普通条目     ⇒ { provider, model, tier }
        //  · 原本来自内置链、但用户把这行删掉 ⇒ 也要写 disabled（否则内置条目会回来）
        const builtin = Array.isArray(d.builtin) ? d.builtin : []
        const builtinKeys = new Set(builtin.map((e) => e.provider + '\u0000' + e.model))
        const draftKeys = new Set(draft.filter((e) => e.provider && e.model).map((e) => e.provider + '\u0000' + e.model))
        const payload = draft.filter((e) => e.provider && e.model).map((e) => (
          e.disabled ? { provider: e.provider, model: e.model, disabled: true }
            : { provider: e.provider, model: e.model, tier: e.tier }
        ))
        for (const b of builtin) {
          const k = b.provider + '\u0000' + b.model
          if (builtinKeys.has(k) && !draftKeys.has(k)) {
            payload.push({ provider: b.provider, model: b.model, disabled: true })
          }
        }
        api('/chain', { method: 'POST', body: JSON.stringify({ chain: payload }) })
          .then((r) => { setMsg(r); reload() })
          .catch((e) => setMsg({ ok: false, errors: [String((e && e.message) || e)] }))
          .then(() => setBusy(false))
      }

      /** 这条是否来自内置链（内置条目只能「禁用」，不能物理删除） */
      const isBuiltinEntry = (e) => {
        const builtin = Array.isArray(d.builtin) ? d.builtin : []
        return builtin.some((b) => b.provider === e.provider && b.model === e.model)
      }

      /** 一行：provider 下拉 + model 下拉 + tier 下拉 + 上移/下移/删除 */
      const row = (e, i) => {
        const ms = modelsOf(e.provider)
        const modelMissing = e.model && !ms.some((m) => m.id === e.model)
        // 跨平台搜索：有关键词 ⇒ 模型下拉展开为「平台 / 模型」的跨平台匹配结果
        const kw = String(mq[mqKey(e)] || '')
        const cross = crossMatches(kw)
        const sep = '\u0000'
        const curVal = e.provider + sep + e.model
        /** 模型下拉的可选项：跨平台命中优先，否则只列所选平台的模型 */
        const modelOpts = cross.length
          ? [h('option', { key: '__cur', value: curVal }, '当前：' + e.provider + ' / ' + e.model)]
              .concat(cross.map((c) => h('option', { key: c.provider + sep + c.model, value: c.provider + sep + c.model },
                c.platformLabel + ' / ' + (c.label && c.label !== c.model ? (c.label + '（' + c.model + '）') : c.model))))
          : [].concat(
              modelMissing ? [h('option', { key: '__missing', value: e.model }, e.model + '（清单里没有，可能是旧值）')] : [],
              ms.map((m) => h('option', { key: m.id, value: m.id }, m.name && m.name !== m.id ? (m.name + ' · ' + m.id) : m.id)))
        return h('div', { key: i, style: Object.assign({}, S.tile, {
          marginBottom: '6px', display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap',
          ...(e.disabled ? { opacity: 0.6 } : {}),
        }) },
          h('span', { style: Object.assign({}, S.mono, S.dim) }, '#' + (i + 1)),
          // ① 平台下拉（独立一层：只决定"在哪家平台上找"）
          h('select', {
            style: Object.assign({}, S.input, { flex: '1 1 150px', minWidth: '120px' }),
            value: e.provider,
            onChange: (ev) => set(i, 'provider', ev.target.value),
            title: '平台（渠道 / 免密源）',
          }, providerOpts.map((o) => h('option', { key: o.value, value: o.value }, o.label))),
          // ② 跨平台模型搜索（只按模型名过滤；命中后 ③ 变成跨平台清单）
          h('input', {
            style: Object.assign({}, S.input, { flex: '0 1 130px', minWidth: '100px' }),
            value: kw,
            placeholder: '跨平台搜模型',
            title: '输入模型关键词（如 qwen）：模型下拉会展开为所有平台的匹配结果',
            onChange: (ev) => setMq((prev) => Object.assign({}, prev, { [mqKey(e)]: ev.target.value })),
          }),
          // ③ 模型下拉（关键词为空 ⇒ 只列所选平台的模型；有命中 ⇒ 跨平台清单）
          h('select', {
            style: Object.assign({}, S.input, { flex: '1 1 200px', minWidth: '150px' }),
            value: cross.length ? curVal : e.model,
            onChange: (ev) => {
              const v = String(ev.target.value || '')
              if (v.indexOf(sep) >= 0) {
                // 跨平台选择：平台与模型必须同源，一次性成对写入（保存时仍只提交 {provider, model}）
                const parts = v.split(sep)
                setPair(i, parts[0], parts[1])
              } else {
                set(i, 'model', v)
              }
            },
            title: cross.length
              ? '跨平台匹配 ' + cross.length + ' 个：选中会同时切换平台'
              : '该平台可用的模型（左侧输入关键词可跨平台搜索）',
          }, modelOpts),
          cross.length
            ? h('span', { style: Object.assign({}, S.dim) }, '跨平台命中 ' + cross.length)
            : (kw.trim()
                ? h('span', { style: Object.assign({}, S.dim, S.warn) }, '跨平台无匹配（模型下拉仍是本平台的清单）')
                : null),
          h('select', {
            style: Object.assign({}, S.input, { width: '78px' }),
            value: String(e.tier || 1),
            onChange: (ev) => set(i, 'tier', Number(ev.target.value) || 1),
            title: '优先级：tier 越小越先尝试',
          }, [1, 2, 3, 4, 5].map((t) => h('option', { key: t, value: String(t) }, 'T' + t))),
          h('span', {
            style: S.btn(false), title: '设为首选：本条 tier=1，其余全部 +1',
            onClick: () => setDraft((arr) => arr.map((x, j) => (j === i
              ? Object.assign({}, x, { tier: 1 })
              : Object.assign({}, x, { tier: Math.max(1, (Number(x.tier) || 1) + (Number(x.tier || 1) === 1 ? 1 : 0)) })))),
          }, '设为首选'),
          // 已移除的条目：给个「恢复」入口（取消 disabled 规则）
          e.disabled
            ? h('span', {
                style: S.btn(false),
                title: '恢复这条（取消移除规则）',
                onClick: () => setDraft((arr) => arr.map((x, j) => {
                  if (j !== i) return x
                  const n = Object.assign({}, x)
                  delete n.disabled
                  return n
                })),
              }, '恢复')
            : null,
          h('span', { style: S.btn(false), onClick: () => move(i, -1), title: '上移' }, '↑'),
          h('span', { style: S.btn(false), onClick: () => move(i, 1), title: '下移' }, '↓'),
          h('span', {
            style: S.btn(false),
            onClick: () => del(i),
            title: isBuiltinEntry(e) ? '从链里移除（内置条目会记为「禁用」）' : '删除这条覆盖',
          }, '✕'))
      }

      return h('div', null,
        h('div', { style: S.card },
          h(KV, { k: '内置链', v: (Array.isArray(d.builtin) ? d.builtin.length : 0) + ' 条' }),
          h(KV, { k: '覆盖层', v: (Array.isArray(d.overrides) ? d.overrides : []).length + ' 条' }),
          h(KV, { k: '生效链', v: (Array.isArray(d.effective) ? d.effective : []).length + ' 条' }),
          h(KV, { k: '生效链来源', v: '内置 ' + (Array.isArray(d.builtin) ? d.builtin.length : 0) + ' + 覆盖 ' + (Array.isArray(d.overrides) ? d.overrides : []).length + ' ⇒ 合并 ' + (Array.isArray(d.effective) ? d.effective.length : 0) + ' 条' }),
          (d.tiers || []).length ? h('div', { style: Object.assign({ marginTop: '8px' }, S.dim) },
            d.tiers.map((t) => 'T' + t.tier + ':' + t.count).join('  ')) : null,
          d.applied === true
            ? h('div', { style: Object.assign({ marginTop: '6px' }, S.dim, S.good) }, '✅ 页面这份链 = 运行时实际选路（同源）')
            : d.applied === false
              ? h('div', { style: Object.assign({ marginTop: '6px' }, S.dim, S.warn) }, '⚠️ 页面这份链与运行时不一致：保存后需重启插件/宿主才生效')
              : h('div', { style: Object.assign({ marginTop: '6px' }, S.dim) }, '（后端未报告该链是否已应用到运行时）')),

        h('div', { style: { fontWeight: 600, margin: '14px 0 8px' } }, '降级链配置（平台与模型分两层 + 跨平台搜索）'),
        h('div', { style: S.dim }, 'T1 最先尝试，失败后依次降级。同 provider+model ⇒ 替换内置条目的 tier；新的 ⇒ 追加。留空的条目保存时会被忽略。'),
        h('div', { style: S.dim }, '每行三个控件：① 平台下拉（只决定在哪家平台找）② 跨平台搜索框（只输模型关键词）③ 模型下拉（默认只列该平台的模型；搜索有命中时展开为「平台 / 模型」，选中会同时切换平台）。保存提交的仍是 { 平台, 模型 }。'),

        cat.error ? h('div', { style: Object.assign({}, S.dim, S.warn) }, '可选项加载失败：' + cat.error + '（仍可保存已有配置）') : null,
        draft.length === 0 ? h('div', { style: Object.assign({ margin: '10px 0' }, S.dim) }, '（空 —— 保存后完全使用内置链）') : null,
        draft.map(row),

        h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
          h('button', { style: S.btn(false), onClick: add, disabled: sources.length === 0 }, '+ 加一条'),
          h('button', { style: S.btn(false), onClick: () => reloadCat() }, '刷新可选项'),
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
      const [ck, reloadCk] = useApi('/checkin/status')
      const [cr, reloadCr] = useApi('/credits')
      const [running, setRunning] = react.useState(false)
      const [runMsg, setRunMsg] = react.useState(null)

      const runCheckin = () => {
        setRunning(true); setRunMsg(null)
        api('/checkin/run', { method: 'POST', body: JSON.stringify({}) })
          .then((r) => setRunMsg(r))
          .catch((e) => setRunMsg({ ok: false, error: String((e && e.message) || e) }))
          .then(() => { setRunning(false); reloadCk(); reloadCr() })
      }
      const fmtTime = (ts) => {
        try { return ts ? new Date(ts).toLocaleString() : '—' } catch { return '—' }
      }
      const reloadAll = () => { reload(); reloadCk(); reloadCr() }

      const d = s.data
      const st = ck.data
      const credits = cr.data && Array.isArray(cr.data.providers) ? cr.data.providers : []
      const KIND_LABEL = {
        'claimed': '领取成功', 'already-claimed': '今天已领过', 'inactive': '账号不活跃',
        'unsupported': '该渠道不支持自动签到', 'failed': '失败',
      }
      const KIND_COLOR = (kind) => (kind === 'claimed' ? S.good : kind === 'already-claimed' ? S.dim : kind === 'unsupported' ? S.dim : S.warn)

      return h('div', null,
        (s.error && !d) ? h(Err, { error: '状态接口读取失败：' + s.error }) : null,
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '自动签到 / 领积分'),
          ck.error
            ? h(Err, { error: '签到状态读取失败：' + ck.error })
            : !st
              ? h('div', { style: S.dim }, '加载签到状态…')
              : h('div', null,
                  h(KV, { k: '自动签到', v: st.enabled ? '✅ 已开启（每天 ' + (st.at_time || '10:05') + '）' : '⛔ 已关闭（手动「立即签到」仍可用）' }),
                  h(KV, { k: '定时器', v: st.alive ? '✅ 运行中' : '❌ 未运行（开关改完仍无效 ⇒ 看诊断页）' }),
                  h(KV, { k: '下次运行', v: fmtTime(st.nextAt), dim: true }),
                  h(KV, { k: '上次运行', v: st.lastAt ? fmtTime(st.lastAt) + (st.lastResult ? ' · ' + String(st.lastResult) : '') : '还没跑过', dim: true }),
                  st.pending ? h(KV, { k: '欠账', v: st.pending + ' 天未领', dim: true }) : null,
                  st.lastError ? h('div', { style: Object.assign({ marginTop: '6px' }, S.dim, S.warn) }, '上次错误：' + st.lastError) : null,
                  (st.channels || []).length
                    ? h('div', { style: Object.assign({ marginTop: '8px' }, S.dim) },
                        st.channels.map((c, i) => h('div', { key: c.provider + i },
                          '· ' + c.provider + '：' + (c.text || KIND_LABEL[c.kind] || c.kind || '') + (c.gain ? '（+' + (c.gain.amount ?? c.gain) + '）' : ''))))
                    : null,
                  h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
                    h('button', { style: S.btn(true), onClick: runCheckin, disabled: running }, running ? '签到中…（真实请求）' : '立即签到（全部渠道）'),
                    h('button', { style: S.btn(false), onClick: () => { reloadCk(); reloadCr() } }, '刷新状态'))),
          runMsg
            ? h('div', { style: Object.assign({}, S.card, { marginTop: '8px', borderColor: runMsg.ok ? 'rgba(64,160,96,0.5)' : 'rgba(200,80,80,0.5)' }) },
                h('div', { style: { fontWeight: 600 } }, runMsg.ok
                  ? (runMsg.summary
                    ? '✅ 签到完成：领取 ' + runMsg.summary.claimed + ' · 已领过 ' + runMsg.summary.alreadyClaimed + ' · 不支持 ' + runMsg.summary.unsupported + ' · 失败 ' + runMsg.summary.failed + (runMsg.takesMs != null ? '（' + runMsg.takesMs + 'ms）' : '')
                    : '✅ 签到完成' + (runMsg.takesMs != null ? '（' + runMsg.takesMs + 'ms）' : ''))
                  : '❌ 签到失败'),
                runMsg.text ? h('div', { style: Object.assign({ marginTop: '4px' }, S.dim) }, runMsg.text) : null,
                (runMsg.results || []).map((r, i) => h('div', { key: (r.provider || 'x') + i, style: S.row },
                  h('span', null, '· ' + (r.provider || '?')),
                  h('span', { style: Object.assign({ textAlign: 'right' }, S.dim, KIND_COLOR(r.kind)) },
                    (KIND_LABEL[r.kind] || r.kind || '') + (r.gain && (r.gain.amount ?? r.gain) ? ' +' + (r.gain.amount ?? r.gain) : '') + (r.message ? ' · ' + r.message : '') + (r.ms != null ? '（' + r.ms + 'ms）' : '')))),
                runMsg.error ? h('div', { style: Object.assign({ marginTop: '6px' }, S.mono, S.bad) }, runMsg.error) : null)
            : null),

        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '积分 / 余额（按渠道）'),
          cr.error
            ? h(Err, { error: '积分读取失败：' + cr.error })
            : credits.length === 0
              ? h('div', { style: S.dim }, '暂无已登录渠道的积分数据（登录后会自动查询）')
              : credits.map((p, i) => h('div', { key: p.provider + i, style: S.row },
                  h('span', null, (p.ok ? '✅ ' : '❌ ') + (p.provider || '?')),
                  h('span', { style: Object.assign({ textAlign: 'right', marginLeft: '12px' }, S.dim, p.ok ? null : S.warn) },
                    p.ok
                      ? ((p.total != null ? String(p.total) : '—') + ' ' + (p.unit || ''))
                      : ('未实现/未登录：' + (p.error || '未知原因')))))),

        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, '签到 / 续期开关（保存后立即生效）'),
          h(ConfigEditor, {
            defaults: { checkin: { enabled: true, at: '10:05' }, refresh: { enabled: true } },
            fields: [
              { path: ['checkin', 'enabled'], label: '自动签到（每日领积分）', type: 'bool', hint: '关 = 不再自动领；手动「立即签到」仍可用' },
              { path: ['checkin', 'at'], label: '每天几点签到（HH:MM）', type: 'text', hint: '默认 10:05（避开渠道 10:00 的积分刷新）' },
              { path: ['refresh', 'enabled'], label: '自动续期（到期前刷新）', type: 'bool', hint: '用 refresh_token 在 expires_at 前 5 分钟续期' },
            ],
            onSaved: () => { reloadCk(); reloadCr() },
          })),

        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '免密源状态'),
          d && d.probe
            ? h('div', null,
                h(KV, { k: '最近探测', v: new Date(d.probe.at).toLocaleString() }),
                h(KV, { k: '可用', v: d.probe.okCount + ' 个（只探测默认优先源 Kilo/OVH）' + (d.probe.anyOk ? ' ✅' : ' ❌') }))
            : h('div', { style: S.dim }, '尚未探测 ⇒ 去「供给源」点探测')),

        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '渠道签到期与续期'),
          h('div', { style: Object.assign({}, S.dim, { marginBottom: '6px' }) }, (d && d.checkin && d.checkin.note) || '签到由渠道层执行；本页展示自动签到结果'),
          h(KV, { k: '可签到渠道', v: (d && d.checkin && Array.isArray(d.checkin.supported)) ? (d.checkin.supported.join(', ') || '无') : '未知' }),
          h(KV, { k: '需人工重登', v: (d && d.sources && d.sources.counts ? d.sources.counts.manualRefresh : '?') + ' 家（见供给源）', dim: true }),
          h(KV, { k: '需代理', v: (d && d.sources && d.sources.counts ? d.sources.counts.proxyRequired : '?') + ' 家', dim: true })),

        h('button', { style: S.btn(false), onClick: reloadAll }, '刷新'),
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
      const getDefault = (path) => path.reduce((o, k) => (o == null ? undefined : o[k]), props.defaults || {})
      const val = (path) => {
        const v = path.reduce((o, k) => (o == null ? undefined : o[k]), cfg)
        return v === undefined ? getDefault(path) : v
      }

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
                  onClick: () => setPath(f.path, !(val(f.path) === true)),
                  style: {
                    fontWeight: 600, cursor: 'pointer', userSelect: 'none',
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
      // 契约 A3/A4：切换成功口径与 /state 的 routing.switches 同源。
      // 取数优先级：/ledger 顶层 switches → spend.switches（两种后端形状都吃得下，前端不做假设）。
      const switches = d.switches || (d.spend && d.spend.switches) || null
      const swRate = switches && switches.switchSuccessRate != null ? switches.switchSuccessRate + '%' : null
      const swText = switches
        ? (Number(switches.total) || 0) + ' 次' + (swRate ? '（成功率 ' + swRate + '）' : '')
        : '—（账本未返回切换口径）'

      return h('div', null,
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '花费汇总'),
          h(KV, { k: '今日花费', v: '¥' + (sum.todayCNY ?? 0) }),
          h(KV, { k: '本月花费', v: '¥' + (sum.monthCNY ?? 0) }),
          h(KV, { k: '今日调用', v: String(sum.todayCalls ?? 0) }),
          h(KV, { k: '累计调用', v: String(sum.totalCalls ?? 0) }),
          h(KV, { k: '付费调用', v: String(sum.paidCalls ?? 0) + (sum.costUnknown ? '（' + sum.costUnknown + ' 条价格未知）' : '') }),
          h(KV, { k: '切换成功', v: swText }),
          h(KV, { k: '数据源', v: d.spend && d.spend.ok ? d.spend.file : '未读到 spend.jsonl', dim: true })),

        spendDays.length ? h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '最近调用（按天）'),
          spendDays.slice(0, 7).map((x) => h('div', { key: x.date, style: S.row },
            h('span', null, x.date),
            h('span', { style: S.dim }, x.calls + ' 次  ¥' + x.costCNY + '  in ' + x.in + ' / out ' + x.out)))) : null,

        // 渠道 × 模型统计：手写 flex「表格」（不用 <table>）。**不加花费列**：
        // costCNY 恒 0 是既有缺陷（见 adapter 单价表口径），摆出来只会误导。
        providers.length ? h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '2px' } }, '渠道 × 模型统计'),
          h('div', { style: Object.assign({ marginBottom: '6px' }, S.dim) },
            '切换成功 = 该行「换过候选才成功」的调用数；token 列 = 输入 / 输出。子行是该渠道下调用最多的 3 个模型。'),
          spendRow({ head: true }, ['渠道 / 模型', '切换成功', '调用', '失败', 'token(in/out)']),
          providers.slice(0, 8).map((x) => {
            const models = Object.entries(x.models || {})
            const chFailed = Number(x.failed) || 0
            return h('div', { key: x.provider },
              spendRow({}, [
                x.provider,
                String(x.switched ?? 0),
                String(x.calls ?? 0),
                { text: String(chFailed), warn: chFailed > 0 },
                (x.in ?? 0) + ' / ' + (x.out ?? 0),
              ]),
              models.slice(0, 3).map(([mid, m]) => {
                const mFailed = Number(m.failed) || 0
                return spendRow({ indent: true, dim: true }, [
                  '└ ' + mid,
                  String(m.switched ?? 0),
                  String(m.calls ?? 0),
                  { text: String(mFailed), warn: mFailed > 0 },
                  (m.in ?? 0) + ' / ' + (m.out ?? 0),
                ])
              }),
              models.length > 3
                ? h('div', { style: Object.assign({ paddingLeft: '16px', paddingBottom: '2px' }, S.dim) },
                    '（另有 ' + (models.length - 3) + ' 个模型未显示）')
                : null)
          })) : null,

        // 🔴 中断/失败统计（用户要求「页面能看到中断次数与报错」）
        (() => {
          const f = d.failures || (d.spend && d.spend.failures) || null
          if (!f) return null
          const codeEntries = Object.entries(f.byCode || {})
          const provEntries = Object.entries(f.byProvider || {})
          const recent = f.recent || []
          const CODE_HINT = {
            AUTH: '凭据无效或未登录',
            RATE_LIMIT: '被限流（请求太频繁）',
            QUOTA: '额度用尽',
            TIMEOUT: '上游超时（网络慢或模型卡住）',
            TRANSPORT: '网络传输失败',
            SERVER: '上游 5xx',
            MODEL_NOT_FOUND: '模型名不存在',
            NOT_FOUND: '端点不存在',
            INVALID_REQUEST: '请求参数被上游拒绝',
            EMPTY_RESPONSE: '上游返回空内容',
            PERMISSION: '无权限/被风控',
            REGION_BLOCKED: '地区限制',
            UNKNOWN: '未能归类（需看原始报错）',
          }
          return h('div', { style: S.card },
            h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '中断 / 失败统计'),
            h(KV, { k: '总调用', v: String(f.callsTotal ?? 0) }),
            h(KV, { k: '失败次数', v: String(f.failTotal ?? 0) + '（' + (f.failRate ?? 0) + '%）' }),
            h(KV, { k: '失明率', v: (f.byCode && f.byCode.UNKNOWN ? ((f.byCode.UNKNOWN / Math.max(1, f.callsTotal)) * 100).toFixed(1) : '0.0') + '%（UNKNOWN 占比，越低越好）', dim: true }),
            codeEntries.length
              ? h('div', { style: { marginTop: '10px' } },
                h('div', { style: Object.assign({ fontWeight: 600 }, S.dim) }, '按失败类型'),
                codeEntries.map(([code, n]) => h('div', { key: code, style: S.row },
                  h('span', null, code + (CODE_HINT[code] ? ' · ' + CODE_HINT[code] : '')),
                  h('span', { style: Object.assign({}, S.dim, S.warn) }, String(n) + ' 次'))))
              : h('div', { style: Object.assign({ marginTop: '8px' }, S.dim, S.good) }, '✅ 没有失败记录'),
            provEntries.length
              ? h('div', { style: { marginTop: '10px' } },
                h('div', { style: Object.assign({ fontWeight: 600 }, S.dim) }, '按渠道'),
                provEntries.slice(0, 8).map(([p, n]) => h('div', { key: p, style: S.row },
                  h('span', null, p),
                  h('span', { style: Object.assign({}, S.dim, S.warn) }, String(n) + ' 次'))))
              : null,
            recent.length
              ? h('div', { style: { marginTop: '10px' } },
                h('div', { style: Object.assign({ fontWeight: 600 }, S.dim) }, '最近 20 条中断（时间 / 渠道 / 模型 / 原因）'),
                h('div', { style: S.pre },
                  recent.map((r) => {
                    const t = r.at ? new Date(r.at).toLocaleString('zh-CN', { hour12: false }) : '-'
                    return `${t}  ${r.provider || '-'}  ${r.model || '-'}  ${r.code || 'UNKNOWN'}`
                  }).join('\n')))
              : null)
        })(),

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

    // ═══════════════════════════════════════════════════════════════════════
    // W13 模型与费用设置（design/19 §2 — 人类视角三步走；默认入口 tab）
    // ═══════════════════════════════════════════════════════════════════════
    // 步骤1 作用域选择器（所有对话/这个工作区/这个对话/这个团队）
    // 步骤2 设置项（默认模型 / 允许付费 / 自动切换 / 预算 / 渠道可用清单）
    // 步骤3 实时状态（最近 5 次请求 / 火山方舟余额 / 高级折叠区）
    // 锁定态：层 owner=admin 且当前非 admin ⇒ 控件禁用 +「由管理员统一管理」
    // 保存成功提示「已保存，下次请求生效」；错误走中文文案（explainKind 口径）。
    const SETTINGS_LAYER_LABEL = { global: '全局', workspace: '工作区', session: '对话', team: '团队', preset: '预设' }
    const SETTINGS_SOURCE_ORDER = ['team', 'session', 'workspace', 'preset', 'global']
    const PRIORITY_OPTIONS = [
      { v: 'free-first', t: '先免费（省钱优先）' },
      { v: 'balanced', t: '均衡（免费 + 付费混用）' },
      { v: 'reliability-first', t: '稳定优先（多用付费）' },
    ]
    // 错误分类的中文文案（与后端 failure-map 的 explainKind 同口径；后端已给中文时优先用后端）
    const KIND_TEXT = {
      AUTH: '凭据无效或未登录', QUOTA: '额度用尽', RATE_LIMIT: '被限流（请求太频繁）',
      MODEL_NOT_FOUND: '模型名不存在', NOT_FOUND: '端点不存在', REGION_BLOCKED: '地区限制',
      PERMISSION: '无权限或被风控', INVALID_REQUEST: '请求参数被上游拒绝', TIMEOUT: '上游超时',
      TRANSPORT: '网络传输失败', SERVER: '上游服务器错误', EMPTY_RESPONSE: '上游返回空内容',
      UNKNOWN: '未能归类',
    }

    function getField(obj, path) {
      return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
    }
    function setField(obj, path, v) {
      const next = JSON.parse(JSON.stringify(obj || {}))
      const keys = String(path).split('.')
      let cur = next
      for (let i = 0; i < keys.length - 1; i++) {
        if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object' || Array.isArray(cur[keys[i]])) cur[keys[i]] = {}
        cur = cur[keys[i]]
      }
      cur[keys[keys.length - 1]] = v
      return next
    }
    /** 生成 patch：与层原值 diff；编辑层被清空的字段 ⇒ null（删除恢复继承） */
    function diffPatch(base, edited) {
      const out = {}
      for (const [k, v] of Object.entries(edited || {})) {
        const b = base && typeof base === 'object' ? base[k] : undefined
        if (v === null || v === undefined || v === '') {
          if (b !== undefined && b !== null && b !== '') out[k] = null
          continue
        }
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const sub = diffPatch(b && typeof b === 'object' && !Array.isArray(b) ? b : {}, v)
          if (Object.keys(sub).length > 0) out[k] = sub
        } else if (b !== v || (Array.isArray(v) && (!Array.isArray(b) || JSON.stringify(b) !== JSON.stringify(v)))) {
          out[k] = v
        }
      }
      return out
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 需求 #5：这一层跟全局哪里不一样（差异面板）
    //
    // 数据来源（真实字段名，见 src/web/settings.js `readSettings` 与 src/config/scope.js
    // `effectiveConfig`）：GET /settings →
    //   { layers: [{ scope, id, owner, setKeys, config }],          // 每层已存配置
    //     effective: { config, layers, byLayer: { global, preset, workspace, session, team } } }
    // 因此：
    //   「这一层的已存值」 = layers[scope=pick].config（与保存时算 patch 的 base 同一份）
    //   「全局值」         = effective.byLayer.global
    // 只列**这一层自己写过**且与全局不同的叶子路径；全局有、这层没有 = 正常继承，不算差异。
    // ═══════════════════════════════════════════════════════════════════════

    /** 展开成叶子路径（对象递归；数组整体当一个值，避免 `a.0.b` 这种点号歧义） */
    function flattenLeafPaths(obj, prefix = '', out = []) {
      if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
        if (prefix) out.push(prefix)
        return out
      }
      for (const [k, v] of Object.entries(obj)) {
        if (k === '_meta') continue                      // 权限元数据不是用户设置
        flattenLeafPaths(v, prefix ? prefix + '.' + k : k, out)
      }
      return out
    }

    /** 值是否相同（对象/数组按 JSON 比） */
    function sameValue(a, b) {
      if (Object.is(a, b)) return true
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        try { return JSON.stringify(a) === JSON.stringify(b) } catch (_) { return false }
      }
      return false
    }

    /**
     * 算「当前层 vs 全局层」的差异清单。
     * @param {object} scopeCfg 当前作用域的已存配置（layers[pick].config）
     * @param {object} globalCfg 全局层配置（effective.byLayer.global）
     * @param {(path:string)=>string} [sourceOf] 该路径的生效值来自哪一层（「来源层」列用）
     * @returns {Array<{path:string, globalValue:any, currentValue:any, source:string|null}>}
     */
    function diffAgainstGlobal(scopeCfg, globalCfg, sourceOf) {
      const out = []
      for (const path of flattenLeafPaths(scopeCfg || {}).sort()) {
        const cur = getField(scopeCfg, path)
        const glob = getField(globalCfg, path)
        if (sameValue(cur, glob)) continue
        out.push({
          path,
          globalValue: glob,
          currentValue: cur,
          source: typeof sourceOf === 'function' ? sourceOf(path) : null,
        })
      }
      return out
    }

    /** 差异值的展示文案（对象/数组折成一行；没有就说未设） */
    function diffValueText(v) {
      if (v === undefined) return '未设'
      if (v === null) return '未设（清空）'
      if (typeof v === 'string') return v === '' ? '（空）' : v
      if (typeof v === 'object') {
        try {
          const s = JSON.stringify(v)
          return s.length > 80 ? s.slice(0, 80) + '…' : s
        } catch (_) { return String(v) }
      }
      return String(v)
    }

    /** 返回「删掉某个叶子键之后」的新对象（不原地改，供编辑底稿用） */
    function dropField(obj, path) {
      const next = JSON.parse(JSON.stringify(obj || {}))
      const keys = String(path).split('.')
      let cur = next
      for (let i = 0; i < keys.length - 1; i++) {
        cur = cur == null ? null : cur[keys[i]]
        if (cur == null || typeof cur !== 'object') return next
      }
      if (cur && typeof cur === 'object') delete cur[keys[keys.length - 1]]
      return pruneEmptyObjects(next)
    }

    /** 清掉被删空的壳（与后端 applyPatch「递归后子对象被删空 ⇒ 一并删除」同口径） */
    function pruneEmptyObjects(obj) {
      for (const k of Object.keys(obj || {})) {
        const v = obj[k]
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          pruneEmptyObjects(v)
          if (Object.keys(v).length === 0) delete obj[k]
        }
      }
      return obj
    }

    /**
     * 删掉「某一层」的这个键 = 恢复全局（**不是**把全局值拷进这一层）。
     *
     * 契约形状：`PATCH /settings { scope, id?, patch: { <path>: null } }`
     * （后端 applyPatch 里 null 就是删除该键 ⇒ 该层重新继承上一层/全局）。
     * 兼容：旧后端只实现了 `POST /settings`（patch 里 null 同样是删除语义）⇒ 405/404 时降级 POST，
     *       免得新 UI 配旧后端时按钮直接报错装死。
     */
    function deleteLayerSetting(scope, id, path) {
      const body = { scope, patch: setField({}, path, null) }
      if (scope !== 'global' && id) body.id = id
      const send = (method) => api('/settings', { method, body: JSON.stringify(body) })
      return send('PATCH').catch((e) => {
        const m = String((e && e.message) || e)
        if (/HTTP 40[45]/.test(m) || /method not allowed|不支持.*方法/i.test(m)) return send('POST')
        throw e
      })
    }

    const DIFF_SCOPE_LABEL = { workspace: '工作区', session: '对话', team: '团队', preset: '预设' }

    /**
     * 「与全局不同（N 项）」面板（需求 #5）。放在工作区/对话作用域设置页顶部。
     * props: { scope, diffs, onRestore, busy, disabled }
     */
    function GlobalDiffPanel(props) {
      const diffs = Array.isArray(props.diffs) ? props.diffs : []
      const scopeText = DIFF_SCOPE_LABEL[props.scope] || props.scope || '这一层'
      const has = diffs.length > 0
      const off = props.disabled === true || props.busy === true
      return h('div', {
        style: Object.assign({}, S.card, {
          borderColor: has ? 'rgba(220,160,40,0.45)' : 'rgba(128,128,128,0.25)',
          background: has ? 'rgba(220,160,40,0.06)' : S.card.background,
        }),
        'data-diff-panel': props.scope || 'scope',
      },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } },
          has ? '与全局不同（' + diffs.length + ' 项）' : '与全局一致',
          h('span', { style: Object.assign({ marginLeft: '8px' }, S.dim) },
            '作用域：' + scopeText + '（只算已保存的改动）')),
        h('div', { style: Object.assign({}, S.dim, has ? { marginBottom: '8px' } : null) },
          has
            ? '这些项在这一层被改过，所以这个' + scopeText + '用的不是全局值。点「恢复全局」= 删掉这一层的该项、重新继承全局（不是把全局值拷进来）。'
            : '这一层还没有任何设置跟全局不同；没设的项一律继承全局。'),
        has ? h('div', null,
          h('div', { style: Object.assign({}, S.row, { fontWeight: 600 }) },
            h('span', { style: { flex: '1 1 34%' } }, '配置路径'),
            h('span', { style: { flex: '1 1 22%' } }, '全局值'),
            h('span', { style: { flex: '1 1 22%' } }, '当前值'),
            h('span', { style: { flex: '0 0 64px' } }, '来源层'),
            h('span', { style: { flex: '0 0 84px', textAlign: 'right' } }, '操作')),
          diffs.map((d) => h('div', {
            key: d.path, style: Object.assign({}, S.row, { alignItems: 'center', gap: '6px' }),
            'data-diff-path': d.path,
          },
            h('span', { style: Object.assign({ flex: '1 1 34%' }, S.mono) }, d.path),
            h('span', { style: { flex: '1 1 22%', opacity: 0.75, wordBreak: 'break-all' } }, diffValueText(d.globalValue)),
            h('span', { style: { flex: '1 1 22%', fontWeight: 600, wordBreak: 'break-all' } }, diffValueText(d.currentValue)),
            h('span', { style: { flex: '0 0 64px' } }, SETTINGS_LAYER_LABEL[d.source] || '全局'),
            h('span', { style: { flex: '0 0 84px', textAlign: 'right' } },
              h('button', {
                style: Object.assign({}, S.btn(false), off ? { opacity: 0.5, cursor: 'not-allowed' } : null),
                disabled: off,
                title: '删掉这一层对「' + d.path + '」的设置，重新用全局值',
                onClick: off ? undefined : () => { if (typeof props.onRestore === 'function') props.onRestore(d.path) },
                'data-diff-restore': d.path,
              }, props.busy ? '恢复中…' : '恢复全局')))))
        : null,
      )
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 需求 #6：模型选择器的可见性（白名单 + 渲染兜底）
    //
    // 用户口径：对话里选模型的列表只展示 deepseek 系 / 用户自加 API / 免费可用渠道 /
    // 华为云；其它渠道包不展示。
    // 分工：**默认隐藏集合以后端 `sources.hidden` 为准**（计划 §WP-B，不在 UI 写死渠道名），
    //       前端只做两件事：
    //         ① 渲染兜底：条目带 `hidden:true` 或 id 在 `sources.hidden` 里 ⇒ 不渲染；
    //         ② 后端给了来源分类（`kind`）时按白名单兜一层（渠道包非白名单 ⇒ 不展示）。
    // 条目来源未知（老后端没给 kind/flags）⇒ 不据此隐藏，交给后端 hidden 决定（零回归）。
    // ═══════════════════════════════════════════════════════════════════════

    /** 华为云渠道包（CodeArts / MaaS）——用户点名要求保留的选择器入口 */
    const HUAWEI_MODEL_PROVIDERS = new Set(['codearts', 'officeace', 'maas', 'huaweicloud'])

    /**
     * 该条目的**来源自身**是否被判为「不展示」（只含 hidden 口径，不含白名单）。
     * 与 `isModelSourceVisible` 分开，是因为页面要如实说明「有几个渠道是被『不展示』挡的」
     * —— 白名单挡掉的（qoder/loomy 这类渠道包）不属于「不展示」开关的范畴，混在一起就是撒谎。
     * @param {object} entry
     * @param {string[]} [hiddenList]
     * @returns {boolean}
     */
    function isModelSourceHidden(entry, hiddenList) {
      if (!entry || typeof entry !== 'object') return false
      const id = String(entry.provider || entry.id || entry.channelId || '')
      if (entry.hidden === true) return true
      if (Array.isArray(hiddenList) && hiddenList.includes(id)) return true
      // 别名归一：kilo-free ≡ kilo（后端写的是归一 id，目录里可能带旧别名）
      if (Array.isArray(hiddenList)) {
        const base = id.replace(/-free$|-vision$/, '')
        if (base !== id && hiddenList.includes(base)) return true
        if (base !== id && hiddenList.includes(id + '-free')) return true
      }
      return false
    }

    /**
     * 该模型来源是否允许出现在「选模型」列表里。
     * @param {object} entry 目录条目（/settings.models 分组 或 /routing/catalog 条目）
     * @param {string[]} [hiddenList] 生效配置里的 `sources.hidden`（用户「不展示」清单）
     * @returns {boolean}
     */
    function isModelSourceVisible(entry, hiddenList) {
      if (!entry || typeof entry !== 'object') return false
      const id = String(entry.provider || entry.id || entry.channelId || '')
      // ① 渲染兜底：后端已判定不展示 / 用户在设置里点过「不展示」⇒ 一律不渲染
      if (isModelSourceHidden(entry, hiddenList)) return false
      // ③ 白名单：deepseek 系 / 用户自加 API / 免费免密 / 华为云
      if (/^deepseek/i.test(id)) return true
      if (entry.userAdded === true || entry.kind === 'user-api' || entry.kind === 'custom') return true
      if (entry.kind === 'keyless') return true                       // 免密源 = 免费可用
      if (HUAWEI_MODEL_PROVIDERS.has(id)) return true
      const kind = String(entry.kind || '')
      if (/^channel/.test(kind)) {
        // 其它渠道包：只有明确「免费可用」才展示
        return entry.free === true || entry.billing === 'free' || entry.billingTier === 'free_only'
      }
      return true   // 来源未知（老后端没给 kind/flags）⇒ 不据此隐藏
    }

    /** 从一张模型分组清单里挑出可展示的（保持原顺序） */
    function visibleModelSources(list, hiddenList) {
      return (Array.isArray(list) ? list : []).filter((e) => isModelSourceVisible(e, hiddenList))
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 设置页新增卡片（联网搜索 / 识图 / 子智能体路由 / 火山方舟）
    //
    // 共同形态：卡片本身**不提交**，只把改动写进 SettingsPage 的编辑底稿（fset），
    // 保存统一由页面底部「保存这一层」按钮走 POST /settings（patch 语义：只写改动字段）。
    // 这样「作用域 / 管理员锁定 / diffPatch 只发差异」三件事只存在一处，不会各处漂移。
    // ═══════════════════════════════════════════════════════════════════════

    /** 联网搜索可选源（id 必须与后端 PARSERS 完全一致，写错后端会回「未知搜索源」） */
    const SEARCH_SOURCE_OPTIONS = [
      { id: 'bing-rss', t: 'Bing RSS' },
      { id: 'bing-html', t: 'Bing 网页' },
      { id: 'sogou', t: '搜狗' },
      { id: 'mwmbl', t: 'Mwmbl' },
    ]

    /**
     * 「联网搜索」卡片（字段路径 search.*）。
     * 右下角「测试搜索」直接打 POST /search/run（真联网、真打源站），
     * 因此把**每个源**的 ok/耗时/条数/错误都摊开显示——用户才能判断「是我配错了，还是这家源挂了」。
     */
    function SearchSettingsCard(props) {
      const fv = props.fv
      const fset = props.fset
      const off = props.disabled === true
      const [q, setQ] = react.useState('')
      const [res, setRes] = react.useState(null)
      const [busy, setBusy] = react.useState(false)

      const enabled = fv('search.enabled') !== false
      const picked = Array.isArray(fv('search.sources')) ? fv('search.sources') : []
      const toggleSource = (id, on) => {
        const next = picked.filter((x) => x !== id)
        if (on) next.push(id)
        fset('search.sources', next)
      }
      /** 源 id ⇒ 中文源名（后端新增的未知 id 原样显示，不做猜测，也不显示成空白） */
      const sourceLabel = (id) => {
        const hit = SEARCH_SOURCE_OPTIONS.find((o) => o.id === id)
        return hit ? hit.t : String(id || '?')
      }

      /** 数字项（毫秒/次数/条数）：空字符串 ⇒ null（= 删除该字段，回落到默认值） */
      const numField = (path, label, unit, hint) => h('div', { style: { marginBottom: '10px' } },
        h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, label + (unit ? '（' + unit + '）' : '')),
        hint ? h('div', { style: Object.assign({ marginBottom: '4px' }, S.dim) }, hint) : null,
        h('input', {
          type: 'number', min: 0, step: 1, disabled: off,
          style: Object.assign({}, S.input, { width: '150px' }),
          value: fv(path) == null ? '' : fv(path),
          placeholder: '默认',
          onChange: (e) => fset(path, e.target.value === '' ? null : Number(e.target.value)),
        }))

      const runTest = () => {
        const query = String(q || '').trim()
        if (!query) { setRes({ ok: false, error: '先输入一个搜索词' }); return }
        setBusy(true); setRes(null)
        api('/search/run', { method: 'POST', body: JSON.stringify({ q: query }) })
          .then((r) => setRes(r))
          .catch((e) => setRes({ ok: false, error: String((e && e.message) || e) }))
          .then(() => setBusy(false))
      }

      return h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '联网搜索'),
        h('div', { style: Object.assign({ marginBottom: '8px' }, S.dim) },
          '多源真实搜索：受控并发（同时最多 2 个源）、整轮总预算到点就用已拿到的部分结果（超时不算失败）。'),
        h('div', { style: { marginBottom: '10px' } },
          h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, '开启联网搜索'),
          h('div', { style: Object.assign({ marginBottom: '4px' }, S.dim) }, '关掉 = 搜索接口直接回「搜索已关闭」，一个请求都不发。'),
          h(Toggle, { value: enabled, disabled: off, onChange: (v) => fset('search.enabled', v) })),
        h('div', { style: { marginBottom: '10px' } },
          h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, '用哪些搜索源'),
          h('div', { style: Object.assign({ marginBottom: '4px' }, S.dim) }, '全不选 = 用默认四源。至少留一个可用的源。'),
          SEARCH_SOURCE_OPTIONS.map((o) => h('div', { key: o.id, style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0' } },
            h(Toggle, { value: picked.includes(o.id), disabled: off, onChange: (v) => toggleSource(o.id, v) }),
            h('span', null, o.t + '（' + o.id + '）')))),
        numField('search.budgetMs', '单次搜索最多等多久', 'ms', '整轮预算（不是每源预算）；到点就用已拿到的部分结果，不算失败'),
        numField('search.cacheTtlMs', '结果缓存多久', 'ms', '同一个 URL 在缓存期内不重复抓取'),
        numField('search.ratePerMin', '每分钟最多搜几次', '次 / 分钟', '按源独立计数桶，防止把源站刷爆'),
        numField('search.maxResults', '最多返回几条', '条', '融合去重后的条数（后端上限 50）'),

        h('div', { style: { marginTop: '10px', paddingTop: '8px', borderTop: '1px solid rgba(128,128,128,0.18)' } },
          h('div', { style: { fontWeight: 500, marginBottom: '4px' } }, '测试搜索（真联网）'),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('input', {
              style: Object.assign({}, S.input, { width: '240px' }),
              value: q,
              placeholder: '输入搜索词（真打源站）',
              onChange: (e) => setQ(e.target.value),
            }),
            h('button', { style: S.btn(true), onClick: runTest, disabled: busy }, busy ? '搜索中…' : '测试搜索')),
          res ? h('div', { style: { marginTop: '8px' } },
            h('div', { style: { fontWeight: 600 } },
              (res.ok ? '✅ 搜索完成' : '❌ 搜索失败') + (res.q ? '：' + res.q : '')),
            res.error ? h('div', { style: Object.assign({}, S.mono, S.bad) }, res.error) : null,
            res.timedOut
              ? h('div', { style: Object.assign({ marginTop: '4px' }, S.dim, S.warn) },
                  '⚠️ 超时（单次搜索最多等 ' + (res.budgetMs != null ? res.budgetMs + 'ms' : '？') + '，已到点）：下面是已拿到的部分结果')
              : null,
            (res.sources || []).length
              ? h('div', { style: { marginTop: '6px' } },
                h('div', { style: Object.assign({ fontWeight: 600 }, S.dim) }, '各源状态'),
                res.sources.map((x, i) => h('div', { key: i, style: S.row },
                  h('span', null, (x.ok ? '✅ ' : '❌ ') + sourceLabel(x.id)),
                  h('span', { style: Object.assign({ textAlign: 'right' }, S.dim, x.ok ? null : S.warn) },
                    x.ok ? ((x.ms || 0) + 'ms · ' + (x.count || 0) + ' 条') : (x.error || '失败')))))
              : null,
            (res.results || []).length
              ? h('div', { style: { marginTop: '8px' } },
                h('div', { style: Object.assign({ fontWeight: 600 }, S.dim) },
                  '结果（共 ' + (res.total != null ? res.total : (res.results || []).length) + ' 条'
                  + ((res.results || []).length > 10 ? '，最多列前 10 条' : '') + '）'),
                // 后端上限 50 条；页面只列前 10 条，避免一次塞几百行把设置页拖长
                (res.results || []).slice(0, 10).map((r, i) => h('div', { key: i, style: Object.assign({}, S.row, { alignItems: 'baseline' }) },
                  h('span', { style: { minWidth: 0, wordBreak: 'break-all' } },
                    h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer', style: S.link }, r.title || r.url),
                    h('span', { style: Object.assign({ marginLeft: '6px' }, S.dim) }, '· 来源 ' + sourceLabel(r.source))),
                  h('span', { style: Object.assign({}, S.dim, S.mono) }, String(r.url || '').slice(0, 60)))))
              : (res.ok ? h('div', { style: Object.assign({ marginTop: '6px' }, S.dim) }, '（没有结果：换个搜索词，或看上面各源状态）') : null))
          : null))
    }

    /** 识图四档（与 config/store.js 的 DEFAULTS.vision.mode 完全一致；顺序 = 由安全到花钱） */
    const VISION_MODES = [
      { v: 'off', t: '关闭（不出网）', d: '图片只留在本机，完全不上传。最安全，也最省事。' },
      { v: 'local', t: '本机模型', d: '用你自己装在本机的视觉模型看图；不出网，但要自己把服务跑起来。' },
      { v: 'free-cloud', t: '免费云模型（推荐）', d: '把图片发给免费视觉模型识别成文字；免费，但需要你显式同意出网。' },
      { v: 'paid-cloud', t: '付费云模型', d: '用付费视觉模型看图，效果最好，会产生费用（仍受付费闸门与预算限额约束）。' },
    ]

    /**
     * 「识图（集成识图）」卡片（字段路径 vision.*）。
     * 🔴 mode=off 时下面 5 项**全部置灰（disabled）并提示「当前不出网，以下配置不生效」**——
     *    关闭档位下还让人填模型/缓存/上限，只会让人以为「填了就出网」。
     */
    function VisionSettingsCard(props) {
      const fv = props.fv
      const fset = props.fset
      const locked = props.disabled === true
      const mode = fv('vision.mode') || 'off'
      const off = mode === 'off'
      const subOff = locked || off
      const consented = fv('vision.consented') === true
      const needConsent = mode === 'free-cloud' || mode === 'paid-cloud'
      const bytesRaw = fv('vision.maxImageBytes')
      const mibVal = bytesRaw == null || bytesRaw === ''
        ? ''
        : Math.round((Number(bytesRaw) / 1048576) * 100) / 100

      const numField = (path, label, unit, hint, value, onChange, disabled) => h('div', { style: { marginBottom: '10px' } },
        h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, label + (unit ? '（' + unit + '）' : '')),
        hint ? h('div', { style: Object.assign({ marginBottom: '4px' }, S.dim) }, hint) : null,
        h('input', {
          type: 'number', min: 0, step: 1, disabled,
          style: Object.assign({}, S.input, { width: '150px' }),
          value,
          placeholder: '默认',
          onChange,
        }))

      return h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '识图（集成识图）'),
        h('div', { style: Object.assign({ marginBottom: '4px' }, S.dim) },
          '让看不了图的模型也能获得图片内容：先把图片交给视觉模型转述成文字，再交给主模型。'),
        h('div', { style: Object.assign({ marginBottom: '8px' }, S.dim) },
          '下面的档位决定图片要不要出网、出到哪一步，以及出网时的上限；关闭档位下图片永不出本机。'),
        h('div', { style: { marginBottom: '10px' } },
          h('div', { style: { fontWeight: 500, marginBottom: '4px' } }, '识图方式'),
          VISION_MODES.map((m) => h('div', {
            key: m.v,
            onClick: locked ? undefined : () => fset('vision.mode', m.v),
            style: {
              cursor: locked ? 'not-allowed' : 'pointer', padding: '6px 8px', marginBottom: '4px', borderRadius: '6px',
              border: '1px solid ' + (mode === m.v ? 'rgba(64,160,96,0.55)' : 'rgba(128,128,128,0.25)'),
              background: mode === m.v ? 'rgba(64,160,96,0.10)' : 'transparent',
              opacity: locked ? 0.6 : 1,
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h('span', { style: { fontWeight: mode === m.v ? 600 : 500 } }, m.t),
              mode === m.v ? h('span', { style: S.badge('good') }, '当前') : null),
            h('div', { style: Object.assign({ marginTop: '2px' }, S.dim) }, m.d)))),
        off
          ? h('div', { style: Object.assign({ marginBottom: '10px' }, S.dim, S.warn) },
              '当前不出网，以下配置不生效（改成「本机模型 / 免费云模型 / 付费云模型」后才会用上）。')
          : null,
        h('div', { style: { marginBottom: '10px' } },
          h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, '允许云端识图（出网同意）'),
          h('div', { style: Object.assign({ marginBottom: '4px' }, S.dim) },
            needConsent
              ? '免费/付费云模型必须显式同意才会上传图片；关掉 = 即使选了云模型也不出网。'
              : '只有选「免费云模型 / 付费云模型」时才有意义（当前档位不出网）。'),
          h(Toggle, { value: consented, disabled: subOff || !needConsent, onChange: (v) => fset('vision.consented', v) })),
        h('div', { style: { marginBottom: '10px' } },
          h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, '用哪个视觉模型'),
          h('div', { style: Object.assign({ marginBottom: '4px' }, S.dim) },
            '留空 = 默认 Qwen2.5-VL-72B-Instruct；也可以填你自己的视觉模型名（必须与所配平台的模型 id 完全一致）。'),
          h('input', {
            style: Object.assign({}, S.input, { width: '320px', maxWidth: '100%' }),
            value: fv('vision.model') == null ? '' : String(fv('vision.model')),
            disabled: subOff,
            placeholder: '默认 Qwen2.5-VL-72B-Instruct',
            onChange: (e) => fset('vision.model', e.target.value === '' ? null : e.target.value),
          })),
        numField('vision.cacheSize', '结果缓存条数', '条', '同一张图重复识别直接命中缓存，省时省钱',
          fv('vision.cacheSize') == null ? '' : fv('vision.cacheSize'),
          (e) => fset('vision.cacheSize', e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value)))), subOff),
        numField('vision.maxImagesPerTurn', '每轮最多几张图', '张', '一次对话里最多识别多少张（多出来的会被跳过）',
          fv('vision.maxImagesPerTurn') == null ? '' : fv('vision.maxImagesPerTurn'),
          (e) => fset('vision.maxImagesPerTurn', e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value)))), subOff),
        h('div', { style: { marginBottom: '10px' } },
          h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, '单张图片最大（MiB）'),
          h('div', { style: Object.assign({ marginBottom: '4px' }, S.dim) }, '超过就拒绝，不会悄悄压缩后上传'),
          h('input', {
            type: 'number', min: 0, step: 0.5, disabled: subOff,
            style: Object.assign({}, S.input, { width: '150px' }),
            value: mibVal,
            placeholder: '5',
            // 界面上按 MiB 显示，落盘仍是字节（vision.maxImageBytes），避免"单位在两层之间漂移"
            onChange: (e) => fset('vision.maxImageBytes', e.target.value === ''
              ? null
              : Math.round(Number(e.target.value) * 1048576)),
          })))
    }

    /** 子智能体路由三选项（契约 E3；顺序 = UI 顺序，不许乱） */
    const SUBAGENT_MODE_OPTIONS = [
      {
        v: 'auto',
        t: '选项一：不跟随路由，自动切换',
        d: '子智能体不继承上级授权，由 myfree 按当前可用性自动选路。这是今天的默认行为。',
      },
      {
        v: 'pinned',
        t: '选项二：不跟随路由，后续仍由全局或单独设置兜底（选定一个模型）',
        d: '先选定一个模型（如某家免费旗舰）；它不可用时按下面的「兜底」继续走。',
      },
      {
        v: 'follow',
        t: '选项三：跟随路由，后续仍由全局或单独设置兜底',
        d: '子智能体跟着主对话的选路结果走；主链都不可用时按下面的「兜底」继续走。',
      },
    ]

    /**
     * 「子智能体路由」卡片（写 subagentRouting.{mode, model, fallback}）。
     * 🔴 「不跟随」≠「不用全局设置」：三种模式都必须保留兜底层，
     *    否则 pinned 的模型一挂就直接失败（后端 validateSubagentRouting 同口径）。
     */
    function SubagentRoutingCard(props) {
      const fv = props.fv
      const fset = props.fset
      const locked = props.disabled === true
      const groups = Array.isArray(props.models) ? props.models : []
      const mode = fv('subagentRouting.mode') || 'auto'
      const model = fv('subagentRouting.model') || ''
      const fallback = fv('subagentRouting.fallback') || 'global'
      const needModel = mode === 'pinned'
      const needFallback = mode === 'pinned' || mode === 'follow'

      return h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '子智能体路由'),
        h('div', { style: Object.assign({ marginBottom: '4px' }, S.dim) },
          '选了一个对话后，子智能体默认不跟随上级对话的模型，由 myfree 接手自动切换。'),
        h('div', { style: Object.assign({ marginBottom: '8px' }, S.dim) },
          '管的是「派出去的子智能体用什么模型」。三选一；后两种都要指定兜底，避免主选不可用时直接失败。'),
        SUBAGENT_MODE_OPTIONS.map((o) => h('div', {
          key: o.v,
          onClick: locked ? undefined : () => fset('subagentRouting.mode', o.v),
          style: {
            cursor: locked ? 'not-allowed' : 'pointer', padding: '6px 8px', marginBottom: '4px', borderRadius: '6px',
            border: '1px solid ' + (mode === o.v ? 'rgba(64,160,96,0.55)' : 'rgba(128,128,128,0.25)'),
            background: mode === o.v ? 'rgba(64,160,96,0.10)' : 'transparent',
            opacity: locked ? 0.6 : 1,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            // 视觉上是 radio，语义上是「点整张卡片」——与识图档位、作用域卡片一致
            h('span', {
              style: {
                display: 'inline-block', width: '12px', height: '12px', borderRadius: '50%', flexShrink: 0,
                border: '2px solid ' + (mode === o.v ? 'var(--dsw-alias-state-success-primary)' : 'rgba(128,128,128,0.6)'),
                background: mode === o.v ? 'var(--dsw-alias-state-success-primary)' : 'transparent',
              },
            }),
            h('span', { style: { fontWeight: mode === o.v ? 600 : 500 } }, o.t)),
          h('div', { style: Object.assign({ marginTop: '2px' }, S.dim) }, o.d))),

        needModel
          ? h('div', { style: { marginTop: '8px' } },
            h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, '固定用哪个模型'),
            h('select', {
              style: Object.assign({}, S.input, { width: '300px', maxWidth: '100%' }),
              value: model,
              disabled: locked,
              onChange: (e) => fset('subagentRouting.model', e.target.value || null),
            },
              h('option', { value: '' }, '请选择一个模型…'),
              groups.map((g) => h('optgroup', { key: g.provider, label: g.label },
                (g.models || []).map((m) => h('option', { key: g.provider + '/' + m.id, value: m.id }, m.name || m.id))))),
            !model
              ? h('div', { style: Object.assign({ marginTop: '4px' }, S.dim, S.warn) },
                  '选了「固定用一个模型」就必须选一个模型，否则后端会拒绝保存。')
              : null)
          : null,

        needFallback
          ? h('div', { style: { marginTop: '8px' } },
            h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, '兜底：主选不可用时怎么办'),
            h('select', {
              style: Object.assign({}, S.input, { width: '300px', maxWidth: '100%' }),
              value: fallback,
              disabled: locked,
              onChange: (e) => fset('subagentRouting.fallback', e.target.value),
            },
              h('option', { value: 'global' }, '用全局链兜底'),
              h('option', { value: 'scope' }, '用本层单独设置的链兜底')),
            h('div', { style: Object.assign({ marginTop: '3px' }, S.dim) },
              '「本层」= 上面①选中的作用域这一层自己配的链；这一层没配过链的话，仍然回落到全局。'))
          : null)
    }

    /**
     * 「火山方舟余额」卡片（/cs-myfree/cash 的 ark 分支；三分支口径见 src/web/cash.js 文件头）。
     *
     * 三分支（顺序不可变）：live（主账号 AK/SK 查询成功）→ estimated（本地账本近 30 天估算）
     * → error（连推理 Key 都没有）。
     * 🔴 红线：estimated 分支的**任何**文案里都不许出现「官方 / 实时 / live」——
     *    那是把估算伪装成账单，属于欺骗性展示。这里连「账单」都只写「账本估算」。
     */
    function ArkCard(props) {
      const ark = props.ark
      const onRefresh = props.onRefresh
      const src = ark && ark.source
      const total = ark && ark.total != null
        ? (ark.currency === 'CNY' ? '¥' : String(ark.currency || '') + ' ') + Number(ark.total).toFixed(2)
        : null
      const fmtTs = (ms) => (ms ? new Date(Number(ms)).toLocaleString('zh-CN', { hour12: false }) : '—')

      let badge = null
      let note = '加载中…'
      if (ark) {
        if (src === 'live') {
          badge = h('span', { style: S.badge('good') }, '实时')
          note = '实时查询成功（已配置主账号 AK/SK）· 币种 ' + (ark.currency || '—') + ' · 查询时间 ' + fmtTs(ark.fetchedAt)
            + (ark.period && ark.period.fromMs ? ' · 统计区间 ' + fmtTs(ark.period.fromMs) + ' 至 ' + fmtTs(ark.period.toMs) : '')
        } else if (src === 'estimated') {
          badge = h('span', { style: S.badge('warn') }, '估算')
          note = '估算值：本地账本近 30 天 ark 渠道消耗合计，不等于账单数字'
            + (ark.note ? '；' + ark.note : '')
        } else if (src === 'error') {
          badge = h('span', { style: S.badge('warn') }, '不可用')
          note = ark.error || '余额不可用'
        } else {
          note = '来源状态未知：' + JSON.stringify(src)
        }
      }

      return h('div', { style: S.card },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
          h('div', { style: { fontWeight: 600 } }, '火山方舟余额', badge),
          h('span', {
            style: S.btn(false),
            onClick: () => (typeof onRefresh === 'function' ? onRefresh() : null),
          }, ark ? '刷新' : '重新查询')),
        h('div', {
          style: {
            fontSize: '22px', fontWeight: 700, margin: '2px 0 4px',
            color: total ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
          },
        }, total || '—'),
        h('div', { style: Object.assign({}, S.dim, src === 'error' ? S.warn : null) }, note),
        src === 'estimated'
          ? h('div', { style: Object.assign({ marginTop: '4px' }, S.dim) },
              '口径：' + (ark.basis || 'ledger-30d') + '（只用本插件自己的账本，不读任何外部账单接口）')
          : null,
        src === 'error'
          ? h('div', { style: Object.assign({ marginTop: '4px' }, S.dim) },
              '需要主账号 AK/SK 才能查真实账单。怎么配：在宿主凭据库（或环境变量）添加 ARK_API_KEY——'
              + '这是火山方舟的推理 Key，只能用来调模型、查不了账单；要账单级数字，还得加主账号 AK/SK'
              + '（VOLC_ACCESS_KEY_ID / VOLC_SECRET_ACCESS_KEY）。')
          : null)
    }

    /**
     * 「外部对话上下文」卡片（需求：把 DeepSeek 网页版的对话同步给 DSH，且「传得少」）。
     *
     * 三件事都在这一张卡里解决：
     *   ① 口令：扩展要用它鉴权（键名 contextBridgeCode，避开敏感字段拦截器）
     *   ② 状态：最近一次上报的时间/条数/字节（直接打 GET /context，走同源 cookie 校验）
     *   ③ 操作：清空、刷新、复制扩展地址（用户不用去翻文档）
     *
     * 🔴 这张卡**不提交**任何 agent 配置：口令走 fset（普通设置路径），
     *    状态查询是纯 GET。所以它不会把设置页变成另一个写入面。
     */
    function ContextBridgeCard(props) {
      const fv = props.fv
      const fset = props.fset
      const disabled = props.disabled === true
      const [st, setSt] = react.useState(null)
      const [err, setErr] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [msg, setMsg] = react.useState(null)

      const code = fv('contextBridgeCode') || ''
      const endpoint = 'http://150.158.175.241/cs-myfree/context/deepseek'

      const load = () => {
        setErr(null)
        api('/context').then((d) => setSt(d)).catch((e) => setErr(String((e && e.message) || e)))
      }
      react.useEffect(() => { load() }, [])

      const fmtTs = (ms) => {
        if (!Number.isFinite(Number(ms)) || !ms) return '—'
        try { return new Date(Number(ms)).toLocaleString('zh-CN', { hour12: false }) } catch { return '—' }
      }
      const ageText = (ms) => {
        if (!Number.isFinite(Number(ms))) return ''
        if (ms < 60000) return Math.round(ms / 1000) + ' 秒前'
        if (ms < 3600000) return Math.round(ms / 60000) + ' 分钟前'
        return Math.round(ms / 3600000) + ' 小时前'
      }

      const doClear = () => {
        setBusy(true); setMsg(null)
        fetch(API + '/context', { method: 'DELETE', credentials: 'same-origin' })
          .then((r) => r.json())
          .then((r) => { setMsg({ ok: true, text: '✅ 已清空上下文' }); load() })
          .catch((e) => setMsg({ ok: false, text: '❌ ' + String((e && e.message) || e) }))
          .then(() => setBusy(false))
      }
      const doCopy = () => {
        const t = endpoint + '\n口令：' + (code || '（还没填，先在上面填一个）')
        copyPlainText(t).then((r) => setMsg({ ok: r.ok, text: r.text }))
      }

      const empty = !st || st.empty === true
      const badge = err
        ? h('span', { style: S.badge('warn') }, '读取失败')
        : empty
          ? h('span', { style: S.badge() }, '尚无上报')
          : h('span', { style: S.badge('good') }, '已连接')

      return h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '外部对话上下文（DeepSeek 网页版）', badge),
        h('div', { style: Object.assign({ marginBottom: '8px' }, S.dim) },
          '把你在 chat.deepseek.com 聊的内容，按「最近 N 条、每条截断」同步过来，供这里继续干活。'
          + '只读你当前页面的对话正文，不读 cookie、不读侧栏历史。'),

        // ① 口令
        h('div', { style: { marginBottom: '10px' } },
          h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, '口令（扩展用它鉴权）'),
          h('div', { style: Object.assign({ marginBottom: '4px' }, S.dim) },
            '自己定一串即可。填好后在扩展弹窗里填同一个值。'),
          h('input', {
            style: Object.assign({}, S.input, { width: '260px' }),
            value: code,
            disabled,
            placeholder: '例如 my-free-2026',
            onChange: (e) => fset('contextBridgeCode', e.target.value || null),
          })),

        // ② 状态
        h('div', { style: Object.assign({ marginBottom: '10px' }, S.row) },
          h('span', null, '最近上报'),
          h('span', { style: { fontWeight: 600 } },
            empty ? '还没有' : fmtTs(st.updatedAt) + '（' + ageText(st.ageMs) + '）')),
        empty ? null : h('div', { style: S.row },
          h('span', null, '保留条数'),
          h('span', { style: { fontWeight: 600 } },
            (st.count || 0) + ' 条 · ' + Math.round((st.bytesKept || 0) / 1024) + ' KB'
            + (st.dropped > 0 ? '（已丢弃较早的 ' + st.dropped + ' 条）' : ''))),
        empty || !Array.isArray(st.preview) ? null : h('div', { style: { marginTop: '6px' } },
          h('div', { style: Object.assign({ marginBottom: '3px' }, S.dim) }, '最近两条预览（只显示开头）'),
          st.preview.map((m, i) => h('div', { key: i, style: Object.assign({}, S.row, { padding: '2px 0' }) },
            h('span', { style: S.dim }, m.role === 'assistant' ? 'AI' : '你'),
            h('span', { style: { flex: '1 1 auto', marginLeft: '8px', wordBreak: 'break-all' } }, String(m.text || ''))))),

        err ? h('div', { style: Object.assign({ marginTop: '6px' }, S.dim, S.warn) }, '读取状态失败：' + err) : null,

        // ③ 操作
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px', alignItems: 'center' } },
          h('button', { style: S.btn(false), onClick: load, disabled: busy }, '刷新状态'),
          h('button', { style: S.btn(false), onClick: doCopy }, '复制给扩展用'),
          h('button', { style: S.btn(false), onClick: doClear, disabled: busy || empty }, '清空')),
        msg ? h('div', { style: Object.assign({ marginTop: '6px' }, S.dim, msg.ok ? S.good : S.warn) }, msg.text) : null,

        // 「传得少」的四道闸门，写清楚让用户知道上限在哪
        h('div', { style: Object.assign({ marginTop: '10px' }, S.dim) },
          '上传上限（固定）：最近 20 条 · 每条 200 字 · 总计 64KB · 6 小时过期。'
          + '需要更少可以在扩展弹窗里把「最多几条 / 每条最多字」调小。'))
    }

    /**
     * 「路由基本规则」区块（契约 B：routing.rules；旧称「复杂路由基本规则」）。
     *
     * 🔴 定位：**规则说明 + 统计 + 设置**，不是开关面板 —— 用户明确要求「不要加任何开关」。
     * 所以这里没有总开关，只有：当前策略 / 排序键 / 权重 / 过滤层 / 空集兜底 / 冷却参数 /
     * 每家闸门统计 / 可编辑设置项（后端保证每个 path 真能 patch 生效）。
     */
    function RoutingRulesCard(props) {
      const rules = props.rules
      const [draft, setDraft] = react.useState({})
      const [msg, setMsg] = react.useState(null)
      const [busy, setBusy] = react.useState('')

      if (!rules) {
        return h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '路由基本规则'),
          h('div', { style: S.dim },
            '后端未返回 routing.rules（需要较新版本的后端）：规则说明与逐项设置暂时不可用，选路仍按默认策略执行。'))
      }

      /** 编辑底稿优先，否则用后端给的生效值 */
      const valOf = (path, fallback) => (Object.prototype.hasOwnProperty.call(draft, path) ? draft[path] : fallback)
      const setVal = (path, v) => setDraft((p) => Object.assign({}, p, { [path]: v }))

      /** "a.b.c" ⇒ { a: { b: { c: value } } }（POST /settings 的 patch 形状） */
      const patchOfPath = (path, value) => {
        const out = {}
        let cur = out
        const keys = String(path).split('.')
        for (let i = 0; i < keys.length - 1; i++) { cur[keys[i]] = {}; cur = cur[keys[i]] }
        cur[keys[keys.length - 1]] = value
        return out
      }

      const savePath = (path, value) => {
        setBusy(path); setMsg(null)
        api('/settings', { method: 'POST', body: JSON.stringify({ scope: 'global', patch: patchOfPath(path, value) }) })
          .then((r) => {
            if (!r || r.ok === false) setMsg({ ok: false, error: (r && r.error) || '保存失败' })
            else setMsg({ ok: true, text: '✅ 已保存 ' + path + '（全局层），下次请求生效' })
          })
          .catch((e) => setMsg({ ok: false, error: String((e && e.message) || e) }))
          .then(() => setBusy(''))
      }

      /** 一项可设置项的控件（select / bool / number；number 可能有多条 paths 逐家渲染） */
      const controlOf = (item) => {
        const paths = Array.isArray(item.paths) && item.paths.length ? item.paths : [item.path]
        if (item.type === 'bool') {
          return h('div', null,
            h(Toggle, {
              value: valOf(item.path, item.value) === true,
              onChange: (v) => { setVal(item.path, v); savePath(item.path, v) },
            }),
            busy === item.path ? h('span', { style: Object.assign({ marginLeft: '8px' }, S.dim) }, '保存中…') : null)
        }
        if (item.type === 'select') {
          const opts = Array.isArray(item.options) ? item.options : []
          return h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('select', {
              style: Object.assign({}, S.input, { width: '240px' }),
              value: String(valOf(item.path, item.value) ?? ''),
              onChange: (e) => { setVal(item.path, e.target.value); savePath(item.path, e.target.value) },
            }, opts.map((o) => h('option', { key: String(o), value: String(o) }, PRIORITY_TEXT[o] || String(o)))),
            busy === item.path ? h('span', { style: S.dim }, '保存中…') : null)
        }
        // number：sources.limits.<id> 这类「逐家」项 ⇒ 每条 path 一个输入框
        const multi = paths.length > 1
        return h('div', { style: multi ? { display: 'flex', flexWrap: 'wrap', gap: '8px 14px' } : null },
          paths.map((p) => {
            const short = multi ? String(p).split('.').pop() : null
            const raw = valOf(p, multi ? (item.value || {})[short] : item.value)
            return h('div', { key: p, style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              short ? h('span', { style: S.dim }, short) : null,
              h('input', {
                type: 'number', min: 0, step: 1,
                style: Object.assign({}, S.input, { width: '110px' }),
                value: raw == null ? '' : raw,
                onChange: (e) => setVal(p, e.target.value === '' ? null : Number(e.target.value)),
              }),
              h('span', {
                style: Object.assign({}, S.btn(false), busy === p ? { opacity: 0.5 } : null),
                onClick: () => savePath(p, valOf(p, raw) == null ? null : Number(valOf(p, raw))),
              }, busy === p ? '…' : '保存'))
          }))
      }

      const gateEntries = Object.entries(rules.gate || {})
      const filters = Array.isArray(rules.filters) ? rules.filters : []
      const cooldowns = rules.cooldowns || {}
      const fallbackInfo = rules.emptySetFallback || {}
      const configurable = Array.isArray(rules.configurable) ? rules.configurable : []

      // ── 各小节先各自算成节点，最后再拼进外层 ──
      // 为什么要拆：这个区块有 7 张卡，直接嵌套写会让括号深度到 6+，
      // 一旦错一个 `)` 整个 client bundle 就解析失败（2026-11-05 事故同款后果）。
      const policyNodes = (rules.policyOptions || []).map((o) => h('div', {
        key: o.id,
        // 非 active 的一律压暗（S.dim 的 opacity 口径）：一眼就能看出「当前在用哪条策略」
        style: {
          padding: '5px 8px', marginBottom: '4px', borderRadius: '6px', opacity: o.active ? 1 : 0.65,
          border: '1px solid ' + (o.active ? 'rgba(64,160,96,0.55)' : 'rgba(128,128,128,0.2)'),
          background: o.active ? 'rgba(64,160,96,0.10)' : 'transparent',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: o.active ? 600 : 500 } }, o.label || o.id),
          o.active ? h('span', { style: S.badge('good') }, '当前') : null),
        h('div', { style: { marginTop: '2px', fontSize: '12px' } }, o.desc || ''),
        o.evidence ? h('div', { style: Object.assign({ marginTop: '2px' }, S.dim) }, '实测依据：' + o.evidence) : null))

      const policyCard = h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '策略（当前：' + (rules.policy || '—') + '）'),
        policyNodes)

      const orderCard = h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '排序键与权重'),
        h('div', { style: { marginBottom: '4px' } }, rules.orderHuman || '—'),
        h('div', { style: Object.assign({ marginBottom: '6px' }, S.mono, S.dim) }, (rules.order || []).join(' → ')),
        h(KV, { k: '拥挤度权重（load）', v: String((rules.weights && rules.weights.load) ?? '—') }),
        h(KV, { k: '失败率权重（fail）', v: String((rules.weights && rules.weights.fail) ?? '—') }))

      const filterNodes = filters.map((f) => h('div', {
        key: f.id || String(f.position),
        style: Object.assign({}, S.row, { alignItems: 'baseline' }),
      },
        h('span', { style: { minWidth: 0 } },
          h('span', { style: S.mono }, '#' + f.position + ' '),
          h('span', { style: { fontWeight: 500 } }, f.label || f.id),
          // strict=true ⇒ 黄徽标「严格」；false ⇒ 灰徽标「可放宽」（S.badge 的 dim 档）
          h('span', { style: S.badge(f.strict ? 'warn' : 'dim') }, f.strict ? '严格' : '可放宽')),
        h('span', { style: Object.assign({ textAlign: 'right' }, S.dim) }, f.effect || '')))

      const filterCard = h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '过滤层（按 position 依次执行）'),
        filters.length === 0 ? h('div', { style: S.dim }, '（后端未返回过滤层）') : filterNodes)

      const fallbackCard = h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '空集兜底范围'),
        h('div', { style: S.dim }, fallbackInfo.note || '—'),
        (fallbackInfo.appliesTo || []).length
          ? h('div', { style: Object.assign({ marginTop: '3px' }, S.dim) }, '会兜底：' + (fallbackInfo.appliesTo || []).join(' / '))
          : null,
        (fallbackInfo.excludes || []).length
          ? h('div', { style: Object.assign({ marginTop: '2px' }, S.dim, S.warn) }, '永不放宽：' + (fallbackInfo.excludes || []).join(' / '))
          : null)

      const cooldownCard = h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '冷却参数（当前生效值）'),
        h(KV, { k: '并发满后等（busyMs）', v: String(cooldowns.busyMs ?? '—') + ' ms' }),
        h(KV, { k: '被限流后等（rateMs）', v: String(cooldowns.rateMs ?? '—') + ' ms' }),
        h(KV, { k: '退避封顶（maxMs）', v: String(cooldowns.maxMs ?? '—') + ' ms' }),
        cooldowns.note ? h('div', { style: Object.assign({ marginTop: '4px' }, S.dim) }, cooldowns.note) : null)

      // ⑥ 每家闸门统计：手写 flex 表格（本项目没有 <table>，全用 S.row 拼），列宽固定保证对齐
      const HEAD = { flexShrink: 0, textAlign: 'right' }
      const gateHead = h('div', { style: { display: 'flex', gap: '6px', padding: '3px 0', borderBottom: '1px solid rgba(128,128,128,0.35)' } },
        h('span', { style: Object.assign({ flex: '1 1 110px' }, S.dim) }, '渠道'),
        h('span', { style: Object.assign({}, HEAD, { width: '64px' }, S.dim) }, '活跃/上限'),
        h('span', { style: Object.assign({}, HEAD, { width: '50px' }, S.dim) }, '占比'),
        h('span', { style: Object.assign({}, HEAD, { width: '82px' }, S.dim) }, '冷却'),
        h('span', { style: Object.assign({}, HEAD, { width: '56px' }, S.dim) }, '429连击'),
        h('span', { style: Object.assign({}, HEAD, { width: '58px' }, S.dim) }, '失败率'),
        h('span', { style: Object.assign({}, HEAD, { width: '50px' }, S.dim) }, '样本数'))

      const cellStyle = { flexShrink: 0, textAlign: 'right', fontSize: '11px' }
      const gateRows = gateEntries.map(([id, g]) => {
        const coolingMs = Number(g.coolingMs) || 0
        return h('div', {
          key: id,
          style: { display: 'flex', gap: '6px', padding: '3px 0', borderBottom: '1px solid rgba(128,128,128,0.10)' },
        },
          h('span', { style: { flex: '1 1 110px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, id),
          h('span', { style: Object.assign({ width: '64px' }, cellStyle) }, String(g.active ?? 0) + '/' + String(g.limit ?? '—')),
          h('span', { style: Object.assign({ width: '50px' }, cellStyle) }, g.ratio == null ? '—' : (Math.round(Number(g.ratio) * 100) + '%')),
          // 冷却中要**明确写「冷却中」**并高亮（只给个 "15s" 用户不知道那是冷却还是耗时）
          h('span', { style: Object.assign({ width: '82px' }, cellStyle, coolingMs > 0 ? S.warn : null) },
            coolingMs > 0 ? ('冷却中 ' + Math.round(coolingMs / 100) / 10 + 's') : '—'),
          h('span', { style: Object.assign({ width: '56px' }, cellStyle) }, String(g.streak429 ?? 0)),
          h('span', { style: Object.assign({ width: '58px' }, cellStyle) }, g.failRate == null ? '—' : (Math.round(Number(g.failRate) * 1000) / 10 + '%')),
          h('span', { style: Object.assign({ width: '50px' }, cellStyle) }, String(g.failSamples ?? 0)))
      })

      const gateCard = h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '各家闸门统计（实时）'),
        gateEntries.length === 0
          ? h('div', { style: S.dim }, '暂无闸门数据（还没有渠道参与过选路，或后端未返回 gate）')
          : h('div', null, gateHead, gateRows))

      // ⑦ 可设置项：每项一个控件 + 一个「保存」（POST /settings 对应 path）
      const configurableNodes = configurable.map((item) => h('div', { key: item.path, style: { marginBottom: '12px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 500 } }, item.label || item.path),
          h('span', { style: S.badge('good') }, item.source === 'config' ? '已自定义' : '默认值'),
          h('span', { style: Object.assign({}, S.mono, S.dim) }, item.path + (item.unit ? '（' + item.unit + '）' : ''))),
        item.effect ? h('div', { style: Object.assign({ margin: '2px 0 4px' }, S.dim) }, item.effect) : null,
        controlOf(item)))

      const configCard = h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '2px' } }, '设置（保存到全局层）'),
        h('div', { style: Object.assign({ marginBottom: '8px' }, S.dim) },
          '改一项就发一次 patch（只写这一项）；生效值会立即回读显示在「冷却参数」「闸门统计」里。'),
        configurable.length === 0 ? h('div', { style: S.dim }, '（后端未返回可设置项清单）') : configurableNodes,
        msg ? h('div', { style: Object.assign({ marginTop: '6px' }, S.dim, msg.ok ? S.good : S.bad) }, msg.text || msg.error) : null)

      return h('div', { style: { marginTop: '12px' } },
        h('div', { style: { fontWeight: 600, marginBottom: '2px' } }, '路由基本规则（说明 + 统计 + 设置）'),
        h('div', { style: Object.assign({ marginBottom: '8px' }, S.dim) },
          '这里只解释「现在按什么规则选路、为什么这么选、各家当前状态」，并把可改的几项做成控件。没有总开关：规则本身不是开关。'),
        policyCard,
        orderCard,
        filterCard,
        fallbackCard,
        cooldownCard,
        gateCard,
        configCard)
    }

    function SettingsPage(props) {
      const [s, reload] = useApi('/settings')
      const [st, reloadSt] = useApi('/state')
      const [pick, setPick] = react.useState('global')
      const [form, setForm] = react.useState(null)
      const [idInput, setIdInput] = react.useState('')
      const [msg, setMsg] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [advOpen, setAdvOpen] = react.useState(false)
      const [ark, setArk] = react.useState(null)
      // 方舟余额刷新计数（点「刷新」+1 ⇒ effect 重跑；以前直接 setArk(null) 只会卡在"加载中"）
      const [arkTick, setArkTick] = react.useState(0)
      // design/21 §2：作用域下拉选中的真实对象 id（workspace/team；session 固定取当前会话）
      const [objPick, setObjPick] = react.useState('')

      // 火山方舟余额（/cs-myfree/cash；三分支 live / estimated / error 的口径见 src/web/cash.js）
      react.useEffect(() => {
        let alive = true
        setArk(null)
        fetch(CASH_PATH, { credentials: 'same-origin' })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
          .then((d) => { if (alive) setArk(d && d.ark ? d.ark : null) })
          .catch(() => { if (alive) setArk({ provider: 'ark', total: null, source: 'error', error: '余额查询失败（网络或接口异常）' }) })
        return () => { alive = false }
      }, [arkTick])

      // 初始表单 = 全局层已存配置（编辑底稿；没存过 = 空表单）
      react.useEffect(() => {
        if (s.data && !form) {
          const item = (s.data.layers || []).find((l) => l.scope === pick)
          setForm(JSON.parse(JSON.stringify((item && item.config) || {})))
        }
      }, [s.data])

      if (s.error) {
        return h('div', null,
          h(Err, { error: '设置读取失败：' + s.error }),
          h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
            h('button', { style: S.btn(true), onClick: () => { reload(); reloadSt() } }, '重试')))
      }
      if (!s.data) return h('div', null, h(Loading, { on: true }))

      const d = s.data
      const meta = d.meta || {}
      const layers = Array.isArray(d.layers) ? d.layers : []
      const effConfig = (d.effective && d.effective.config) || {}
      const byLayer = (d.effective && d.effective.byLayer) || {}
      const models = Array.isArray(d.models) ? d.models : []
      const channels = Array.isArray(d.channels) ? d.channels : []
      const recent = Array.isArray(d.recent) ? d.recent : []
      const failures = d.failures || {}
      const stData = st.data || {}
      // design/21 §2：真实对象枚举（后端尽力而为；为空 ⇒ 手填兜底）
      const scopes = d.scopes || {}
      const wsList = scopes.workspaces || []
      const teamList = scopes.teams || []
      const curSess = scopes.session || (meta.context && meta.context.sessionId ? { id: meta.context.sessionId, label: meta.context.sessionId } : null)

      const layerItem = layers.find((l) => l.scope === pick) || { scope: pick, id: null, owner: null, config: {} }
      // 选中对象 id：workspace/team = 下拉选中或手填；session = 当前会话；global = 无
      const ctxId = layerItem.id || (meta.context || {})[pick === 'workspace' ? 'workspaceId' : pick === 'team' ? 'teamId' : pick === 'session' ? 'sessionId' : null] || null
      const chosenId = pick === 'global' ? null
        : pick === 'session' ? (curSess && curSess.id || ctxId)
          : (objPick.trim() || idInput.trim() || ctxId || null)
      const layerId = chosenId
      const needsId = pick !== 'global' && !layerId
      // 🔒 锁定态：层 owner=admin 且当前非 admin ⇒ 只读
      const locked = layerItem.owner === 'admin' && !meta.isAdmin
      const disabled = locked || needsId || busy

      const sourceOf = (path) => {
        const keys = String(path).split('.')
        for (const scope of SETTINGS_SOURCE_ORDER) {
          const cfg = byLayer[scope]
          if (!cfg || typeof cfg !== 'object') continue
          let cur = cfg, found = true
          for (const k of keys) {
            if (cur && typeof cur === 'object' && k in cur) cur = cur[k]
            else { found = false; break }
          }
          if (found) return scope
        }
        return 'global'
      }
      const sourceNote = (path) => h('span', { style: Object.assign({}, S.dim) },
        '当前生效值来自「' + SETTINGS_LAYER_LABEL[sourceOf(path)] + '」层')

      const fv = (path) => getField(form || {}, path)
      const fset = (path, v) => setForm((f) => setField(f || {}, path, v))

      // 需求 #5：这一层跟全局哪里不一样（只算已保存值 ⇒ 与保存用的 base 同一份，口径不会漂）
      const layerCfgForDiff = (layerItem && layerItem.config) || {}
      const globalCfgForDiff = (byLayer && byLayer.global) || {}
      const globalDiffs = pick === 'global' ? [] : diffAgainstGlobal(layerCfgForDiff, globalCfgForDiff, sourceOf)

      /**
       * 恢复全局 = 删掉这一层这个键（PATCH /settings），**不是**把全局值写进这一层。
       * 成功后同步把编辑底稿里的这个键也删掉，界面立刻跟磁盘一致。
       */
      const restoreGlobal = (path) => {
        setBusy(true); setMsg(null)
        deleteLayerSetting(pick, layerId, path)
          .then((r) => {
            if (r && r.ok === false) { setMsg({ ok: false, error: r.error || '恢复失败' }); return }
            setForm((f) => dropField(f || {}, path))
            setMsg({ ok: true, text: '✅ 已恢复全局：删掉了这一层的「' + path + '」' })
          })
          .catch((e) => setMsg({ ok: false, error: String((e && e.message) || e) }))
          .then(() => { setBusy(false); reload() })
      }

      const loadForm = (scope) => {
        setPick(scope); setMsg(null); setObjPick('')
        const item = layers.find((l) => l.scope === scope)
        setForm(JSON.parse(JSON.stringify((item && item.config) || {})))
        reload()  // 重新拉取（含 scopes 枚举），保证切换作用域时后端 scopes 最新
      }

      const save = () => {
        setBusy(true); setMsg(null)
        const baseItem = layers.find((l) => l.scope === pick)
        const base = (baseItem && baseItem.config) || {}
        const patch = diffPatch(base, form || {})
        if (Object.keys(patch).length === 0) {
          setBusy(false); setMsg({ ok: true, warn: '没有改动，无需保存' })
          return
        }
        api('/settings', {
          method: 'POST',
          body: JSON.stringify({ scope: pick, id: pick === 'global' ? undefined : layerId, patch }),
        })
          .then((r) => {
            if (!r.ok) setMsg({ ok: false, error: r.error || '保存失败' })
            else setMsg({ ok: true, text: '✅ 已保存，下次请求生效' })
          })
          .catch((e) => setMsg({ ok: false, error: String((e && e.message) || e) }))
          .then(() => { setBusy(false); reload() })
      }

      // ── 步骤1 作用域选择器（design/21 §2：下拉选真实对象）──
      const ctxIdOf = (scope) => (meta.context || {})[scope === 'workspace' ? 'workspaceId' : scope === 'team' ? 'teamId' : scope === 'session' ? 'sessionId' : null] || null
      // 选择「真实对象」：workspace/team 从枚举下拉选；session 固定当前会话
      const pickObject = (scope, v) => {
        setObjPick(v)
        setMsg(null)
        if (v && v !== ctxIdOf(scope)) setForm({})   // 选中的不是当前上下文对象 ⇒ 底稿置空（保存将新建该对象层）
        else {
          const item = layers.find((l) => l.scope === scope)
          setForm(JSON.parse(JSON.stringify((item && item.config) || {})))
        }
      }
      const wsPickUI = pick === 'workspace' ? (wsList.length > 0
        ? h('div', { style: { marginTop: '6px' } },
            h('div', { style: Object.assign({ marginBottom: '3px' }, S.dim) }, '选择工作区（历史出现过的项目目录）：'),
            h('select', {
              style: Object.assign({}, S.input, { width: '320px', maxWidth: '100%' }),
              value: objPick || ctxIdOf('workspace') || '',
              onChange: (e) => pickObject('workspace', e.target.value),
            },
              h('option', { value: '' }, (objPick ? '' : (ctxIdOf('workspace') || '请选择…'))),
              wsList.map((w) => h('option', { key: w.id, value: w.id }, w.label))),
            h('div', { style: Object.assign({ marginTop: '4px' }, S.dim) }, '选中的工作区会读写它自己的那层设置。'))
        : h('div', { style: { marginTop: '6px' } },
            h('div', { style: Object.assign({ marginBottom: '3px' }, S.dim, S.warn) }, '当前没有可选的工作区，可手填 ID（如 dev）：'),
            h('input', {
              style: Object.assign({}, S.input, { width: '280px' }),
              value: idInput,
              placeholder: '如 dev',
              onChange: (e) => setIdInput(e.target.value),
            }))) : null
      const teamPickUI = pick === 'team' ? (teamList.length > 0
        ? h('div', { style: { marginTop: '6px' } },
            h('div', { style: Object.assign({ marginBottom: '3px' }, S.dim) }, '选择团队 / 房间：'),
            h('select', {
              style: Object.assign({}, S.input, { width: '320px', maxWidth: '100%' }),
              value: objPick || ctxIdOf('team') || '',
              onChange: (e) => pickObject('team', e.target.value),
            },
              h('option', { value: '' }, (objPick ? '' : (ctxIdOf('team') || '请选择…'))),
              teamList.map((t) => h('option', { key: t.id, value: t.id }, t.label))),
            h('div', { style: Object.assign({ marginTop: '4px' }, S.dim) }, '团队层最优先；没设的字段继续用下一层。'))
        : h('div', { style: { marginTop: '6px' } },
            h('div', { style: Object.assign({ marginBottom: '3px' }, S.dim, S.warn) }, '当前没有可选的团队，可手填 ID：'),
            h('input', {
              style: Object.assign({}, S.input, { width: '280px' }),
              value: idInput,
              placeholder: '团队 ID',
              onChange: (e) => setIdInput(e.target.value),
            }))) : null
      const sessPickUI = pick === 'session' ? h('div', { style: { marginTop: '6px' } },
        curSess
          ? h('div', { style: Object.assign({}, S.dim) }, '当前会话：' + curSess.label + (curSess.id !== curSess.label ? '（' + curSess.id + '）' : ''))
          : h('div', { style: Object.assign({ marginBottom: '3px' }, S.dim, S.warn) }, '当前会话未知，可手填会话 ID：'),
        !curSess ? h('input', {
          style: Object.assign({}, S.input, { width: '280px' }),
          value: idInput,
          placeholder: '会话 ID',
          onChange: (e) => setIdInput(e.target.value),
        }) : null) : null

      const step1 = h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '① 这些设置应用在：'),
        h('div', { style: Object.assign({ marginBottom: '8px' }, S.dim) }, '范围越窄越优先：团队 > 对话 > 工作区 > 全局。只改选中的这一层，没设的字段继续继承上一层。'),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '4px' } },
          h('select', {
            style: Object.assign({}, S.input, { width: '220px' }),
            value: pick,
            onChange: (e) => loadForm(e.target.value),
          },
            h('option', { value: 'global' }, '所有对话（全局）'),
            h('option', { value: 'workspace' }, '这个工作区'),
            h('option', { value: 'session' }, '这个对话'),
            h('option', { value: 'team' }, '这个团队')),
          layerItem.owner ? h('span', { style: Object.assign({}, S.dim, layerItem.owner === 'admin' ? S.warn : null) },
            '由' + (layerItem.owner === 'admin' ? '管理员' : '普通用户') + '设置') : null),
        wsPickUI, teamPickUI, sessPickUI,
        h('div', { style: Object.assign({ marginTop: '8px' }, S.dim) }, d.hint || ''))

      // ── 步骤2 设置项 ──
      const modelVal = fv('model.default') ?? ''
      const allowPaid = fv('billing.allowPaid') === true
      const confirmEachTurn = fv('billing.confirmEachTurn') !== false
      const autoSwitch = fv('routing.autoSwitch') !== false
      const priority = fv('routing.priority') || 'free-first'
      const budgetP = fv('budget.perCallCNY') == null ? '' : fv('budget.perCallCNY')
      const budgetD = fv('budget.dailyCNY') == null ? '' : fv('budget.dailyCNY')
      const budgetM = fv('budget.monthlyCNY') == null ? '' : fv('budget.monthlyCNY')

      // 渠道开关（编辑层语义：sources.disabled 黑名单 / sources.enabled 白名单）
      const chanOn = (id) => {
        const src = (form && form.sources) || {}
        const disabledList = Array.isArray(src.disabled) ? src.disabled : []
        const enabledList = Array.isArray(src.enabled) ? src.enabled : []
        if (disabledList.includes(id)) return false
        if (enabledList.length > 0 && !enabledList.includes(id)) return false
        return true
      }
      const setChan = (id, on) => setForm((f) => {
        const next = JSON.parse(JSON.stringify(f || {}))   // 深拷贝编辑底稿
        const src = next.sources = (next.sources || {})
        const disabledList = (Array.isArray(src.disabled) ? src.disabled : []).filter((x) => x !== id)
        const enabledList = (Array.isArray(src.enabled) ? src.enabled : []).filter((x) => x !== id)
        if (on) {
          if (enabledList.length > 0) src.enabled = enabledList
          else delete src.enabled
        } else {
          disabledList.push(id)
          src.disabled = disabledList
          if (enabledList.length > 0) src.enabled = enabledList
          else delete src.enabled
        }
        if (src.disabled.length === 0) delete src.disabled
        if (!src.disabled && !src.enabled) delete next.sources
        return next
      })
      const chanBadge = (c) => {
        if (c.state === 'cooling') return h('span', { style: S.badge('warn') }, '冷却中')
        if (c.state === 'failed') {
          const reason = c.blacklistKind ? KIND_TEXT[c.blacklistKind] || c.blacklistKind : ('失败 ' + (c.failCount || 0) + ' 次')
          return h('span', { style: S.badge('warn') }, c.blacklisted ? '已暂停（' + reason + '）' : reason)
        }
        return h('span', { style: S.badge('good') }, '正常')
      }

      // ── 需求 #6：展示开关（sources.hidden）+ 模型选择器过滤 ──
      // 语义提醒：隐藏 ≠ 禁用。隐藏只影响「选模型的列表」，路由链/自动切换仍然可用这个渠道。
      const effSources = (effConfig && effConfig.sources) || {}
      /** 当前生效的「不展示」清单（编辑底稿优先，还没动过就用后端生效值） */
      const hiddenNow = () => {
        const src = (form && form.sources) || null
        if (src && Array.isArray(src.hidden)) return src.hidden
        return Array.isArray(effSources.hidden) ? effSources.hidden : []
      }
      const hiddenOn = (id) => !hiddenNow().includes(id)
      const setHidden = (id, on) => setForm((f) => {
        const next = JSON.parse(JSON.stringify(f || {}))
        const src = next.sources = (next.sources || {})
        const base = (Array.isArray(src.hidden) ? src.hidden : (Array.isArray(effSources.hidden) ? effSources.hidden : []))
          .filter((x) => x !== id)
        const list = on ? base : base.concat([id])
        // 🔴 「全部展示」必须写成**显式空数组 `[]`**，不能删键。
        //    后端约定（store.js#resolveHiddenSources）：键不存在 ⇒ 套用默认隐藏集合；
        //    键存在 ⇒ 绝对口径（`[]` = 全部展示）。删键会让用户刚点开的渠道
        //    立刻又被默认集合盖回去（点了没反应 = 最难查的一类 bug）。
        src.hidden = list
        return next
      })
      // 只把「选择器里允许出现」的来源喂给模型下拉（hidden:true 的条目在这里就被挡掉）
      const modelsVisible = visibleModelSources(models, hiddenNow())

      /** 通用小开关（40×20）：on 绿 off 灰；禁用时**不给 onClick**（不装假按钮） */
      const minToggle = (on, onClick, off, key) => h('span', {
        onClick: off ? undefined : onClick,
        style: {
          cursor: off ? 'not-allowed' : 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center',
          width: '40px', height: '20px', borderRadius: '10px', flexShrink: 0, opacity: off ? 0.5 : 1,
          background: on ? 'var(--dsw-alias-state-success-primary)' : 'rgba(128,128,128,0.35)',
        },
        'data-toggle': key,
      }, h('span', {
        style: {
          display: 'block', width: '16px', height: '16px', borderRadius: '50%',
          background: '#fff', margin: '2px',
          transform: on ? 'translateX(20px)' : 'translateX(0)',
        },
      }))

      const lockedBanner = locked
        ? h('div', { style: Object.assign({}, S.card, { borderColor: 'rgba(220,160,40,0.5)', background: 'rgba(220,160,40,0.08)' }) },
            h('div', { style: { fontWeight: 600 } }, '🔒 此设置由管理员统一管理'),
            h('div', { style: Object.assign({ marginTop: '4px' }, S.dim) }, '这一层是管理员写的，普通用户只能查看，不能修改。如需调整请联系管理员。'))
        : null

      const step2 = h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '② 设置项（只改这一层：' + SETTINGS_LAYER_LABEL[pick] + '）'),
        lockedBanner,
        needsId && !locked ? h('div', { style: Object.assign({ marginBottom: '10px' }, S.dim, S.warn) },
          '先在上方填写该层的 ID，才能编辑并保存。') : null,

        // 默认模型
        h('div', { style: { marginBottom: '14px' } },
          h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, '默认用哪个模型'),
          h('div', { style: Object.assign({ marginBottom: '6px' }, S.dim) }, '不选 = 跟随自动路由。选了以后这一层优先用它。'),
          h('select', {
            style: Object.assign({}, S.input, { width: '320px', maxWidth: '100%' }),
            value: modelVal,
            disabled: disabled,
            onChange: (e) => fset('model.default', e.target.value || null),
          },
            h('option', { value: '' }, '跟随路由（不指定）'),
            modelsVisible.map((g) => h('optgroup', { key: g.provider, label: g.label },
              (g.models || []).map((m) => h('option', { key: g.provider + '/' + m.id, value: m.id }, m.name || m.id))))),
          h('div', { style: Object.assign({ marginTop: '4px' }, S.dim) },
            '这里只列 deepseek 系 / 自加 API / 免费可用渠道 / 华为云；其它渠道包不在这里出现'
            + (modelsVisible.length < models.length ? '（已按「不展示」过滤 ' + (models.length - modelsVisible.length) + ' 个）' : '') + '。'),
          sourceNote('model.default')),

        // 允许付费
        h('div', { style: { marginBottom: '14px' } },
          h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, '允许用付费模型吗'),
          h('div', { style: Object.assign({ marginBottom: '6px' }, S.dim) }, '关掉 = 永远只用免费模型，不会花一分钱。'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('span', {
              onClick: disabled ? undefined : () => fset('billing.allowPaid', !allowPaid),
              style: Object.assign({
                cursor: disabled ? 'not-allowed' : 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center',
                width: '44px', height: '22px', borderRadius: '11px', flexShrink: 0, opacity: disabled ? 0.5 : 1,
                background: allowPaid ? 'var(--dsw-alias-state-success-primary)' : 'rgba(128,128,128,0.35)',
              },
              ),
            }, h('span', {
              style: {
                display: 'block', width: '18px', height: '18px', borderRadius: '50%',
                background: '#fff', margin: '2px',
                transform: allowPaid ? 'translateX(22px)' : 'translateX(0)',
              },
            })),
            h('span', { style: { fontWeight: 600, color: allowPaid ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)' } },
              allowPaid ? '已开启' : '已关闭')),
          allowPaid ? h('div', { style: { marginTop: '8px' } },
            h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, '付费前要确认吗'),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
              h('span', {
                onClick: disabled ? undefined : () => fset('billing.confirmEachTurn', !confirmEachTurn),
                style: Object.assign({
                  cursor: disabled ? 'not-allowed' : 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center',
                  width: '44px', height: '22px', borderRadius: '11px', flexShrink: 0, opacity: disabled ? 0.5 : 1,
                  background: confirmEachTurn ? 'var(--dsw-alias-state-success-primary)' : 'rgba(128,128,128,0.35)',
                }),
              }, h('span', {
                style: {
                  display: 'block', width: '18px', height: '18px', borderRadius: '50%',
                  background: '#fff', margin: '2px',
                  transform: confirmEachTurn ? 'translateX(22px)' : 'translateX(0)',
                },
              })),
              h('span', { style: { fontWeight: 600, color: confirmEachTurn ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)' } },
                confirmEachTurn ? '每次都要问我' : '不问，直接用'))) : null,
          sourceNote('billing.allowPaid')),

        // 自动切换
        h('div', { style: { marginBottom: '14px' } },
          h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, '模型用不上时自动换吗'),
          h('div', { style: Object.assign({ marginBottom: '6px' }, S.dim) }, '开着 = 当前渠道失败时自动试下一个（省钱优先）。'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('span', {
              onClick: disabled ? undefined : () => fset('routing.autoSwitch', !autoSwitch),
              style: Object.assign({
                cursor: disabled ? 'not-allowed' : 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center',
                width: '44px', height: '22px', borderRadius: '11px', flexShrink: 0, opacity: disabled ? 0.5 : 1,
                background: autoSwitch ? 'var(--dsw-alias-state-success-primary)' : 'rgba(128,128,128,0.35)',
              }),
            }, h('span', {
              style: {
                display: 'block', width: '18px', height: '18px', borderRadius: '50%',
                background: '#fff', margin: '2px',
                transform: autoSwitch ? 'translateX(22px)' : 'translateX(0)',
              },
            })),
            h('span', { style: { fontWeight: 600, color: autoSwitch ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)' } },
              autoSwitch ? '自动换' : '不换，失败就报错')),
          autoSwitch ? h('div', { style: { marginTop: '8px' } },
            h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, '自动换时优先顺序'),
            h('select', {
              style: Object.assign({}, S.input, { width: '260px' }),
              value: priority, disabled: disabled,
              onChange: (e) => fset('routing.priority', e.target.value),
            }, PRIORITY_OPTIONS.map((o) => h('option', { key: o.v, value: o.v }, o.t)))) : null,
          sourceNote('routing.autoSwitch')),

        // 预算
        h('div', { style: { marginBottom: '14px' } },
          h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, '预算上限（元；超出就停）'),
          h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '6px' } },
            h('div', null,
              h('div', { style: Object.assign({ marginBottom: '2px' }, S.dim) }, '单次请求'),
              h('input', { type: 'number', min: 0, step: 0.1, style: Object.assign({}, S.input, { width: '100px' }), value: budgetP, disabled, placeholder: '1', onChange: (e) => fset('budget.perCallCNY', e.target.value === '' ? null : Number(e.target.value)) })),
            h('div', null,
              h('div', { style: Object.assign({ marginBottom: '2px' }, S.dim) }, '每天'),
              h('input', { type: 'number', min: 0, step: 0.1, style: Object.assign({}, S.input, { width: '100px' }), value: budgetD, disabled, placeholder: '10', onChange: (e) => fset('budget.dailyCNY', e.target.value === '' ? null : Number(e.target.value)) })),
            h('div', null,
              h('div', { style: Object.assign({ marginBottom: '2px' }, S.dim) }, '每月'),
              h('input', { type: 'number', min: 0, step: 0.1, style: Object.assign({}, S.input, { width: '100px' }), value: budgetM, disabled, placeholder: '100', onChange: (e) => fset('budget.monthlyCNY', e.target.value === '' ? null : Number(e.target.value)) }))),
          sourceNote('budget.perCallCNY')),

        // 渠道清单：状态 / 可用 / 是否展示（需求 #6：设置页表格要能看清「可用 / 是否展示 / 状态」）
        h('div', null,
          h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, '哪些渠道可用'),
          h('div', { style: Object.assign({ marginBottom: '6px' }, S.dim) },
            '「可用」关掉 = 不再被自动调用；「展示」关掉 = 只是不在选模型的列表里出现（隐藏 ≠ 禁用，链路照旧可用这个渠道）。状态是实时体检结果。'),
          channels.length === 0
            ? h('div', { style: S.dim }, '（后端未返回渠道清单）')
            : h('div', null,
                h('div', { style: Object.assign({}, S.row, { fontWeight: 600 }) },
                  h('span', { style: { flex: '1 1 42%' } }, '渠道'),
                  h('span', { style: { flex: '1 1 30%' } }, '状态'),
                  h('span', { style: { flex: '0 0 76px', textAlign: 'right' } }, '可用'),
                  h('span', { style: { flex: '0 0 76px', textAlign: 'right' } }, '展示')),
                channels.map((c) => h('div', {
                  key: c.id, style: Object.assign({}, S.row, { alignItems: 'center' }),
                  'data-channel-row': c.id,
                },
                  h('span', { style: { flex: '1 1 42%', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                    h('span', null, c.name || c.label || c.id),
                    chanBadge(c),
                    (!c.loggedIn && c.loginVerified !== true) ? h('span', { style: S.badge('warn') }, '未登录') : null,
                    c.hidden === true && hiddenOn(c.id) ? h('span', { style: S.badge() }, '默认不展示') : null),
                  h('span', { style: Object.assign({ flex: '1 1 30%' }, S.dim) },
                    (typeof c.status === 'string' && c.status ? c.status : (c.available === false ? '不可用' : '可用'))
                    + (c.available === false && c.reason ? '（' + c.reason + '）' : '')),
                  h('span', { style: { flex: '0 0 76px', display: 'flex', justifyContent: 'flex-end' } },
                    minToggle(chanOn(c.id), () => setChan(c.id, !chanOn(c.id)), disabled, 'usable:' + c.id)),
                  h('span', { style: { flex: '0 0 76px', display: 'flex', justifyContent: 'flex-end' } },
                    minToggle(hiddenOn(c.id), () => setHidden(c.id, !hiddenOn(c.id)), disabled, 'hidden:' + c.id)))),
                h('div', { style: Object.assign({ marginTop: '6px' }, S.dim) },
                  '「展示」写进这一层的 sources.hidden（对话里的选模型列表按它过滤）。')),
          sourceNote('sources.disabled')),

        // 新增三张卡（都在本层表单里，保存走统一的 diffPatch → POST /settings）
        h('div', { style: { marginTop: '14px' } },
          h(SearchSettingsCard, { fv, fset, disabled, sourceNote })),
        h('div', { style: { marginTop: '12px' } },
          h(VisionSettingsCard, { fv, fset, disabled })),
        h('div', { style: { marginTop: '12px' } },
          h(SubagentRoutingCard, { fv, fset, disabled, models: modelsVisible })),
        h('div', { style: { marginTop: '12px' } },
          h(ContextBridgeCard, { fv, fset, disabled })),
      )

      // ── 步骤3 实时状态（只读）──
      const chainTiers = (stData.chain && stData.chain.tiers) || []
      const gate = (stData.routing && stData.routing.gate) || {}
      const coolingChannels = Object.entries(gate)
        .filter(([, g]) => Number(g.coolingMs) > 0)
        .map(([id, g]) => ({ id, coolingMs: Number(g.coolingMs) }))
      const failCodes = failures.byCode || {}

      const step3 = h('div', null,
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '最近 5 次请求'),
          recent.length === 0
            ? h('div', { style: S.dim }, '还没有调用记录（用本插件跑一次对话后这里会有数据）')
            : recent.map((r, i) => h('div', { key: i, style: Object.assign({}, S.row, { fontSize: '12px' }) },
                h('span', null,
                  (r.ok ? '✅ ' : '❌ ') + (r.provider || '?') + (r.model ? ' / ' + r.model : ''),
                  r.ok ? null : h('span', { style: Object.assign({ marginLeft: '6px' }, S.warn) }, KIND_TEXT[r.code] || r.code || '失败')),
                h('span', { style: S.dim }, (r.ms != null ? r.ms + 'ms' : '—') + ' · ' + (r.at ? new Date(r.at).toLocaleTimeString() : ''))))),

        // 火山方舟余额（三分支：实时 / 估算 / 查询失败；文案由 ArkCard 统一管，避免两处口径漂移）
        h(ArkCard, { ark: ark, onRefresh: () => setArkTick((n) => n + 1) }),

        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, cursor: 'pointer' }, onClick: () => setAdvOpen(!advOpen) },
            (advOpen ? '▾ ' : '▸ ') + '高级（技术细节）'),
          advOpen ? h('div', { style: { marginTop: '8px' } },
            h('div', { style: { fontWeight: 500, marginBottom: '4px' } }, '降级链'),
            chainTiers.length === 0
              ? h('div', { style: S.dim }, '（无候选链数据；到「降级链」页查看）')
              : chainTiers.map((t, i) => h('div', { key: i, style: S.row },
                  h('span', null, '第 ' + t.tier + ' 层'),
                  h('span', { style: S.dim }, (t.providers || []).join(' → ') || '—'))),
            h('div', { style: { fontWeight: 500, margin: '10px 0 4px' } }, '冷却中的渠道'),
            coolingChannels.length === 0
              ? h('div', { style: S.dim }, '（当前没有渠道在冷却）')
              : coolingChannels.map((c) => h('div', { key: c.id, style: S.row },
                  h('span', null, c.id),
                  h('span', { style: S.dim }, Math.round(c.coolingMs / 1000) + ' 秒后恢复'))),
            h('div', { style: { fontWeight: 500, margin: '10px 0 4px' } }, '失败分类（按原因）'),
            Object.keys(failCodes).length === 0
              ? h('div', { style: S.dim }, '（账本暂无失败记录）')
              : Object.entries(failCodes).map(([code, n]) => h('div', { key: code, style: S.row },
                  h('span', null, KIND_TEXT[code] || code),
                  h('span', { style: S.dim }, n + ' 次'))),
            h('div', { style: { marginTop: '10px' } },
              typeof props.onGoTab === 'function'
                ? h('button', { style: S.btn(false), onClick: () => props.onGoTab('diag') }, '去「诊断」页一键体检')
                : h('a', { style: S.link, href: API }, '打开诊断（另开设置页）')))
          : null),
      )

      // ── 保存条 + 步骤3 ──
      // 需求 #5：工作区/对话/团队作用域顶部先给「与全局不同（N 项）」；全局层自己没有"跟谁不同"
      const diffPanel = pick === 'global' ? null : h(GlobalDiffPanel, {
        scope: pick,
        diffs: globalDiffs,
        sourceOf,
        onRestore: restoreGlobal,
        busy,
        disabled: locked || needsId || busy,
      })
      return h('div', null,
        diffPanel,
        step1,
        step2,
        h('div', { style: Object.assign({}, S.card, { borderColor: 'rgba(64,160,96,0.4)', background: 'rgba(64,160,96,0.06)', position: 'sticky', bottom: '8px', zIndex: 5 }) },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
            h('button', {
              style: Object.assign({}, S.primaryBtn, disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
              disabled: disabled,
              onClick: disabled ? undefined : save,
            }, busy ? '保存中…' : '保存这一层'),
            h('span', { style: Object.assign({}, S.dim, msg && msg.ok ? S.good : (msg && !msg.ok ? S.bad : null)) },
              msg ? (msg.text || msg.warn || msg.error) : '改动只写进这一层；没改的字段继续继承上一层的值。'))),
        h('div', { style: { marginTop: '12px' } }, step3),

        // ── design/21 §4：并发与冷却（人类语言；未设 = 用各渠道默认）──
        h('div', { style: { marginTop: '16px', borderTop: '1px solid rgba(128,128,128,0.18)', paddingTop: '12px' } },
          h('div', { style: { fontWeight: 600, marginBottom: '2px' } }, '并发与冷却'),
          h('div', { style: Object.assign({ marginBottom: '8px' }, S.dim) }, '不填 = 用默认值。改完点上面的「保存这一层」。'),
          h('div', { style: S.card },
            h('div', { style: { fontWeight: 500, marginBottom: '3px' } }, '同时最多几个请求（按渠道）'),
            h('div', { style: Object.assign({ marginBottom: '6px' }, S.dim) }, '限制并发，避免上游「会话已满」。数字越小越保守。'),
            channels.length === 0
              ? h('div', { style: S.dim }, '（后端未返回渠道清单）')
              : channels.map((c) => h('div', { key: c.id, style: Object.assign({}, S.row, { alignItems: 'center' }) },
                  h('span', null, c.label || c.id),
                  h('input', {
                    type: 'number', min: 1, step: 1,
                    style: Object.assign({}, S.input, { width: '72px' }),
                    value: (form && form.sources && form.sources.limits && form.sources.limits[c.id] != null) ? form.sources.limits[c.id] : '',
                    disabled: disabled,
                    placeholder: '默认',
                    onChange: (e) => fset('sources.limits.' + c.id, e.target.value === '' ? null : Math.max(1, Math.round(Number(e.target.value)))),
                  }))),
            h('div', { style: { fontWeight: 500, margin: '10px 0 3px' } }, '失败后等多久再试（秒）'),
            h('input', {
              type: 'number', min: 0, step: 1,
              style: Object.assign({}, S.input, { width: '140px' }),
              value: fv('routing.cooldownMs') == null ? '' : fv('routing.cooldownMs'),
              disabled: disabled,
              placeholder: '默认 15',
              onChange: (e) => fset('routing.cooldownMs', e.target.value === '' ? null : Number(e.target.value)),
            }),
            h('div', { style: { fontWeight: 500, margin: '10px 0 3px' } }, '被限流后等多久（秒）'),
            h('input', {
              type: 'number', min: 0, step: 1,
              style: Object.assign({}, S.input, { width: '140px' }),
              value: fv('routing.rateCooldownMs') == null ? '' : fv('routing.rateCooldownMs'),
              disabled: disabled,
              placeholder: '默认 4',
              onChange: (e) => fset('routing.rateCooldownMs', e.target.value === '' ? null : Number(e.target.value)),
            }))),

        // ── design/21 §1：保护策略 / 预算付费 / 省Token / 备份与恢复 并入设置（复用旧组件）──
        h('div', { style: { marginTop: '16px', borderTop: '1px solid rgba(128,128,128,0.18)', paddingTop: '12px' } },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '保护策略'),
          h(PolicyZone)),
        h('div', { style: { marginTop: '16px', borderTop: '1px solid rgba(128,128,128,0.18)', paddingTop: '12px' } },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '预算与付费'),
          h(BudgetZone)),
        h('div', { style: { marginTop: '16px', borderTop: '1px solid rgba(128,128,128,0.18)', paddingTop: '12px' } },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '省 Token'),
          h(SaverZone)),
        h('div', { style: { marginTop: '16px', borderTop: '1px solid rgba(128,128,128,0.18)', paddingTop: '12px' } },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '备份与恢复'),
          h(IoZone)),
      )
    }

    // ═══════════════════════════════════════════════════════════════════════
    // W2 模型与路由（design/21 §3）：自动路由可视化 + 手动降级链 + 渠道模型清单
    // ═══════════════════════════════════════════════════════════════════════
    // · 自动路由（只读展示生效值；调整入口在「设置」页）
    // · 手动降级链（复用旧 ChainZone；标注「自动路由开着时仅作候选排序参考」）
    // · 渠道模型清单：默认只显示 codearts + 免密源（kilo/ovh/pollinations），
    //   开关「显示全部渠道」展开其余账号渠道；每渠道带状态徽标。
    const MODELS_DEFAULT_PROVIDERS = new Set(['codearts', 'kilo', 'ovh', 'pollinations'])
    const PRIORITY_TEXT = {
      'free-first': '先免费（省钱优先）',
      balanced: '均衡（免费 + 付费混用）',
      'reliability-first': '稳定优先（多用付费）',
    }
    function ModelsZone(props) {
      const [st, reload] = useApi('/state')
      const [s, reloadS] = useApi('/settings')
      const [showAll, setShowAll] = react.useState(false)

      if (s.error) {
        return h('div', null,
          h(Err, { error: '读取失败：' + s.error }),
          h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
            h('button', { style: S.btn(true), onClick: () => { reload(); reloadS() } }, '重试')))
      }
      if (!s.data) return h('div', null, h(Loading, { on: true }))

      const eff = (st.data && st.data.config) || {}
      const autoOn = !(eff.routing && eff.routing.autoSwitch === false)
      const priority = (eff.routing && eff.routing.priority) || 'free-first'
      const priorityText = PRIORITY_TEXT[priority] || priority
      const groups = Array.isArray(s.data.models) ? s.data.models : []
      const statusById = {}
      for (const c of s.data.channels || []) statusById[c.id] = c
      // 需求 #6：后端判定的 hidden + 用户「不展示」一律不渲染（渲染兜底：展开「显示全部渠道」也不显示）
      const effCfg = (s.data.effective && s.data.effective.config) || {}
      const hiddenIds = Array.isArray(effCfg.sources && effCfg.sources.hidden) ? effCfg.sources.hidden : []
      const visibleGroups = visibleModelSources(groups, hiddenIds)
      // 「被『不展示』挡掉」≠「被白名单挡掉」：只数前者（如实说明，不把两种口径混成一句话）
      const hiddenCount = groups.length - groups.filter((g) => !isModelSourceHidden(g, hiddenIds)).length
      const shown = showAll
        ? visibleGroups
        : visibleGroups.filter((g) => g.kind === 'keyless' || MODELS_DEFAULT_PROVIDERS.has(g.provider))
      const stBadge = (id) => {
        const c = statusById[id]
        if (!c) return null
        if (c.state === 'ok') return h('span', { style: S.badge('good') }, '正常')
        if (c.state === 'cooling') return h('span', { style: S.badge('warn') }, '冷却中')
        return h('span', { style: S.badge('warn') },
          c.blacklisted ? '已暂停' + (c.blacklistKind ? '（' + (KIND_TEXT[c.blacklistKind] || c.blacklistKind) + '）' : '')
            : '失败 ' + (c.failCount || 0) + ' 次')
      }

      return h('div', null,
        // 自动路由卡片（只读展示生效值）
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '自动路由'),
          h('div', { style: Object.assign({ marginBottom: '6px' }, S.dim) },
            '开着 = 每次调用根据当前可用情况自动选渠道（免费优先、失败冷却、自动跳过不可用）。'),
          h('div', { style: S.row },
            h('span', null, '状态'),
            h('span', { style: { fontWeight: 600 } }, autoOn ? '开（自动选路）' : '关（按手动链）')),
          h('div', { style: S.row },
            h('span', null, '优先顺序'),
            h('span', { style: { fontWeight: 600 } }, priorityText)),
          typeof props.onGoTab === 'function'
            ? h('div', { style: { marginTop: '6px' } },
                h('button', { style: S.btn(false), onClick: () => props.onGoTab('settings') }, '去「设置」页调整'))
            : null),

        // 手动降级链（复用旧 ChainZone；标注语义）
        h('div', { style: { marginTop: '12px' } },
          h('div', { style: { fontWeight: 600, marginBottom: '2px' } }, '手动降级链（覆盖）'),
          h('div', { style: Object.assign({ marginBottom: '6px' }, S.dim) },
            autoOn
              ? '自动路由开着时，这份链只作为候选排序参考；关掉自动路由后按这份链逐个尝试。'
              : '自动路由已关：按这份链逐个尝试。'),
          h(ChainZone)),

        // 渠道与模型清单（默认过滤 + 显示全部开关）
        h('div', { style: { marginTop: '12px' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' } },
            h('div', { style: { fontWeight: 600 } }, '渠道模型'),
            h('button', { style: S.btn(false), onClick: () => setShowAll(!showAll) },
              showAll ? '只显示默认（华为 + 免密源）' : '显示全部渠道')),
          h('div', { style: Object.assign({ marginBottom: '8px' }, S.dim) },
            (showAll ? '已展开全部账号渠道的模型。' : '默认只显示华为云与免密源；点「显示全部渠道」可查看其它账号渠道。')
            + (hiddenCount > 0 ? '另有 ' + hiddenCount + ' 个渠道被「不展示」挡掉了（去「设置」页的「展示」开关里改）。' : '')),
          shown.length === 0
            ? h('div', { style: S.dim }, '（没有可显示的模型数据）')
            : shown.map((g) => h('div', { key: g.provider, style: S.card },
                h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '4px' } },
                  h('span', { style: { fontWeight: 600 } }, g.label),
                  stBadge(g.provider),
                  g.kind === 'channel-unlogged' ? h('span', { style: S.badge('warn') }, '未登录') : null),
                (g.models || []).length === 0
                  ? h('div', { style: S.dim }, '（暂无模型数据' + (g.error ? '；' + g.error : '') + '）')
                  : (g.models || []).map((m) => h('div', { key: m.id, style: Object.assign({}, S.row, { padding: '2px 0' }) },
                      h('span', { style: S.mono }, m.name || m.id),
                      h('span', { style: S.dim }, g.kind === 'channel-unlogged' ? '未登录' : '可用')))))),
        // 复杂路由基本规则（契约 B）：规则说明 + 实时统计 + 可编辑设置项。
        // ⚠️ 刻意**没有总开关**——这是解释面板，不是开关面板（用户明确要求）。
        // 放在页面最下面：上面三块是「要动手的事」，这一块是「想弄懂的时候看」。
        h(RoutingRulesCard, { rules: (st.data && st.data.routing && st.data.routing.rules) || null }),
      )
    }

    const ZONE_VIEWS = {
      overview: OverviewZone,
      sources: SourcesZone,
      models: ModelsZone,
      settings: SettingsPage,
    }
    // design/21 §1：旧组件源码保留（可复用/防回归），只是不再进 ZONES；
    // SettingsZone 即改造后的 SettingsPage（别名，供测试/外部引用）
    const SettingsZone = SettingsPage

    // ── 主设置页（含 Tab；design/21 §1：5 区）──
    function MyfreeSection() {
      // 默认入口 = 「设置」页（design/19 §2 延续：作用域设置是主入口）
      const [tab, setTab] = react.useState('settings')
      const View = ZONE_VIEWS[tab] || SourcesZone
      return h('div', { style: S.root },
        h('div', { style: S.h2 }, 'Myfree'),
        h('div', { style: S.sub }, '免费模型提供方 · 零第三方依赖 · 免密源开箱可用（默认链：Kilo / OVH；Pollinations 可选、默认未入链）'),
        h(CashCard),
        h('div', { style: S.tabs }, ZONES.map((z) => h('span', {
          key: z.id, style: S.tab(tab === z.key), onClick: () => setTab(z.key), title: z.id,
        }, z.label))),
        // key=tab：切分区时重建错误边界，避免一个分区崩了让所有分区一直显示错误页
        // viewProps.onGoTab：设置页「高级」区的诊断入口跳转
        h(Safe, { scope: tab, View: View, viewProps: { onGoTab: setTab } }),
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
    exports.SettingsPage = SettingsPage
    exports.SettingsZone = SettingsZone
    exports.ModelsZone = ModelsZone
    exports.CashCard = CashCard
    // design/21 §6：旧组件源码保留（供复用/防回归），一并导出便于测试断言
    exports.CatalogZone = CatalogZone
    exports.ChainZone = ChainZone
    exports.PinZone = PinZone
    exports.HealthZone = HealthZone
    exports.PolicyZone = PolicyZone
    exports.BudgetZone = BudgetZone
    exports.SaverZone = SaverZone
    exports.ObserveZone = ObserveZone
    exports.IoZone = IoZone
    exports.ScopeZone = ScopeZone
    exports.DiagZone = DiagZone
    exports.CashChip = CashChip
    // 2026-11 新增的四张设置卡 + 路由规则区块（导出便于 UI 单测直接断言文案与禁用态）
    exports.ArkCard = ArkCard
    exports.SearchSettingsCard = SearchSettingsCard
    exports.VisionSettingsCard = VisionSettingsCard
    exports.SubagentRoutingCard = SubagentRoutingCard
    exports.ContextBridgeCard = ContextBridgeCard
    exports.RoutingRulesCard = RoutingRulesCard
    // 需求 #5/#6：差异面板 + 模型选择器可见性（导出便于 UI 单测直接断言）
    exports.GlobalDiffPanel = GlobalDiffPanel
    exports.diffAgainstGlobal = diffAgainstGlobal
    exports.dropField = dropField
    exports.isModelSourceVisible = isModelSourceVisible
    exports.visibleModelSources = visibleModelSources
    exports.Toggle = Toggle
    exports.spendRow = spendRow
    exports.ErrorBoundary = ErrorBoundary
    exports.Safe = Safe
    exports.ChannelCard = ChannelCard
    exports.QrCode = QrCode
    exports.__qrMatrix = qrMatrix   // 测试用：与参考实现逐模块对拍
    return module.exports
  },
})
