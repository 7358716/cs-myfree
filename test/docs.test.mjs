/**
 * 文档页测试（手机浏览器直接打开 Markdown）
 *
 * 背景：用户反馈「我用手机浏览器打不开文档」。根因是交付报告只是服务器上的
 * .md 文件，没有任何 web 服务暴露它。本模块把 design/ 渲染成移动端友好的 HTML。
 *
 * 重点不是「能打开」，而是**只能打开该打开的**：越界必须 403。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { resolveDocPath, createDocsHandler, DOCS_PREFIX } from '../src/docs/serve.js'
import { renderMarkdown, wrapHtml, escapeHtml } from '../src/docs/markdown.js'

// ══════════════════════════════════════════════════════════════════════════
// 越界防御
// ══════════════════════════════════════════��═══════════════════════════════

test('🟥 resolveDocPath：`..` / 编码变体越界一律拒绝', () => {
  const root = resolve('/home/ubuntu/output2026/butlers/dev/design')
  for (const bad of [
    '/cs-myfree/docs/../etc/passwd',
    '/cs-myfree/docs/%2e%2e/etc/passwd',
    '/cs-myfree/docs/..%2f..%2fetc/passwd',
    '/cs-myfree/docs/a/../../../etc/passwd',
  ]) {
    assert.equal(resolveDocPath(root, bad), null, '必须拒绝：' + bad)
  }
})

test('🟥 resolveDocPath：前缀相近目录不算命中', () => {
  const root = resolve('/tmp/design')
  assert.equal(resolveDocPath(root, '/cs-myfree/docs/../design-evil/x.md'), null)
})

test('resolveDocPath：正常路径命中白名单', () => {
  const root = resolve('/tmp/design')
  assert.equal(resolveDocPath(root, '/cs-myfree/docs/a.md'), join(root, 'a.md'))
  assert.equal(resolveDocPath(root, '/cs-myfree/docs/'), root)
})

test('🟥 resolveDocPath：NUL 注入被拒', () => {
  assert.equal(resolveDocPath(resolve('/tmp/design'), '/cs-myfree/docs/a.md%00.png'), null)
})

// ══════════════════════════════════════════════════════════════════════════
// 渲染器
// ══════════════════════════════════════════════════════════════════════════

test('🟥 渲染器全量转义 HTML（script 不得变真标签）', () => {
  const html = renderMarkdown('<script>alert(1)</script>')
  assert.equal(html.includes('<script>'), false)
  assert.ok(html.includes('&lt;script&gt;'))
})

test('🟥 javascript: 链接不生成 <a>', () => {
  const html = renderMarkdown('[点我](javascript:alert(1))')
  assert.equal(html.includes('href="javascript:'), false)
  assert.equal(html.includes('<a '), false)
})

test('正常标题/表格/代码块/粗体渲染', () => {
  const html = renderMarkdown('# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nx<1\n```\n\n**粗**')
  assert.ok(html.includes('<h1>T</h1>'))
  assert.ok(html.includes('<th>a</th>'))
  assert.ok(html.includes('x&lt;1'), '代码块内也要转义')
  assert.ok(html.includes('<strong>粗</strong>'))
})

test('wrapHtml 带移动端 viewport（手机才能看清）', () => {
  assert.ok(wrapHtml({ title: 'x', body: 'y' }).includes('width=device-width'))
})

// ══════════════════════════════════════════════════════════════════════════
// 处理器行为
// ══════════════════════════════════════════════════════════════════════════

function mk() {
  const dir = mkdtempSync(join(tmpdir(), 'cs-myfree-docs-'))
  writeFileSync(join(dir, 'a.md'), '# 报告\n\n正文。')
  writeFileSync(join(dir, 'x.txt'), 'secret')
  writeFileSync(join(dir, '.hidden.md'), '# 隐藏')
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'b.md'), '# B')
  return dir
}
async function call(handler, url, { method = 'GET', host = 'localhost:3080' } = {}) {
  const res = { writeHead: (s, h) => { res._status = s; res._headers = h }, end: (b) => { res._body = b } }
  await handler({ method, url, headers: { host } }, res)
  return { status: res._status, headers: res._headers, body: String(res._body ?? '') }
}

test('目录列表：只列 .md，隐藏与非 md 不出现，子目录可点', async () => {
  const dir = mk()
  try {
    const h = createDocsHandler({ docsRoot: dir, allowDirs: [dir] })
    const r = await call(h, '/cs-myfree/docs/')
    assert.equal(r.status, 200)
    assert.ok(r.body.includes('a.md'))
    assert.ok(r.body.includes('sub'))
    assert.equal(r.body.includes('x.txt'), false, '非 md 不列')
    assert.equal(r.body.includes('.hidden.md'), false, '隐藏文件不列')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('打开 .md 渲染为移动端页面', async () => {
  const dir = mk()
  try {
    const h = createDocsHandler({ docsRoot: dir, allowDirs: [dir] })
    const r = await call(h, '/cs-myfree/docs/a.md')
    assert.equal(r.status, 200)
    assert.ok(r.headers['content-type'].includes('text/html'))
    assert.ok(r.body.includes('<h1>报告</h1>'))
    assert.ok(r.body.includes('viewport'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('子目录里的文件也能打开', async () => {
  const dir = mk()
  try {
    const h = createDocsHandler({ docsRoot: dir, allowDirs: [dir] })
    const r = await call(h, '/cs-myfree/docs/sub/b.md')
    assert.equal(r.status, 200)
    assert.ok(r.body.includes('<h1>B</h1>'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('🟥 越界读取 403（不能读到 properties 文件）', async () => {
  const dir = mk()
  try {
    const h = createDocsHandler({ docsRoot: dir, allowDirs: [dir] })
    assert.equal((await call(h, '/cs-myfree/docs/../accounts.json')).status, 403)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('非 md 403 / 不存在 404 / 非 GET 405', async () => {
  const dir = mk()
  try {
    const h = createDocsHandler({ docsRoot: dir, allowDirs: [dir] })
    assert.equal((await call(h, '/cs-myfree/docs/x.txt')).status, 403)
    assert.equal((await call(h, '/cs-myfree/docs/nope.md')).status, 404)
    assert.equal((await call(h, '/cs-myfree/docs/', { method: 'POST' })).status, 405)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('配置 trustedHosts 后，陌生 Host 被 403，本机仍放行', async () => {
  const dir = mk()
  try {
    const h = createDocsHandler({ docsRoot: dir, allowDirs: [dir], trustedHosts: ['150.158.175.241'] })
    assert.equal((await call(h, '/cs-myfree/docs/a.md', { host: 'evil.example.com' })).status, 403)
    assert.equal((await call(h, '/cs-myfree/docs/a.md', { host: '150.158.175.241' })).status, 200)
    assert.equal((await call(h, '/cs-myfree/docs/a.md', { host: 'localhost:3080' })).status, 200)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('docRoot 非法也不抛（不影响宿主启动）', async () => {
  const h = createDocsHandler({ docsRoot: '/tmp/definitely-not-exist-xyz', allowDirs: ['/tmp/definitely-not-exist-xyz'] })
  const r = await call(h, '/cs-myfree/docs/a.md')
  assert.equal(r.status, 404, '目录不存在应是 404，不是崩')
})

test('DOCS_PREFIX 常量与路由挂载一致', () => {
  assert.equal(DOCS_PREFIX, '/docs')
  assert.equal(escapeHtml('<a>'), '&lt;a&gt;')
})