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
import { buildAuthHeaders, joinUrl } from './driver.js'

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
  if (!ch) return { ok: false, models: [], error: '未知渠道' }
  if (!cred) return { ok: false, models: [], error: '未登录' }

  const { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = opts
  const url = joinUrl(ch.baseUrl, ch.modelsPath ?? '/v1/models')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...buildAuthHeaders(ch, { token: cred, ak: cred.split(':')[0], sig: cred.split(':')[1] }),
      },
      signal: ctrl.signal,
    })
    if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` }
    const body = await res.json()
    const arr = body?.data ?? body?.models ?? body ?? []
    const models = (Array.isArray(arr) ? arr : [])
      .map((m) => ({ id: String(m?.id ?? m?.name ?? ''), name: String(m?.name ?? m?.id ?? '') }))
      .filter((m) => m.id)
    return { ok: true, models }
  } catch (err) {
    return { ok: false, models: [], error: String(err?.message ?? err).slice(0, 100) }
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
    const first = list[0]
    const cred = await accountStore.credentialOf(channelId)
    if (!cred) continue
    const r = await fetchChannelModels(channelId, cred, opts)
    out[channelId] = {
      at: Date.now(),
      ok: r.ok,
      error: r.error ?? null,
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
      })
    }
  }
  return out
}
