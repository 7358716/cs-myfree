/**
 * cs-myfree — 作用域（全局 / 预设 / 会话）
 *
 * 优先级：会话 > 预设 > 全局（后者被前者覆盖）
 *
 * 存储：
 *   global : ~/.dsh/cs-myfree/config.json
 *   preset : ~/.dsh/cs-myfree/config.<presetId>.json
 *   session: ~/.dsh/cs-myfree/config.session.<sessionId>.json
 *
 * 设计理由：**不侵入宿主存储**，全部落在自己的目录，便于审计与清理。
 *
 * @module cs-myfree/config/scope
 */

import { readFile, writeFile, rename, mkdir, chmod, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const SCOPE = Object.freeze({ GLOBAL: 'global', PRESET: 'preset', SESSION: 'session' })

export function scopeDir(dshHome) {
  return join(dshHome || process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh'), 'cs-myfree')
}

/** 某作用域对应的文件名 */
export function scopeFile(dshHome, scope, id) {
  const dir = scopeDir(dshHome)
  if (scope === SCOPE.PRESET) {
    if (!id) throw new Error('预设作用域需要 presetId')
    return join(dir, `config.preset.${safe(id)}.json`)
  }
  if (scope === SCOPE.SESSION) {
    if (!id) throw new Error('会话作用域需要 sessionId')
    return join(dir, `config.session.${safe(id)}.json`)
  }
  return join(dir, 'config.json')
}

function safe(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
}

async function readJson(file, fallback = {}) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}

async function writeJson(file, obj) {
  const dir = file.slice(0, file.lastIndexOf('/'))
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = `${dir}/.${Date.now()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, file)
    return true
  } catch {
    await unlink(tmp).catch(() => {})
    return false
  }
}

/** 深合并（对象递归，数组/标量替换） */
export function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over
  const out = Object.assign({}, base)
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v)
    } else out[k] = v
  }
  return out
}

/** 读单个作用域 */
export async function readScope(dshHome, scope, id) {
  try { return await readJson(scopeFile(dshHome, scope, id), {}) } catch { return {} }
}

/** 写单个作用域 */
export async function writeScope(dshHome, scope, id, obj) {
  try { return await writeJson(scopeFile(dshHome, scope, id), obj) } catch { return false }
}

/**
 * 计算**生效配置**：global ← preset ← session 逐层覆盖。
 * @param {{dshHome?:string, presetId?:string, sessionId?:string}} o
 */
export async function effectiveConfig(o = {}) {
  const { dshHome, presetId, sessionId } = o
  const global = await readScope(dshHome, SCOPE.GLOBAL)
  const preset = presetId ? await readScope(dshHome, SCOPE.PRESET, presetId) : {}
  const session = sessionId ? await readScope(dshHome, SCOPE.SESSION, sessionId) : {}
  return {
    config: deepMerge(deepMerge(global, preset), session),
    layers: {
      global: Object.keys(global).length,
      preset: Object.keys(preset).length,
      session: Object.keys(session).length,
    },
    ids: { presetId: presetId ?? null, sessionId: sessionId ?? null },
  }
}

/** 列出所有作用域文件（供 UI 展示与清理） */
export async function listScopes(dshHome) {
  const dir = scopeDir(dshHome)
  try {
    const names = await readdir(dir)
    return names.filter((n) => /^config(\.|$)/.test(n)).map((n) => ({ name: n, scope: n === 'config.json' ? 'global' : (n.includes('.preset.') ? 'preset' : 'session') }))
  } catch {
    return []
  }
}
