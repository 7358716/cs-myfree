/**
 * 契约 C（搜索 + 识图设置）测试 —— 多源真实搜索端点 + 设置往返
 *
 * 覆盖：
 *   · runMultiSourceSearch 正常返回（多源融合、每源体检、去重合并 seenIn）
 *   · 契约 C3：enabled=false ⇒ { ok:false, error:'搜索已关闭（设置里打开）' }
 *   · 契约 C3：超时 ⇒ timedOut=true 且**保留已返回的部分结果**（不整体报错）
 *   · sources 过滤（只跑指定的源 / 未知源单列 error 不整体失败）
 *   · 请求参数透传（maxResults / sources 走 body，缺省回落配置）
 *   · GET/POST /settings 对新增 search/vision 字段的读写往返
 *
 * 🔴 纪律：全部用注入的 fetchImpl，**绝不真联网**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerRoutes, PREFIX } from '../src/web/routes.js'
import { runMultiSourceSearch, RUN_CONCURRENCY, DEFAULTS } from '../src/web/search.js'
import { DEFAULTS as STORE_DEFAULTS } from '../src/config/store.js'

// ── 假 webServer / 假 req-res（与 routes.test.mjs 同款，保持测试风格一致）──────
function makeServer() {
  const routes = new Map()
  return {
    register: (r) => routes.set(r.path.replace(PREFIX, ''), r),
    get: (p) => routes.get(p),
    size: () => routes.size,
  }
}

async function call(server, path, { method = 'GET', body, headers = {}, remote = '127.0.0.1' } = {}) {
  const r = server.get(path)
  if (!r) throw new Error('no route ' + path)
  const res = {
    writeHead: (s, h) => { res._status = s; res._headers = h },
    end: (raw) => { try { res._body = JSON.parse(raw) } catch { res._body = raw } },
  }
  const req = {
    method,
    url: PREFIX + path,
    headers: Object.assign({ host: 'localhost:3080' }, headers),
    socket: { remoteAddress: remote },
    on: (ev, cb) => {
      if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
      if (ev === 'end') cb()
    },
  }
  await r.handler(req, res)
  return { status: res._status, body: res._body }
}

function makeState() {
  const store = { config: {}, chain: { chain: [] }, probe: null }
  return {
    readConfig: async (d) => store.config ?? d,
    writeConfig: async (v) => { store.config = v; return true },
    readChain: async (d) => store.chain ?? d,
    writeChain: async (v) => { store.chain = v; return true },
    readProbe: async (d) => store.probe ?? d,
    writeProbe: async (v) => { store.probe = v; return true },
    overview: async () => ({ exists: true, dir: '/tmp/x', files: [] }),
    _store: store,
  }
}

/** 临时 dshHome（设置往返用例用；不碰真实 ~/.dsh） */
function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'cs-myfree-sr-'))
  mkdirSync(join(dir, 'cs-myfree'), { recursive: true })
  return dir
}

// ── 源站固件（形状照抄 sources.js 里各解析器的实测样本）────────────────────
const RSS_BODY = `<rss><channel>
<item><title>Node.js 22 发布</title><link>https://nodejs.org/en/blog/announcing?utm_source=x&amp;utm_medium=y</link><description>带了 &lt;b&gt;新特性&lt;/b&gt;</description></item>
<item><title>第二条 RSS</title><link>https://example.com/rss-2</link><description>描述二</description></item>
</channel></rss>`

const MWMBL_BODY = JSON.stringify([
  { url: 'https://nodejs.org/en/blog/announcing', title: [{ value: 'MWMBL 同一条', is_bold: true }], extract: [{ value: '不同源的同一 URL' }] },
  { url: 'https://example.org/mwmbl', title: [{ value: 'MWMBL 独有' }], extract: [{ value: '摘要文字' }] },
])

const BING_HTML_BODY = `<ul>
<li class="b_algo"><h2><a href="https://example.net/bing">Bing 结果</a></h2><p>Bing 摘要</p></li>
</ul>`

const SOGOU_BODY = `<div class="vrwrap"><a href="https://www.sogou.com/link?url=abc">搜狗结果</a></div>`

const okBody = (text) => ({ ok: true, status: 200, text: async () => text })

/**
 * 按 URL 分派的假 fetch（并记录调用顺序）。
 * @param {string[]} log 记录被请求的 URL
 * @param {{hang?:string}} [o] hang = 该子串匹配的源永远不返回（只在收到 abort 时 reject）
 */
function makeFetch(log = [], o = {}) {
  return async (url, init = {}) => {
    log.push(url)
    if (o.hang && url.includes(o.hang)) {
      // 模拟真实 fetch 的 abort 行为：只有 signal 被 abort 才 reject
      return await new Promise((_resolve, reject) => {
        const s = init.signal
        if (s && typeof s.addEventListener === 'function') {
          s.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        }
      })
    }
    if (url.includes('format=rss')) return okBody(RSS_BODY)
    if (url.includes('api.mwmbl.org')) return okBody(MWMBL_BODY)
    if (url.includes('sogou.com')) return okBody(SOGOU_BODY)
    if (url.includes('bing.com/search')) return okBody(BING_HTML_BODY)
    throw new Error('unexpected url ' + url)
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 一、内核：runMultiSourceSearch
// ══════════════════════════════════════════════════════════════════════════

test('多源搜索：正常返回（融合结果 + 每源体检报告）', async () => {
  const log = []
  const r = await runMultiSourceSearch({
    q: 'node 22',
    sources: ['bing-rss', 'bing-html', 'sogou', 'mwmbl'],
    maxResults: 5,
    budgetMs: 5000,
    fetchImpl: makeFetch(log),
  })
  assert.equal(r.ok, true)
  assert.equal(r.q, 'node 22')
  assert.equal(typeof r.at, 'number')
  assert.equal(r.budgetMs, 5000)
  assert.equal(r.timedOut, false)
  // 每源一条体检（4 个源全跑）
  assert.equal(log.length, 4)
  assert.deepEqual(r.sources.map((s) => s.id), ['bing-rss', 'bing-html', 'sogou', 'mwmbl'])
  for (const s of r.sources) {
    assert.equal(s.ok, true, `${s.id} 应成功`)
    assert.equal(s.error, null)
    assert.equal(typeof s.ms, 'number')
    assert.ok(s.count > 0, `${s.id} 应有条目`)
  }
  // 融合后：两条 URL 归一相同（nodejs.org 那条被 rss+mwmbl 同时命中）⇒ 合并
  assert.ok(r.total >= 4, '应有 4 条以上结果，实际 ' + r.total)
  assert.equal(r.total, r.results.length)
  const first = r.results[0]
  assert.deepEqual(Object.keys(first).sort(), ['seenIn', 'snippet', 'source', 'title', 'url'])
  assert.equal(typeof first.title, 'string')
  assert.match(first.url, /^https?:\/\//)
  assert.equal(typeof first.snippet, 'string')
  assert.equal(typeof first.source, 'string')
  // 归一化生效：utm_* 被剥掉、跨源同 URL 只留一条
  const node = r.results.filter((x) => x.url.startsWith('https://nodejs.org/en/blog/announcing'))
  assert.equal(node.length, 1, '同一 URL 跨源只留一条')
  assert.equal(node[0].url, 'https://nodejs.org/en/blog/announcing')
  assert.deepEqual(node[0].seenIn.sort(), ['bing-rss', 'mwmbl'])
})

test('契约 C3：超时 ⇒ timedOut=true 且保留已返回的部分结果', async () => {
  const log = []
  const t0 = Date.now()
  const r = await runMultiSourceSearch({
    q: 'node 22',
    sources: ['bing-rss', 'mwmbl'],
    budgetMs: 80,                       // 整轮预算极小
    fetchImpl: makeFetch(log, { hang: 'api.mwmbl.org' }),
  })
  const elapsed = Date.now() - t0
  assert.equal(r.ok, true, '超时不是整体失败')
  assert.equal(r.timedOut, true)
  assert.ok(elapsed < 3000, '必须在预算附近返回，实际 ' + elapsed + 'ms')
  // 快的源保留了结果
  const rss = r.sources.find((s) => s.id === 'bing-rss')
  assert.equal(rss.ok, true)
  assert.ok(rss.count > 0)
  // 慢的源如实报超时
  const mw = r.sources.find((s) => s.id === 'mwmbl')
  assert.equal(mw.ok, false)
  assert.match(mw.error, /timeout/)
  assert.equal(mw.count, 0)
  // 部分结果仍然回给调用方（契约 C3）
  assert.ok(r.total >= 1, '超时也要有部分结果')
  assert.ok(r.results.every((x) => x.source === 'bing-rss'))
})

test('sources 过滤：只跑请求指定的源', async () => {
  const log = []
  const r = await runMultiSourceSearch({ q: 'x', sources: ['bing-rss'], fetchImpl: makeFetch(log), budgetMs: 5000 })
  assert.equal(log.length, 1, '只应请求 1 次，实际 ' + log.length)
  assert.match(log[0], /format=rss/)
  assert.deepEqual(r.sources.map((s) => s.id), ['bing-rss'])
  assert.equal(r.sources[0].ok, true)
})

test('未知源：单列一条 error，不拖垮整体', async () => {
  const log = []
  const r = await runMultiSourceSearch({ q: 'x', sources: ['bing-rss', 'baidu'], fetchImpl: makeFetch(log), budgetMs: 5000 })
  assert.equal(r.ok, true)
  const baidu = r.sources.find((s) => s.id === 'baidu')
  assert.equal(baidu.ok, false)
  assert.equal(baidu.error, '未知搜索源')
  assert.equal(log.length, 1, '未知源不发起请求')
  // 全是未知源 ⇒ 整体报错，且列出可用源
  const bad = await runMultiSourceSearch({ q: 'x', sources: ['nope'], fetchImpl: makeFetch([]), budgetMs: 1000 })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /没有可用的搜索源/)
})

test('缺查询词 / 无 fetch ⇒ ok:false（不抛）', async () => {
  const a = await runMultiSourceSearch({ q: '   ', fetchImpl: makeFetch([]) })
  assert.equal(a.ok, false)
  assert.match(a.error, /缺少查询词/)
  const b = await runMultiSourceSearch({ q: 'x', fetchImpl: null })
  assert.equal(b.ok, false)
  assert.match(b.error, /fetch/)
})

test('受控并发 ≤2（慢源不占满全部名额）', async () => {
  assert.equal(RUN_CONCURRENCY, 2, '契约 C3：并发 ≤2')
  const log = []
  let inflight = 0
  let peak = 0
  const fetchImpl = async (url) => {
    log.push(url)
    inflight++
    peak = Math.max(peak, inflight)
    await new Promise((r) => setTimeout(r, 10))
    inflight--
    return okBody(RSS_BODY)
  }
  const r = await runMultiSourceSearch({ q: 'x', sources: ['bing-rss', 'bing-html', 'sogou', 'mwmbl'], fetchImpl, budgetMs: 5000 })
  assert.equal(r.sources.length, 4)
  assert.ok(peak <= 2, '同时在途请求不得超过 2，实际 ' + peak)
})

// ══════════════════════════════════════════════════════════════════════════
// 二、端点：POST /cs-myfree/search/run
// ══════════════════════════════════════════════════════════════════════════

const base = (over = {}) => Object.assign({
  state: makeState(),
  version: 'test',
  trustedHosts: [],
  getChain: () => [],
  getConfig: () => ({}),
  fetchImpl: makeFetch([]),
}, over)

test('端点 /search/run：正常返回契约 C3 形状', async () => {
  const srv = makeServer()
  registerRoutes(srv, base({
    getConfig: () => ({ search: { enabled: true, sources: ['bing-rss', 'mwmbl'], budgetMs: 5000, maxResults: 8 } }),
    fetchImpl: makeFetch([]),
  }))
  const r = await call(srv, '/search/run', { method: 'POST', body: { q: 'node 22' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.deepEqual(
    Object.keys(r.body).sort(),
    ['at', 'budgetMs', 'ok', 'q', 'results', 'sources', 'timedOut', 'total'],
  )
  assert.equal(r.body.budgetMs, 5000, '预算来自 cfg.search.budgetMs')
  assert.deepEqual(r.body.sources.map((s) => s.id), ['bing-rss', 'mwmbl'], '缺省用 cfg.search.sources')
  assert.ok(r.body.total > 0)
})

test('契约 C3：enabled=false ⇒ 原样文案「搜索已关闭（设置里打开）」', async () => {
  const log = []
  const srv = makeServer()
  registerRoutes(srv, base({
    getConfig: () => ({ search: { enabled: false, sources: ['bing-rss'] } }),
    fetchImpl: makeFetch(log),
  }))
  const r = await call(srv, '/search/run', { method: 'POST', body: { q: 'node 22' } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: false, error: '搜索已关闭（设置里打开）' })
  assert.equal(log.length, 0, '关闭时不得发起任何请求')
})

test('端点 /search/run：body 覆盖 maxResults 与 sources', async () => {
  const log = []
  const srv = makeServer()
  registerRoutes(srv, base({
    getConfig: () => ({ search: { enabled: true, sources: ['bing-rss', 'bing-html', 'sogou'], budgetMs: 5000, maxResults: 8 } }),
    fetchImpl: makeFetch(log),
  }))
  const r = await call(srv, '/search/run', { method: 'POST', body: { q: 'node', sources: ['bing-rss'], maxResults: 1 } })
  assert.equal(r.body.ok, true)
  assert.deepEqual(r.body.sources.map((s) => s.id), ['bing-rss'])
  assert.equal(log.length, 1, '只打被指定的源')
  assert.equal(r.body.total, 1, 'maxResults=1 必须生效')
})

test('端点 /search/run：只接受 POST（GET 走不到）', async () => {
  const srv = makeServer()
  registerRoutes(srv, base())
  const r = await call(srv, '/search/run', { method: 'GET' })
  assert.equal(r.status, 405)
})

test('契约 C2：缓存 TTL / 限流阈值从配置读（默认值保持旧行为）', async () => {
  // 默认配置 ⇒ 与旧的写死值一致（DEFAULTS 两处必须对齐，否则 /search 行为悄悄变了）
  assert.equal(STORE_DEFAULTS.search.cacheTtlMs, DEFAULTS.ttlMs, 'store 默认 TTL 必须等于 search.js 默认')
  assert.equal(STORE_DEFAULTS.search.ratePerMin, DEFAULTS.perMin, 'store 默认限流必须等于 search.js 默认')
  // 配置改小限流阈值 ⇒ 第 2 次同源请求被限流（证明调用方真的把 cfg 传进去了）
  const log = []
  const srv = makeServer()
  registerRoutes(srv, base({
    getConfig: () => ({ search: { enabled: true, sources: ['bing-rss'], budgetMs: 5000, ratePerMin: 1 } }),
    fetchImpl: makeFetch(log),
  }))
  const a = await call(srv, '/search/run', { method: 'POST', body: { q: 'a' } })
  assert.equal(a.body.sources[0].ok, true)
  const b = await call(srv, '/search/run', { method: 'POST', body: { q: 'b' } })
  assert.equal(b.body.sources[0].ok, false)
  assert.match(b.body.sources[0].error, /rate limited/)
})

test('契约 C4：现有 POST /search（单 URL fetch）仍可用且不走 /search/run', async () => {
  const log = []
  const srv = makeServer()
  registerRoutes(srv, base({
    fetchImpl: async (url) => { log.push(url); return okBody('hello') },
  }))
  const r = await call(srv, '/search', { method: 'POST', body: { url: 'https://example.test/page' } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.ok, true)
  assert.equal(r.body.body, 'hello')
  assert.deepEqual(log, ['https://example.test/page'], '单 URL 直取，不做多源')
  // 缓存生效（同一 URL 第二次 cached=true）——证明 searchTools 的缓存仍挂在 /search 上
  const r2 = await call(srv, '/search', { method: 'POST', body: { url: 'https://example.test/page' } })
  assert.equal(r2.body.cached, true)
})

// ══════════════════════════════════════════════════════════════════════════
// 三、设置往返：search / vision 新增字段
// ══════════════════════════════════════════════════════════════════════════

test('/settings 往返：search + vision 新字段可读可写（契约 C1）', async () => {
  const home = makeHome()
  try {
    const srv = makeServer()
    registerRoutes(srv, Object.assign(base(), { dshHome: home, isAdmin: () => true, getSettingsContext: () => ({}) }))

    // 写：patch 任意路径（settings.js 已支持，这里断言真的落到配置里）
    const patch = {
      search: { enabled: false, budgetMs: 9000, cacheTtlMs: 60000, ratePerMin: 5, maxResults: 6, sources: ['bing-rss'] },
      vision: { mode: 'free-cloud', consented: true, maxImagesPerTurn: 2 },
    }
    const w = await call(srv, '/settings', { method: 'POST', body: { scope: 'global', patch } })
    assert.equal(w.status, 200)
    assert.equal(w.body.ok, true, JSON.stringify(w.body))
    assert.equal(w.body.effective.config.search.budgetMs, 9000)
    assert.equal(w.body.effective.config.search.enabled, false)
    assert.equal(w.body.effective.config.vision.consented, true)

    // 读：GET 回来的是同一份（不被 defaults 覆盖、也不丢字段）
    const g = await call(srv, '/settings')
    assert.equal(g.status, 200)
    const cfg = g.body.effective.config
    for (const [k, v] of Object.entries(patch.search)) {
      assert.deepEqual(cfg.search[k], v, `search.${k} 往返失败`)
    }
    assert.equal(cfg.vision.mode, 'free-cloud')
    assert.equal(cfg.vision.maxImagesPerTurn, 2)
    // 删字段恢复继承：{ search: { enabled: null } } ⇒ enabled 消失（回落 DEFAULTS.search.enabled）
    const d = await call(srv, '/settings', { method: 'POST', body: { scope: 'global', patch: { search: { enabled: null } } } })
    assert.equal(d.body.ok, true)
    assert.equal(d.body.effective.config.search.enabled, undefined, 'null = 删除该字段')
    assert.equal(d.body.effective.config.search.budgetMs, 9000, '其它字段不受影响')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
