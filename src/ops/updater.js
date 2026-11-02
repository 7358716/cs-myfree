/**
 * cs-myfree — 升级事务（签名校验 + 原子替换 + 可回滚）
 *
 * 设计依据：v3 §10 + ourfree 实测的两处**反直觉但正确**的设计：
 *  1. **先恢复再删多余** —— 否则一次被拒的拷贝会毁掉本可恢复的文件
 *  2. **备份缺失时必须防呆** —— 直接进删除循环会把包清空而进程还在内存里跑
 *  3. 恢复不全**必须抛 `rollback incomplete`**，不做可用性承诺
 *
 * @module cs-myfree/ops/updater
 */

import { createHash, verify as cryptoVerify, createPublicKey } from 'node:crypto'

/**
 * 校验签名。
 * ⚠️ 「验不了的签名等于没有签名」：
 *    任何畸形输入一律返回 false，**绝不降级放行**。
 */
export function verifySignature({ payload, signature, publicKeyPem, algorithm = 'sha256' }) {
  try {
    if (!payload || !signature || !publicKeyPem) return false
    const key = createPublicKey(publicKeyPem)
    const ok = cryptoVerify(algorithm, Buffer.from(payload), key, Buffer.from(signature, 'base64'))
    return ok === true
  } catch {
    return false     // 畸形输入 → false（不抛、不放行）
  }
}

/** 内容摘要（用于比对是否真的变了） */
export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 规划一次原子替换：目标 = `<file>.new` 同目录（保证同卷，rename 才原子）。
 * @returns {{tmpPath:string, finalPath:string, ok:boolean, reason?:string}}
 */
export function planAtomicReplace(filePath) {
  if (!filePath || typeof filePath !== 'string') return { ok: false, reason: '路径为空' }
  const dir = filePath.slice(0, filePath.lastIndexOf('/')) || '.'
  const base = filePath.slice(filePath.lastIndexOf('/') + 1)
  if (!base) return { ok: false, reason: '非法路径' }
  return { ok: true, tmpPath: `${dir}/.${base}.new`, finalPath: filePath }
}

/**
 * 规划回滚顺序。
 *
 * ⚠️ 关键：**先恢复备份，再删除多余文件**。
 *    反过来的话，一旦恢复阶段的某次拷贝被拒，
 *    已经把「本可恢复的文件」删掉了 ⇒ 数据丢失。
 *
 * @param {{backupFiles:string[], targetFiles:string[]}} o
 */
export function planRollback({ backupFiles = [], targetFiles = [] } = {}) {
  if (!Array.isArray(backupFiles) || backupFiles.length === 0) {
    // 防呆：没有备份就不能进删除阶段
    return { ok: false, reason: '备份缺失：拒绝执行删除阶段（否则会清空包而进程还在内存跑）', steps: [] }
  }
  const backups = new Set(backupFiles)
  const restore = [...backupFiles]
  const remove = targetFiles.filter((f) => !backups.has(f))
  return {
    ok: true,
    steps: [
      { phase: 'restore', files: restore },
      { phase: 'remove-extra', files: remove },
    ],
    strictOrder: true,
  }
}

/**
 * 生成回滚结果报告。
 * @param {{restored:string[], failed:string[], removed:string[]}} o
 */
export function rollbackResult({ restored = [], failed = [], removed = [] } = {}) {
  const complete = failed.length === 0
  return {
    complete,
    restored,
    failed,
    removed,
    // 明确不做可用性承诺
    message: complete
      ? `已完整回滚（恢复 ${restored.length} 个，删除 ${removed.length} 个）`
      : `rollback incomplete：${failed.length} 个文件恢复失败，**不要假设包可用**`,
  }
}
