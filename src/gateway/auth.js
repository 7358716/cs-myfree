/**
 * cs-myfree — 网关鉴权（双门双钥 + 常数时间比较）
 *
 * 设计依据：v3 §10。ourfree 实测结论：
 *  · 本地门与 LAN 中继是**两个独立对象、两把不同的 key**
 *  · 比较必须 `timingSafeEqual`（防时序侧信道）
 *  · LAN 中继**每请求都鉴权**（`/health` 不豁免）
 *
 * @module cs-myfree/gateway/auth
 */

import { createHash, timingSafeEqual, randomBytes } from 'node:crypto'

/** 摘要化（避免把原 key 留在内存里做多次比较） */
export function digest(key) {
  return createHash('sha256').update(String(key ?? ''), 'utf8').digest()
}

/** 常数时间比较（长度不同直接 false，不泄露长度差异） */
export function safeEqual(a, b) {
  const da = digest(a)
  const db = digest(b)
  if (da.length !== db.length) return false
  return timingSafeEqual(da, db)
}

/** 生成网关 key */
export function generateKey(prefix = 'csmf') {
  return `${prefix}_${randomBytes(24).toString('base64url')}`
}

/**
 * 构造鉴权检查器。
 * @param {{localKey:string, lanKey?:string}} keys
 */
export function createAuthorizer(keys = {}) {
  const localKey = String(keys.localKey ?? '')
  const lanKey = String(keys.lanKey ?? '')

  return {
    /** 本地门：允许回环，鉴权可选（默认要求） */
    checkLocal(headers = {}, { requireKey = true } = {}) {
      if (!requireKey) return { ok: true }
      const got = bearerOf(headers)
      if (!got || !localKey) return { ok: false, reason: 'missing-or-unconfigured-key' }
      return safeEqual(got, localKey) ? { ok: true } : { ok: false, reason: 'bad-key' }
    },

    /** LAN 门：**每请求都鉴权**，无豁免 */
    checkLan(headers = {}) {
      if (!lanKey) return { ok: false, reason: 'lan-key-not-configured' }
      const got = bearerOf(headers)
      if (!got) return { ok: false, reason: 'missing-key' }
      return safeEqual(got, lanKey) ? { ok: true } : { ok: false, reason: 'bad-key' }
    },
  }
}

function bearerOf(headers = {}) {
  const h = headers.authorization ?? headers.Authorization ?? headers.AUTHORIZATION
  if (!h) return ''
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim())
  return m ? m[1].trim() : ''
}

/**
 * 监听地址校验：拒绝通配地址（ourfree 实测：0.0.0.0/:: 会被拒绝并跳过启动）。
 * @returns {{ok:boolean, reason?:string}}
 */
export function validateListenHost(host) {
  const h = String(host ?? '').trim()
  if (!h) return { ok: false, reason: '空地址' }
  if (h === '0.0.0.0' || h === '::' || h === '[::]') {
    return { ok: false, reason: '拒绝通配地址（会无鉴权暴露到所有网卡）' }
  }
  return { ok: true }
}
