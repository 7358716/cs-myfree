import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBingRss, parseBingHtml, parseSogou, parseMwmbl, EXCLUDED, PARSERS } from '../src/search/sources.js'

test('解析 Bing RSS', () => {
  const xml = `<rss><channel><item><title>标题&amp;1</title><link>https://a.com/1</link><description>摘要</description></item></channel></rss>`
  const r = parseBingRss(xml)
  assert.equal(r.length, 1)
  assert.equal(r[0].url, 'https://a.com/1')
  assert.equal(r[0].title, '标题&1')
})
test('解析 Bing HTML', () => {
  const html = `<li class="b_algo"><h2><a href="https://b.com/2">标题2</a></h2><p>摘要2</p></li>`
  const r = parseBingHtml(html)
  assert.equal(r.length, 1)
  assert.equal(r[0].url, 'https://b.com/2')
  assert.equal(r[0].title, '标题2')
})
test('解析搜狗（含重定向链接）', () => {
  const html = `<div class="vrwrap"><a href="/link?url=abc">搜狗结果</a></div>`
  const r = parseSogou(html)
  assert.equal(r.length, 1)
  assert.ok(r[0].url.startsWith('https://www.sogou.com/link?url='))
})
test('解析 MWMBL 富文本数组（关键坑）', () => {
  const json = JSON.stringify([{ url: 'https://c.com', title: [{ value: '富', is_bold: true }, { value: '文本' }], extract: [{ value: '摘要' }] }])
  const r = parseMwmbl(json)
  assert.equal(r[0].title, '富文本', '数组必须拼成字符串')
  assert.equal(r[0].snippet, '摘要')
})
test('坏 JSON 不抛异常，返回空', () => {
  assert.deepEqual(parseMwmbl('not json'), [])
})
test('被剔除的源有记录原因', () => {
  assert.ok(EXCLUDED.baidu.includes('封锁'))
  assert.ok(EXCLUDED.ddg.includes('DNS'))
})
test('启用的源不含被剔除的', () => {
  for (const id of ['baidu', 'ddg', 'ddg-lite', 'dblp']) {
    assert.equal(id in PARSERS, false, `${id} 不应在启用列表`)
  }
})
test('每个启用源都有 url + parse', () => {
  for (const [id, s] of Object.entries(PARSERS)) {
    assert.equal(typeof s.url, 'function', id)
    assert.equal(typeof s.parse, 'function', id)
  }
})
