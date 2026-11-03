/**
 * cs-myfree — 配置存储（原子写 + 权限收口）
 *
 * 设计依据：v3 §3.4。三条要求：
 *  1. **原子写**：先写临时文件再 rename（崩溃不会留下半个配置）
 *  2. **权限 0600**：配置可能含源开关，不应被同机其他用户读
 *  3. **不存密钥**：本模块只存「策略」，凭据一律走宿主凭据库
 *
 * @module cs-myfree/config/store
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 原子写：同目录临时文件 → fsync 语义由 rename 保证 */
export async function atomicWrite(file, data, { mode = 0o600 } = {}) {
  const dir = dirname(file)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  try {
    await writeFile(tmp, body, { mode })
    await chmod(tmp, mode).catch(() => {})
    await rename(tmp, file)
    return { ok: true, path: file, bytes: Buffer.byteLength(body) }
  } catch (err) {
    await unlink(tmp).catch(() => {})
    return { ok: false, error: String(err?.message ?? err) }
  }
}

/** 读 JSON；损坏时返回 defaults（绝不抛，避免一个坏文件让插件不激活） */
export async function readJson(file, defaults = null) {
  try {
    const t = await readFile(file, 'utf8')
    return { ok: true, value: JSON.parse(t) }
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, value: defaults, missing: true }
    return { ok: false, value: defaults, error: String(err?.message ?? err) }
  }
}

/** 配置文件默认值 */
export const DEFAULTS = Object.freeze({
  schema: 'cs-myfree/config/v1',
  chain: { overrides: [] },
  budget: {
    // ⚠️ 不是 0：0 会让所有限额变死信（现状缺陷）
    perCallCNY: 1,
    dailyCNY: 10,
    monthlyCNY: 100,
  },
  paid: { enabled: false, allowAutoCall: false, confirmEachTurn: true },
  vision: { mode: 'off' },          // off | local | free-cloud | paid-cloud
  search: { sources: ['bing-rss', 'bing-html', 'sogou', 'mwmbl'], budgetMs: 15000 },
  sources: { disabled: [] },
})

/** 合并用户配置与默认值（深合并一层，数组整体替换） */
export function withDefaults(cfg = {}) {
  const out = { ...DEFAULTS }
  for (const [k, v] of Object.entries(cfg ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && DEFAULTS[k] && typeof DEFAULTS[k] === 'object' && !Array.isArray(DEFAULTS[k])) {
      out[k] = { ...DEFAULTS[k], ...v }
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * 敏感字段名（红线 #1/#2/#7：任何凭据都不得写进 config.json /
 * 也不得回给 UI）。
 *
 * `authorization` / `cookie` 也在此列：`transportHeaders` 这类嵌套对象
 * 很容易被用户/前端塞进 `Authorization: Bearer …`。
 */
export const SENSITIVE_KEY_RE = /(key|token|secret|password|passwd|authorization|cookie|credential)/i

/**
 * 递归查找敏感字段（返回第一个命中的路径，如 `transportHeaders.authorization`）。
 * @param {any} obj
 * @param {string} [path]
 * @returns {string|null}
 */
export function findSensitiveKey(obj, path = '') {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const hit = findSensitiveKey(obj[i], `${path}[${i}]`)
      if (hit) return hit
    }
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k
    if (SENSITIVE_KEY_RE.test(k)) return p
    const hit = findSensitiveKey(v, p)
    if (hit) return hit
  }
  return null
}

/**
 * 深拷贝并**剔除**敏感字段（读路径也用：磁盘上若有历史脏数据，
 * 绝不能通过 GET /config 回给 UI）。
 */
export function stripSensitive(obj) {
  if (Array.isArray(obj)) return obj.map((v) => stripSensitive(v))
  if (!obj || typeof obj !== 'object') return obj
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_RE.test(k)) continue
    out[k] = stripSensitive(v)
  }
  return out
}
