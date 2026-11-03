/**
 * cs-myfree — 渠道模型目录（登录后拉取该账号可用的模型）
 *
 * 解决的问题（主管反馈）：登录了渠道，但模型选择器里看不到该渠道的模型。
 *
 * 模型 id 规则：`<channelId>/<modelId>`
 *   例：`codearts/deepseek-v4.1-flash`
 * 原因：宿主 listModels 要求 id 全局唯一，不加渠道前缀会撞名抛 INVALID_CATALOG。
 *
 * @module cs-myfree/pools/channels/catalog
 */

import { join, dirname } from 'node:path'
import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises'
import { CHANNELS, AUTH } from './protocols.js'
import { buildRequestHeaders, joinUrl } from './driver.js'
import { MODELS_PATH, builtinModelsOf, hasBuiltin } from './builtin-models.js'

/** 模型 id 分隔符（用 `/` 更直观，用户能看出是哪个渠道的） */
export const SEP = '/'

export function makeModelId(channelId, modelId) {
  return `${channelId}${SEP}${modelId}`
}

/** 拆解模型 id → { channelId, modelId }；不是渠道模型则返回 null */
export function parseModelId(id) {
  const s = String(id ?? '')
  const i = s.indexOf(SEP)
  if (i <= 0) return null
  const channelId = s.slice(0, i)
  const modelId = s.slice(i + 1)
  if (!CHANNELS[channelId] || !modelId) return null
  return { channelId, modelId }
}

function cacheFile(dshHome) {
  const home = dshHome || process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh')
  return join(home, 'cs-myfree', 'channel-models.json')
}

async function readCache(dshHome) {
  try { return JSON.parse(await readFile(cacheFile(dshHome), 'utf8')) } catch { return {} }
}

async function writeCache(dshHome, obj) {
  const file = cacheFile(dshHome)
  const dir = dirname(file)
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const tmp = `${dir}/.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, file)
    return true
  } catch { return false }
}

/**
 * 从一个渠道拉模型清单（调厂商的 OpenAI 兼容 /v1/models）。
 *
 * ⚠️ 不是所有厂商都实现这个端点 —— 失败就返回空，不报错。
 *
 * @returns {Promise<{ok:boolean, models:Array<{id:string,name:string}>, error?:string}>}
 */
export async function fetchChannelModels(channelId, cred, opts = {}) {
  const ch = CHANNELS[channelId]
  if (!ch) return { ok: false, models: [], error: '未知渠道', source: 'none' }
  if (!cred) return { ok: false, models: [], error: '未登录', source: 'none' }

  const { fetchImpl = globalThis.fetch, timeoutMs = 15_000, allowBuiltin = true } = opts
  const modelsPath = MODELS_PATH[channelId]

  // 该渠道根本不提供 models 端点 ⇒ 直接用内置清单（不发无用的请求）
  if (modelsPath === null) {
    const builtin = builtinModelsOf(channelId)
    return {
      ok: builtin.length > 0,
      models: builtin,
      source: 'builtin',
      error: builtin.length === 0 ? '该渠道不提供模型清单，且没有内置兜底' : null,
    }
  }

  const url = joinUrl(ch.baseUrl, modelsPath ?? '/v1/models')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  // 凭据兼容两种形态：单字符串（老格式）/ 对象（AK/SK/securityToken）
  const credObj = typeof cred === 'string'
    ? (cred.includes(':') ? { token: cred, ak: cred.split(':')[0], sk: cred.split(':')[1] } : { token: cred })
    : (cred ?? {})

  try {
    let headers
    try {
      headers = buildRequestHeaders(ch, credObj, {
        method: 'GET',
        url,
        body: '',
        accept: 'application/json',
        extraUnsignedHeaders: ch.modelsExtraHeaders,
      })
    } catch (err) {
      // 凭据不完整（如 codearts 缺 SK）⇒ 回落内置清单，不把插件打挂
      const builtin = allowBuiltin ? builtinModelsOf(channelId) : []
      return {
        ok: builtin.length > 0,
        models: builtin,
        source: builtin.length > 0 ? 'builtin-after-auth-error' : 'none',
        error: String(err?.message ?? err).slice(0, 120),
      }
    }
    const res = await fetchImpl(url, { method: 'GET', headers, signal: ctrl.signal })
    if (!res.ok) {
      // 🔑 关键：拉失败**回落到内置清单**，而不是让用户看到空列表
      const builtin = allowBuiltin ? builtinModelsOf(channelId) : []
      return {
        ok: builtin.length > 0,
        models: builtin,
        source: builtin.length > 0 ? 'builtin-after-http-error' : 'none',
        error: `HTTP ${res.status}`,
      }
    }
    const body = await res.json()
    // 兼容 OpenAI（data/models）、codearts（builtinModels）、其它（数组）
    const arr = body?.data ?? body?.models ?? body?.builtinModels ?? body?.result?.models ?? body ?? []
    const models = (Array.isArray(arr) ? arr : [])
      .map((m) => ({
        id: String(m?.id ?? m?.name ?? m?.model_id ?? m?.model_name ?? ''),
        name: String(m?.name ?? m?.model_name ?? m?.id ?? m?.model_id ?? ''),
      }))
      .filter((m) => m.id)
    if (models.length === 0) {
      const builtin = allowBuiltin ? builtinModelsOf(channelId) : []
      return { ok: builtin.length > 0, models: builtin, source: 'builtin-empty-remote', error: null }
    }
    return { ok: true, models, source: 'remote', error: null }
  } catch (err) {
    const builtin = allowBuiltin ? builtinModelsOf(channelId) : []
    return {
      ok: builtin.length > 0,
      models: builtin,
      source: builtin.length > 0 ? 'builtin-after-network-error' : 'none',
      error: String(err?.message ?? err).slice(0, 100),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 为所有**已登录**的渠道刷新模型清单并缓存。
 * @param {object} accountStore createAccountStore 的实例
 */
export async function refreshAll(dshHome, accountStore, opts = {}) {
  const accounts = await accountStore.list()
  const byChannel = new Map()
  for (const a of accounts) {
    if (!byChannel.has(a.provider)) byChannel.set(a.provider, [])
    byChannel.get(a.provider).push(a)
  }

  const out = {}
  for (const [channelId, list] of byChannel) {
    // 用第一个账号的凭证拉清单
    const cred = typeof accountStore.secretOf === 'function'
      ? await accountStore.secretOf(channelId)
      : await accountStore.credentialOf(channelId)
    if (!cred) continue
    const r = await fetchChannelModels(channelId, cred, opts)
    out[channelId] = {
      at: Date.now(),
      ok: r.ok,
      error: r.error ?? null,
      // 模型清单来源（remote / builtin / builtin-after-http-error …），UI 要如实展示
      source: r.source ?? null,
      models: r.models,
      accounts: list.length,
    }
  }
  await writeCache(dshHome, out)
  return out
}

/** 读缓存的模型清单（不联网，供 UI 快速展示） */
export async function readCachedModels(dshHome) {
  return readCache(dshHome)
}

/**
 * 把已登录渠道的模型转成 adapter 的 listModels 形状。
 * @param {object} cache readCachedModels 的返回值
 */
export function channelModelsAsList(cache = {}) {
  const out = []
  for (const [channelId, info] of Object.entries(cache)) {
    const ch = CHANNELS[channelId]
    if (!ch) continue
    for (const m of info.models ?? []) {
      out.push({
        id: makeModelId(channelId, m.id),
        name: `${ch.label} · ${m.name || m.id}`,
        channelId,
        modelId: m.id,
        inputModalities: ['text'],
        // 该模型来自远端还是内置兜底（UI 如实标注「内置清单」用）
        source: info.source ?? null,
      })
    }
  }
  return out
}
