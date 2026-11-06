/**
 * cs-myfree — 设置页 API（design/19 §1.3 / §2 页面数据源）
 *
 *   GET  /cs-myfree/settings → { layers, effective, meta, models, channels, recent, failures }
 *   POST /cs-myfree/settings → body { scope, id?, patch }（patch 只写给定字段；
 *                              patch 内 `{ path: null }` = 删除该字段 ⇒ 恢复继承）
 *
 * 安全：
 *   · 写路径沿用 store.js 的敏感字段拦截（凭据类字段任何层都禁写）
 *   · 管理员写的层，非管理员只读（锁定语义，UI 显示「由管理员统一管理」）
 *
 * 数据源全部由 deps 注入（routes.js 装配），本模块不 import pools —— 纯编排。
 *
 * @module cs-myfree/web/settings
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  readScope, writeScope, effectiveConfig, SCOPE, UI_SCOPES, ownerOf, countSetKeys,
  // 契约 E：`subagentRouting` 的写入前校验（与 scope.js 的归一/默认值共用同一份常量）
  validateSubagentRouting,
} from '../config/scope.js'
import {
  findSensitiveKey,
  resolveHiddenSources,
  isSourceHidden,
  channelGroupOf,
  CHANNEL_GROUP_LABELS,
  DEFAULT_HIDDEN_SOURCES,
  DEFAULT_VISIBLE_SOURCES,
  validateHiddenSources,
  isHiddenByDefault,
} from '../config/store.js'
import { ledgerFile } from '../audit/sources.js'
import { filterVisibleCatalog } from './routing.js'

/** 人类可读的作用域名（页面步骤1 选项文案） */
export const SCOPE_LABELS = Object.freeze({
  [SCOPE.GLOBAL]: '所有对话（全局）',
  [SCOPE.WORKSPACE]: '这个工作区',
  [SCOPE.SESSION]: '这个对话',
  [SCOPE.TEAM]: '这个团队',
})

/** 锁定文案（design/19 §2.2） */
export const LOCKED_TEXT = '此设置由管理员统一管理'

/**
 * 尽力而为地枚举「真实存在的」作用域对象（design/21 §2，全部容错，异常 ⇒ []）：
 *   · workspaces：扫描 `<dshHome>/sessions/` 目录名（形如 `--home-ubuntu-output2026-butlers-dev--`，
 *     即 `--` + 路径(`/`→`-`) + `--`），反推最后一段为可读 label（如 `dev`）；
 *     同一 label 去重（不同 home 下同名目录只列一次）。
 *   · teams：扫描 `<dshHome>/cs-bots/rooms/` 下 `room-*` 目录 + `<dshHome>/cs-bots/` 下 `team-*`
 *     目录；label 优先取 rooms/index.json 里的房间名，fallback 目录名。
 *   · session：由 deps.getContext() 提供（本函数只返回 null 占位）。
 * @param {string} [dshHome] 缺省走 DSH_HOME / ~/.dsh
 * @returns {Promise<{workspaces:Array<{id:string,label:string}>, teams:Array<{id:string,label:string}>, session:null}>}
 */
export async function listScopeObjects(dshHome) {
  const out = { workspaces: [], teams: [], session: null }
  try {
    const dsh = dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
    // ── workspaces：sessions/ 目录名 ──
    try {
      const seen = new Set()
      const entries = await readdir(join(dsh, 'sessions'), { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const m = /^--(.+)--$/.exec(e.name)
        if (!m) continue
        const segs = m[1].split('-').filter(Boolean)
        const base = segs.length ? decodeSeg(segs[segs.length - 1]) : m[1]
        if (!base || seen.has(base)) continue
        seen.add(base)
        out.workspaces.push({ id: base, label: base })
      }
    } catch { /* 无 sessions 目录 ⇒ [] */ }
    // ── teams：cs-bots 的房间/团队目录 ──
    try {
      const names = {}
      try {
        const idx = JSON.parse(await readFile(join(dsh, 'cs-bots', 'rooms', 'index.json'), 'utf8'))
        for (const r of idx.rooms ?? []) names[r.id] = r.name || r.id
      } catch { /* 无 index.json ⇒ label 用目录名 */ }
      const roomEntries = await readdir(join(dsh, 'cs-bots', 'rooms'), { withFileTypes: true })
      for (const e of roomEntries) {
        if (!e.isDirectory() || !/^room-/.test(e.name)) continue
        out.teams.push({ id: e.name, label: names[e.name] || e.name })
      }
      const botEntries = await readdir(join(dsh, 'cs-bots'), { withFileTypes: true })
      for (const e of botEntries) {
        if (!e.isDirectory() || !/^team-/.test(e.name)) continue
        out.teams.push({ id: e.name, label: e.name })
      }
    } catch { /* 无 cs-bots ⇒ [] */ }
  } catch { /* 尽力而为 */ }
  return out
}

/** DSH 会话目录名的编码段反解码（`~XX` → `%XX`；失败保持原文） */
function decodeSeg(s) {
  try { return decodeURIComponent(s.replace(/~/g, '%')) } catch { return s }
}

/**
 * 递归应用 patch：`{path: null}` 删除该字段（恢复继承），对象递归合并，
 * 标量/数组整体替换。
 */
export function applyPatch(base, patch) {
  const out = { ...(base ?? {}) }
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === null) { delete out[k]; continue }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sub = applyPatch(out[k] ?? {}, v)
      // 递归后子对象被删空 ⇒ 一并删除该键（不留空壳，语义 = 恢复继承）
      if (Object.keys(sub).length === 0) delete out[k]
      else out[k] = sub
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * 读账本末尾最近 N 条调用记录（append-only ⇒ 行序即时间序，取最后 N 行）。
 * 账本文件与审计模块同源：`~/.dsh/cs-myfree/ledger.jsonl`（不是 spend.jsonl）。
 * @returns {Promise<Array<{at:number, provider:string|null, model:string|null, ms:number|null, ok:boolean, code:string|null, day:string}>>}
 */
export async function readRecentRecords({ dshHome, limit = 5 } = {}) {
  const file = ledgerFile(dshHome)
  const out = []
  try {
    const stream = createReadStream(file, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      out.push({
        at: o.at ?? null,
        provider: o.provider ?? null,
        model: o.model ?? null,
        ms: o.ms ?? null,
        ok: o.ok !== false,
        code: o.code ?? null,
        day: o.day ?? null,
      })
      if (out.length > limit) out.shift()
    }
  } catch { /* 无账本 = 新机器，正常 */ }
  return out
}

/** 黑名单失败类型的人话（设置页状态列直接显示，不把 AUTH 这类码甩给用户） */
const BLACKLIST_KIND_TEXT = Object.freeze({
  AUTH: '登录失效',
  QUOTA: '额度用尽',
  RATE_LIMIT: '被限流',
  NOT_FOUND: '模型/端点不存在',
  INVALID_REQUEST: '请求被拒',
  PERMISSION: '无权限',
  NETWORK: '网络故障',
})

/** 毫秒 → 「3 分」「15 秒」 */
function humanDuration(ms) {
  const n = Number(ms) || 0
  if (n >= 60000) return `${Math.round(n / 60000)} 分`
  if (n >= 1000) return `${Math.round(n / 1000)} 秒`
  return `${n} 毫秒`
}

/**
 * 聚合渠道可用清单 + 状态（需求 #6：设置页「渠道与路由」表格的数据源）。
 *
 * 每行字段（**前端契约**，改动需同步 WP-C）：
 *   id            渠道 id（= provider，如 `codearts`）
 *   name          显示名（`label` 保留兼容，与 name 同值）
 *   group         分组 id：deepseek | huawei | free | selfapi | channel | other
 *   groupLabel    分组人话：DeepSeek / 华为云 / 免费源 / 自加 API / 渠道包 / 其它
 *   available     现在**能不能真用**（实现可用 && 没停用 && 已登录 && 不在黑名单/冷却）
 *   loginVerified 登录器端点是否真机验证过（false ⇒ UI 必须显示「未验证」徽标）
 *   status        状态人话（如 `正常` / `冷却中（15 秒）/ 已暂停：登录失效`）
 *   statusCode    机器码：ok | cooling | failed | blacklisted | not-logged-in
 *                 | unverified-login | unavailable | disabled
 *   hidden        是否不展示（**只影响对话模型选择器**；拿到 true 也仍然能用）
 *   defaultHidden 是否「默认不展示」（用户没改过时的默认值，UI 据此显示「默认」）
 *   reason        为什么不可用（人话；available=true 时为 null）
 *   reasonCode    机器码：null | unimplemented | disabled | not-logged-in | blacklisted
 *                 | cooling | unverified-login
 *   usable        兼容旧字段：可用性开关（= !disabled 且在 enabled 白名单内）
 *   state         兼容旧字段：ok | cooling | failed
 *   failCount / coolingMs / blacklisted / blacklistKind / blacklistRemainMs / loggedIn
 *                兼容旧字段
 *
 * @param {Array} channels 渠道列表（listChannels 形状：id/label/login/loggedIn/implemented/reason/loginVerified）
 * @param {object|null} routing routingSnapshot()（gate / blacklist）
 * @param {object|null} ledger collectLedger()（failures.byProvider）
 * @param {object} effectiveCfg 生效配置（sources.disabled / sources.enabled / sources.hidden）
 */
export function channelStatusList(channels, routing, ledger, effectiveCfg = {}) {
  const gate = routing?.gate ?? {}
  const blacklist = Array.isArray(routing?.blacklist) ? routing.blacklist : []
  const byProvider = ledger?.failures?.byProvider ?? {}
  const disabled = new Set(Array.isArray(effectiveCfg.sources?.disabled) ? effectiveCfg.sources.disabled : [])
  const enabledOnly = Array.isArray(effectiveCfg.sources?.enabled) && effectiveCfg.sources.enabled.length > 0
    ? new Set(effectiveCfg.sources.enabled) : null
  const blByProvider = new Map()
  for (const b of blacklist) {
    const cur = blByProvider.get(b.provider)
    if (!cur || (cur.until ?? 0) < (b.until ?? 0)) blByProvider.set(b.provider, b)
  }
  return (channels ?? []).map((c) => {
    const id = String(c.id ?? '')
    const name = c.label ?? c.name ?? id
    const bl = blByProvider.get(id)
    const coolingMs = gate[id] && Number(gate[id].coolingMs) > 0 ? Number(gate[id].coolingMs) : 0
    const failCount = Number(byProvider[id]) || 0
    const blListed = Boolean(bl)
    let state = 'ok'
    if (blListed) state = 'failed'
    else if (coolingMs > 0) state = 'cooling'
    else if (failCount > 0) state = 'failed'
    const usable = !disabled.has(id) && (enabledOnly === null || enabledOnly.has(id))

    // ── 可用性判定（复用既有信息，不另造一套）──
    // `implemented===false` 与 `reason` 来自 listChannels 的能力实况；
    // `login` 是登录方式（required 与否决定要不要查 loggedIn）。
    const implemented = c.implemented !== false
    const loginKind = c.login ?? c.authKind ?? null
    const requiresLogin = loginKind !== null && loginKind !== 'none'
    const loggedIn = c.loggedIn === true
    const loginVerified = c.loginVerified === true
    const notLoggedIn = requiresLogin && !loggedIn

    let statusCode = 'ok'
    let reasonCode = null
    let reason = null
    if (!implemented) {
      statusCode = 'unavailable'
      reasonCode = 'unimplemented'
      reason = String(c.reason || '该渠道暂无可用推理链路')
    } else if (!usable) {
      statusCode = 'disabled'
      reasonCode = 'disabled'
      reason = '已在「停用」清单里（sources.disabled / sources.enabled 未放行）⇒ 不参与选路'
    } else if (notLoggedIn) {
      statusCode = 'not-logged-in'
      reasonCode = 'not-logged-in'
      reason = '还没有登录凭据（设置页「渠道」里登录后即可用）'
    } else if (blListed) {
      statusCode = 'blacklisted'
      reasonCode = 'blacklisted'
      reason = `终态失败被暂停（${BLACKLIST_KIND_TEXT[bl.kind] ?? bl.kind ?? '未知原因'}），成功一次自动解除`
    } else if (coolingMs > 0) {
      statusCode = 'cooling'
      reasonCode = 'cooling'
      reason = `并发/限流冷却中，还剩 ${humanDuration(coolingMs)}（到期自动恢复）`
    } else if (!loginVerified && loggedIn) {
      statusCode = 'unverified-login'
      reasonCode = 'unverified-login'
      // 未验证 ≠ 不可用：能试，只是可能失败。available 仍为 true，reason 说明风险。
      reason = '登录器端点未经真机验证：可能「看起来登上了、实际调不通」'
    }

    const available = implemented && usable && !notLoggedIn && !blListed && coolingMs === 0

    // 状态人话
    let status
    switch (statusCode) {
      case 'unavailable':
        status = `暂不可用：${reason}`
        break
      case 'disabled':
        status = '已停用（不参与选路）'
        break
      case 'not-logged-in':
        status = '未登录'
        break
      case 'blacklisted':
        status = `已暂停：${BLACKLIST_KIND_TEXT[bl.kind] ?? bl.kind ?? '未知原因'}`
        break
      case 'cooling':
        status = `冷却中（${humanDuration(coolingMs)}）`
        break
      case 'unverified-login':
        status = '可用（登录未验证）'
        break
      default:
        status = failCount > 0 ? `正常（最近失败 ${failCount} 次）` : '正常'
    }

    const group = channelGroupOf(id)
    return {
      id,
      name,
      label: name,                 // 兼容旧字段
      group,
      groupLabel: CHANNEL_GROUP_LABELS[group] ?? group,
      available,
      loginVerified,
      status,
      statusCode,
      hidden: isSourceHidden(id, effectiveCfg),
      defaultHidden: isHiddenByDefault(id),
      reason: available ? (reasonCode === 'unverified-login' ? reason : null) : reason,
      reasonCode,
      // ── 兼容旧字段（旧 UI 仍在读，别删）──
      loggedIn,
      state,
      failCount,
      coolingMs,
      blacklisted: blListed,
      blacklistKind: bl?.kind ?? null,
      blacklistRemainMs: bl && Number.isFinite(bl.remainMs) ? bl.remainMs : null,
      usable,
    }
  })
}

/**
 * GET /cs-myfree/settings
 * @param {object} deps { dshHome, isAdmin, getContext, modelCatalog, routingSnapshot, ledger, channels, now }
 * @param {URLSearchParams} query
 */
export async function readSettings(deps, query) {
  const { dshHome } = deps
  const ctx = (typeof deps.getContext === 'function' ? deps.getContext() : {}) || {}
  const queryId = (k) => {
    const v = String(query?.get(k) ?? '').trim()
    return v ? v : null
  }
  const workspaceId = queryId('workspaceId') ?? ctx.workspaceId ?? null
  const sessionId = queryId('sessionId') ?? ctx.sessionId ?? null
  const teamId = queryId('teamId') ?? ctx.teamId ?? null
  const isAdmin = typeof deps.isAdmin === 'function' ? deps.isAdmin() === true : true

  const eff = await effectiveConfig({ dshHome, workspaceId, sessionId, teamId })

  // 四层清单（UI 引导顺序；preset 兼容层不进清单，但仍在 effective 里参与合并）
  const layerItems = [
    { scope: SCOPE.GLOBAL, id: null },
    { scope: SCOPE.WORKSPACE, id: workspaceId },
    { scope: SCOPE.SESSION, id: sessionId },
    { scope: SCOPE.TEAM, id: teamId },
  ].map(({ scope, id }) => {
    const cfg = id || scope === SCOPE.GLOBAL ? (eff.byLayer[scope] ?? {}) : {}
    return {
      scope,
      id,
      owner: ownerOf(cfg),
      setKeys: countSetKeys(cfg),
      // 该层已存配置（不含敏感字段；UI 表单的编辑底稿）
      config: stripMeta(cfg),
    }
  })

  // 模型目录（按渠道分组；deps.modelCatalog 复用 /chain/catalog 的构造）
  let models = []
  try { models = (await deps.modelCatalog?.()) ?? [] } catch { models = [] }

  // 渠道可用清单 + 状态
  let channels = []
  try { channels = (await deps.channels?.()) ?? [] } catch { channels = [] }
  let routing = null
  try { routing = typeof deps.routingSnapshot === 'function' ? deps.routingSnapshot() : null } catch { routing = null }
  let ledger = null
  try { ledger = (await deps.ledger?.()) ?? null } catch { ledger = null }
  const channelStatus = channelStatusList(channels, routing, ledger, eff.config)

  // 展示开关（需求 #6）：生效的隐藏集合 + 「对话模型选择器」实际会看到的目录。
  // ⚠️ 传 `eff.config`（**未套 DEFAULTS** 的原始合并值）—— 见 store.js#resolveHiddenSources。
  const hidden = resolveHiddenSources(eff.config)
  const selectorCatalog = filterVisibleCatalog(models, eff.config)

  const recent = await readRecentRecords({ dshHome, limit: 5 })

  // 作用域下拉的真实对象枚举（design/21 §2；尽力而为，异常 ⇒ []）
  const scopes = await listScopeObjects(dshHome)
  const sess = ctx.session ?? (sessionId ? { id: sessionId, label: sessionId } : null)
  scopes.session = sess

  return {
    ok: true,
    at: typeof deps.now === 'function' ? deps.now() : Date.now(),
    layers: layerItems,
    effective: eff,
    scopes,
    meta: {
      isAdmin,
      context: { workspaceId, sessionId, teamId },
      note: 'isAdmin=false 时，owner=admin 的层只读（由管理员统一管理）',
    },
    models,                       // 设置页模型清单 = 全量（配置链要用）
    modelsVisible: selectorCatalog.sources,  // 对话模型选择器口径 = 已过滤 hidden
    channels: channelStatus,
    visibility: {
      hidden: hidden.list,
      explicit: hidden.explicit,             // true = 用户显式设过（绝对口径）
      source: hidden.source,                 // 'config' | 'default'
      defaultHidden: [...DEFAULT_HIDDEN_SOURCES],
      defaultVisible: [...DEFAULT_VISIBLE_SOURCES],
      droppedProviders: selectorCatalog.dropped,
      note: 'hidden = 不展示（对话模型选择器里看不到）；**不等于停用**：路由链与自动切换仍可用全部渠道。改开关：PATCH/POST /cs-myfree/settings {scope, patch:{sources:{hidden:[...]}}}；恢复默认传 {sources:{hidden:null}}。',
    },
    recent,
    failures: ledger?.failures ?? null,
    hint: '优先级：全局 ← 工作区 ← 会话 ← 团队（团队最窄最优先）。预设层保留读取兼容，不再引导。',
  }
}

function stripMeta(cfg) {
  const { _meta, ...rest } = cfg ?? {}
  return rest
}

/**
 * POST /cs-myfree/settings
 * @param {object} deps { dshHome, isAdmin, now }
 * @param {object} body { scope, id?, patch }
 */
export async function updateSettings(deps, body) {
  const scope = String(body?.scope ?? '')
  if (!UI_SCOPES.includes(scope)) return { ok: false, error: '未知作用域：' + scope + '（可选：' + UI_SCOPES.join(' / ') + '）' }
  const id = scope === SCOPE.GLOBAL ? undefined : String(body?.id ?? '').trim()
  if (scope !== SCOPE.GLOBAL && !id) {
    return { ok: false, error: scope + ' 作用域需要 id（如工作区名 / 会话 ID / 团队 ID）' }
  }
  const patch = body?.patch
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: '缺少 patch（要改的字段对象；{字段: null} 表示删除该字段恢复继承）' }
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'patch 不能为空' }

  // 🔴 敏感字段拦截（递归，防嵌套绕过）——与 /scope /config 同口径
  const hit = findSensitiveKey(patch)
  if (hit) return { ok: false, error: `禁止写入敏感字段：${hit}` }

  // 🔴 展示开关校验（需求 #6）：`sources.hidden` 只接受「渠道 id 字符串数组」。
  //    非法值必须在**写盘前**拒掉：静默吞掉会得到「看着设了、实际没生效」的假开关。
  //    `{sources:{hidden:null}}` = 删掉该字段 ⇒ 恢复默认可见集合（继承语义）。
  let patchToWrite = patch
  if (patch.sources && typeof patch.sources === 'object' && !Array.isArray(patch.sources)
    && Object.prototype.hasOwnProperty.call(patch.sources, 'hidden')) {
    const hv = validateHiddenSources(patch.sources.hidden, { allowNull: true })
    if (!hv.ok) return { ok: false, field: 'sources.hidden', error: hv.errors.join('；') }
    if (hv.value !== null) {
      // 归一（大小写 / `kilo-free`→`kilo` 之类别名）后落盘，避免"同一个渠道两种写法"
      patchToWrite = { ...patch, sources: { ...patch.sources, hidden: hv.value } }
    }
  }

  const isAdmin = typeof deps.isAdmin === 'function' ? deps.isAdmin() === true : true
  const existing = await readScope(deps.dshHome, scope, id)

  // 🔒 锁定语义：管理员写的层，非管理员只读
  if (ownerOf(existing) === 'admin' && !isAdmin) {
    return { ok: false, error: LOCKED_TEXT + '（此层由管理员写入，普通用户不可修改）', locked: true }
  }

  const merged = applyPatch(existing, patchToWrite)
  // 契约 E：`subagentRouting` 必须先校验再落盘（pinned 模式必须给 model）。
  // 为什么卡在**写入前**而不是运行期：运行期按 `fallback` 静默兜底（不抛错），
  // 若这里不拦，用户会得到一个"看起来设了、其实没生效"的假开关。
  //
  // ⚠️ 只在 patch **确实要写** `subagentRouting` 时拦：
  //    否则某层历史脏值（旧版本写进去的 `{mode:'pinned'}`）会让"改任何其它字段"
  //    都被这条错误挡住 —— 连带修不了，用户只能手工改磁盘文件。
  //    patch 透传删除该字段（`{subagentRouting:null}`）时 merged 里已无此键 ⇒ 放行（= 恢复继承）。
  if (Object.prototype.hasOwnProperty.call(patch, 'subagentRouting')) {
    const vr = validateSubagentRouting(merged.subagentRouting)
    if (!vr.ok) return { ok: false, field: 'subagentRouting', error: vr.errors.join('；') }
  }

  const saved = await writeScope(deps.dshHome, scope, id, merged, {
    owner: isAdmin ? 'admin' : 'user',
    updatedAt: typeof deps.now === 'function' ? deps.now() : Date.now(),
  })
  if (!saved) return { ok: false, error: '写入失败（磁盘错误）' }

  const eff = await effectiveConfig({
    dshHome: deps.dshHome,
    workspaceId: scope === SCOPE.WORKSPACE ? id : undefined,
    sessionId: scope === SCOPE.SESSION ? id : undefined,
    teamId: scope === SCOPE.TEAM ? id : undefined,
  })
  const hiddenAfter = resolveHiddenSources(eff.config)
  return {
    ok: true,
    scope,
    id: id ?? null,
    owner: isAdmin ? 'admin' : 'user',
    setKeys: countSetKeys(merged),
    effective: eff,
    // 写入后的展示开关实况（UI 直接回填表格的「是否展示」列）
    visibility: {
      hidden: hiddenAfter.list,
      explicit: hiddenAfter.explicit,
      source: hiddenAfter.source,
      note: 'hidden 只影响对话模型选择器；不等于停用（路由链/自动切换仍可用全部渠道）。',
    },
    hint: '已保存，下次请求生效',
  }
}
