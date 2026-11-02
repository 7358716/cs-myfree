import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compressToolOutput, createSavingsTracker, MIN_SIZE } from '../src/saver/rtk.js'

const big = (s, n = 100) => s.repeat(n)

test('错误结果永不压缩（关键边界）', () => {
  const r = compressToolOutput(big('diff --git a b\n+line\n'), { isError: true })
  assert.equal(r.applied, false)
  assert.match(r.reason, /错误结果/)
})
test('太小不压', () => {
  assert.equal(compressToolOutput('short').applied, false)
})
test('git diff 能压缩上下文行', () => {
  const src = 'diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1,20 +1,20 @@\n' + big(' context line\n', 50) + '+added\n'
  const r = compressToolOutput(src)
  assert.equal(r.applied, true)
  assert.ok(r.after < r.before)
  assert.equal(r.compressor, 'git-diff')
})
test('grep 结果按文件折叠', () => {
  const lines = []
  for (let i = 0; i < 150; i++) lines.push(`file.js:${i}:match`)
  const r = compressToolOutput(lines.join('\n'))
  assert.equal(r.applied, true)
  assert.match(r.text, /另有 147 处匹配/)
})
test('无收益时不改动（边界3）', () => {
  const src = big('x'.repeat(600) + '\n')
  const r = compressToolOutput(src)
  assert.equal(r.text, src, '内容必须原样返回')
})
test('未知形状不改动', () => {
  const src = big('随便什么内容\n', 200)
  assert.equal(compressToolOutput(src).applied, false)
})
test('超大输入直接跳过（防内存爆炸）', () => {
  const r = compressToolOutput('x'.repeat(11 * 1024 * 1024), { maxBytes: 100 })
  assert.equal(r.applied, false)
})
test('统计口径区分「0 次调用」与「省 0 字节」', () => {
  const t = createSavingsTracker()
  assert.match(t.summary().text, /尚未消耗/)
  t.record(100, 100)
  assert.match(t.summary().text, /1 次调用/)
  assert.equal(t.summary().savedBytes, 0)
})
test('统计累加正确', () => {
  const t = createSavingsTracker()
  t.record(1000, 400); t.record(500, 100)
  assert.equal(t.summary().savedBytes, 1000)
  assert.equal(t.summary().calls, 2)
})
test('MIN_SIZE 与 Rust 实现对齐', () => { assert.equal(MIN_SIZE, 500) })
