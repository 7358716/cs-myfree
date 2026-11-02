#!/usr/bin/env node
/**
 * 免密池真实探测（联网）—— 这是「免费模型确实可用」的证据。
 *
 * 用法：node test/live/keyless-probe.mjs
 * 退出码 0 = 至少一个源可用
 */
import { probeAll, PRIORITY } from '../../src/pools/keyless/index.js'

const r = await probeAll()
console.log('=== 免密池真实探测 ===')
for (const x of r.results) {
  const flag = x.ok ? '✅' : '❌'
  console.log(`  ${flag} ${x.id.padEnd(14)} ${x.ok ? `${x.ms}ms  样本:"${x.sample}"` : `失败: ${x.error}`}`)
}
console.log(`\n  可用源: ${r.okCount}/${PRIORITY.length}  ${r.anyOk ? '⇒ 免费模型可用 ✅' : '⇒ 全部不可用 ❌'}`)
process.exit(r.anyOk ? 0 : 1)
