import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUrl, fuseResults, toHostSources } from '../src/search/fuse.js'

test('剥追踪参数', () => {
  assert.equal(normalizeUrl('https://a.com/x?utm_source=1&id=2'), 'https://a.com/x?id=2')
})
test('去末尾斜杠', () => {
  assert.equal(normalizeUrl('https://a.com/x/'), 'https://a.com/x')
})
test('同一页不同追踪参数视为同一条', () => {
  const r = fuseResults([
    { source: 'bing-rss', items: [{ url: 'https://a.com/p?utm_source=x', title: 'A' }] },
    { source: 'sogou', items: [{ url: 'https://a.com/p', title: 'A2' }] },
  ])
  assert.equal(r.length, 1, '必须去重')
  assert.equal(r[0].seenIn.length, 2, 'seenIn 应记录两个源')
})
test('高权重源排前', () => {
  const r = fuseResults([
    { source: 'mwmbl', items: [{ url: 'https://low.com', title: 'L' }] },
    { source: 'bing-rss', items: [{ url: 'https://high.com', title: 'H' }] },
  ])
  assert.equal(r[0].url, 'https://high.com')
})
test('同域名不占满（轮转）', () => {
  const r = fuseResults([
    { source: 'bing-rss', items: [
      { url: 'https://same.com/1' }, { url: 'https://same.com/2' }, { url: 'https://same.com/3' },
    ]},
    { source: 'sogou', items: [{ url: 'https://other.com/1' }] },
  ], { max: 2 })
  const hosts = r.map((x) => new URL(x.url).host)
  assert.equal(new Set(hosts).size, 2, '前 2 条应来自不同域名')
})
test('max 生效', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ url: `https://a${i}.com/p` }))
  assert.equal(fuseResults([{ source: 'bing-rss', items }], { max: 5 }).length, 5)
})
test('空 URL 被丢弃', () => {
  assert.equal(fuseResults([{ source: 'x', items: [{ url: '' }, { url: null }] }]).length, 0)
})
test('toHostSources 每项都有 url', () => {
  for (const s of toHostSources([{ url: 'https://a.com', title: 'T' }])) assert.ok(s.url)
})
