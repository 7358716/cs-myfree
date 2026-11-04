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

    const VERSION = '1.9.16'
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
          return h('div', { key, style: Object.assign({}, S.row, { marginTop: '6px', flexWrap: 'wrap', gap: '6px' }) },
            h('span', { style: { minWidth: 0, wordBreak: 'break-all', flex: '1 1 180px' } },
              (a.label || ch.label) + '  ' + (a.masked || ''),
              a.kind ? h('span', { style: Object.assign({ marginLeft: '6px' }, S.dim) }, '· ' + a.kind) : null),
            h('span', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' } },
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
            '全部续期' + (bulk && bulk.kind === 'refresh' && !bulk.finished ? ' ' + bulk.done + '/' + bulk.total : ''))),

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
        return h('div', { key: i, style: Object.assign({}, S.tile, {
          marginBottom: '6px', display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap',
          ...(e.disabled ? { opacity: 0.6 } : {}),
        }) },
          h('span', { style: Object.assign({}, S.mono, S.dim) }, '#' + (i + 1)),
          h('select', {
            style: Object.assign({}, S.input, { flex: '1 1 150px', minWidth: '120px' }),
            value: e.provider,
            onChange: (ev) => set(i, 'provider', ev.target.value),
            title: '渠道 / 免密源',
          }, providerOpts.map((o) => h('option', { key: o.value, value: o.value }, o.label))),
          h('select', {
            style: Object.assign({}, S.input, { flex: '1 1 200px', minWidth: '150px' }),
            value: e.model,
            onChange: (ev) => set(i, 'model', ev.target.value),
            title: '该渠道可用的模型',
          },
            modelMissing ? h('option', { value: e.model }, e.model + '（清单里没有，可能是旧值）') : null,
            ms.map((m) => h('option', { key: m.id, value: m.id }, m.name && m.name !== m.id ? (m.name + ' · ' + m.id) : m.id))),
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

        h('div', { style: { fontWeight: 600, margin: '14px 0 8px' } }, '降级链配置（全部用下拉选择）'),
        h('div', { style: S.dim }, 'T1 最先尝试，失败后依次降级。同 provider+model ⇒ 替换内置条目的 tier；新的 ⇒ 追加。留空的条目保存时会被忽略。'),

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
    exports.ChannelCard = ChannelCard
    exports.QrCode = QrCode
    exports.__qrMatrix = qrMatrix   // 测试用：与参考实现逐模块对拍
    return module.exports
  },
})
