/**
 * cs-myfree — 签到调度
 *
 * 设计依据：v3 §11.2 S3 + 06 号报告的「记账口径」教训。
 *
 * 🔴 关键坑（06 号报告实测，审查 PR !33）：
 *    **不能用 `claimed + alreadyClaimed` 记账**，必须用各渠道声明的
 *    `summary.coversToday`。原因：Qoder 活动每日 **10:00 (UTC+8)** 才刷新，
 *    上午那轮的 `CLAIMED` 属于**昨天**，拿它记账会让当天额度**整天漏领**。
 *
 * @module cs-myfree/pools/channels/checkin
 */

/** 默认签到时间（UTC+8 的 10:05，避开 Qoder 的 10:00 刷新边界） */
export const DEFAULT_CHECKIN_HOUR = 10
export const DEFAULT_CHECKIN_MINUTE = 5

/**
 * 判断「今天是否还需要跑签到」。
 *
 * @param {object} state 持久化状态 { lastDate, lastRunAt, channels }
 * @param {{now?:()=>number, hour?:number, minute?:number}} opts
 * @returns {{due:boolean, reason:string, dateKey:string}}
 */
export function isDue(state = {}, opts = {}) {
  const now = opts.now ?? (() => Date.now())
  const hour = opts.hour ?? DEFAULT_CHECKIN_HOUR
  const minute = opts.minute ?? DEFAULT_CHECKIN_MINUTE
  const t = new Date(now())
  const dateKey = toDateKey(t)
  const dueAt = new Date(t)
  dueAt.setHours(hour, minute, 0, 0)

  if (state?.lastDate === dateKey) return { due: false, reason: '今天已跑过', dateKey }
  if (t < dueAt) return { due: false, reason: `未到签到时间（${hour}:${String(minute).padStart(2, '0')}）`, dateKey }
  return { due: true, reason: '到点且今天未跑', dateKey }
}

/** YYYY-MM-DD（本地时区，不是 UTC —— 否则跨零点会算错天） */
export function toDateKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 汇总一轮签到结果。
 *
 * ⚠️ 记账口径：只认 coversToday=true 的渠道算「今天已覆盖」，
 *    其余一律记 pending（下次再试），**绝不因为 claimed>0 就认为今天完成**。
 *
 * @param {Array<{provider:string, claimed:number, alreadyClaimed:number, failed:number, coversToday:boolean, gain?:string}>} results
 */
export function summarize(results = []) {
  let covered = 0, pending = 0, failedChannels = 0
  const detail = []
  for (const r of results) {
    const isCovered = r.coversToday === true
    if (isCovered) covered++
    else if ((r.failed ?? 0) > 0) { failedChannels++; pending++ }
    else pending++
    detail.push({
      provider: r.provider,
      claimed: r.claimed ?? 0,
      alreadyClaimed: r.alreadyClaimed ?? 0,
      failed: r.failed ?? 0,
      coversToday: isCovered,
      gain: r.gain ?? null,
    })
  }
  return {
    covered,
    pending,
    failedChannels,
    detail,
    // 只有全部渠道都 coversToday 才算「今天完成」
    allCovered: pending === 0 && results.length > 0,
    text: `${covered} 家已覆盖今日，${pending} 家待补（${failedChannels} 家有失败）`,
  }
}

/**
 * 下一轮该在什么时候跑。
 * 若有 pending，则 2 小时后重试；否则等明天。
 */
export function nextRunAt(state = {}, opts = {}) {
  const now = opts.now ?? (() => Date.now())
  const h = opts.hour ?? DEFAULT_CHECKIN_HOUR
  const m = opts.minute ?? DEFAULT_CHECKIN_MINUTE
  const t = new Date(now())

  if (state?.pending > 0 && state?.lastDate === toDateKey(t)) {
    return now() + 2 * 3600 * 1000     // 有欠账 ⇒ 2 小时后重试
  }
  const next = new Date(t)
  next.setHours(h, m, 0, 0)
  if (next <= t) next.setDate(next.getDate() + 1)
  return next.getTime()
}

// ─────────────────────────────────────────────────────────────────────────────
// 真实接线（v1.9.0）：状态文件 + 执行器 + setTimeout 链调度器
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { runCheckin, runProviders, capabilityOf } from './credits/index.js'

/** 状态文件名（`<DSH_HOME>/cs-myfree/checkin.json`，0600） */
export const CHECKIN_FILE = 'checkin.json'
export const CHECKIN_SCHEMA = 'cs-myfree/checkin/v1'

/** 默认配置：**默认关闭自动签到**（写操作要用户明确打开） */
export const DEFAULT_CHECKIN_CONFIG = Object.freeze({
  enabled: false,
  at: '10:05',            // UTC+8 每日 10:05（避开 Qoder 10:00 刷新边界）
  retryMinutes: 120,      // 失败/欠账时的重试间隔
  dailyDelayMs: 0,        // 启动后额外延迟（生产调用方传入 30s，避免和启动抢资源）
})

export function checkinFile(dshHome) {
  const home = dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'cs-myfree', CHECKIN_FILE)
}

/** 归一化磁盘状态（脏数据不抛，回落默认） */
export function sanitizeState(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { schema: CHECKIN_SCHEMA, lastDate: '', lastAt: 0, lastResult: '', channels: [], pending: 0 }
  return {
    schema: CHECKIN_SCHEMA,
    lastDate: typeof raw.lastDate === 'string' ? raw.lastDate : '',
    lastAt: Number.isFinite(raw.lastAt) ? raw.lastAt : 0,
    lastResult: typeof raw.lastResult === 'string' ? raw.lastResult : '',
    pending: Number.isFinite(raw.pending) ? raw.pending : 0,
    channels: Array.isArray(raw.channels)
      ? raw.channels.filter((c) => c && typeof c === 'object' && typeof c.provider === 'string').slice(0, 24).map((c) => ({
        provider: c.provider,
        kind: typeof c.kind === 'string' ? c.kind : 'unknown',
        text: String(c.text ?? '').slice(0, 120),
        at: Number.isFinite(c.at) ? c.at : 0,
        gain: c.gain ?? null,
      }))
      : [],
  }
}

/** 读状态（损坏返回默认值） */
export async function readCheckinState(dshHome) {
  try {
    return sanitizeState(JSON.parse(await readFile(checkinFile(dshHome), 'utf8')))
  } catch {
    return sanitizeState({})
  }
}

/** 原子写状态（0600） */
export async function writeCheckinState(dshHome, state) {
  const file = checkinFile(dshHome)
  const dir = file.slice(0, file.lastIndexOf('/'))
  const tmp = `${dir}/.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(tmp, JSON.stringify(sanitizeState(state), null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, file)
    return true
  } catch {
    return false
  }
}

/** 解析 "HH:MM"（非法回落默认） */
export function parseAt(at, fallback = DEFAULT_CHECKIN_CONFIG.at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at ?? '').trim())
  if (!m) return parseAt(fallback, '10:05')
  const h = Number(m[1]), min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return parseAt(fallback, '10:05')
  return { hour: h, minute: min }
}

/** 下一个「每日执行点」（本地时区） */
export function computeNextRun(cfg = {}, now = Date.now()) {
  const { hour, minute } = parseAt(cfg.at)
  const t = new Date(now)
  const next = new Date(t)
  next.setHours(hour, minute, 0, 0)
  if (next.getTime() <= t.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime()
}

/**
 * 创建签到调度器（**setTimeout 链 + unref**）。
 *
 * 🔴 为什么不用 ctx.interval：recon2/20 §0-5 记录过「读未 inject 的 timer
 *    会抛异常导致整插件不激活」。这里只靠全局 setTimeout，句柄 unref() 不挂住进程。
 *
 * 可注入依赖（测试用假时钟）：
 *   executor({providers}) → Promise<{results, coversToday}>
 *   config()  → {enabled, at, retryMinutes}
 *   state     → {read, write}
 *   setTimer / clearTimer
 *
 * 行为：
 *   · enabled=false ⇒ 不排定时器（start 后也不跑）
 *   · 到点执行；全部失败/欠账 ⇒ retryMinutes 后重试（不等到明天）
 *   · 手动 runNow() 不受 enabled 限制（显式操作）
 *   · 一家渠道失败不影响其他（executor 内 runProviders 串行 + try/catch）
 */
export function createCheckinScheduler(o = {}) {
  const {
    executor,
    state: stateIo,
    config = () => ({}),
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
    logger = { info() {}, warn() {}, debug() {} },
    initialDelayMs = 0,
  } = o
  if (typeof executor !== 'function') throw new TypeError('createCheckinScheduler 需要 executor')

  let timer = null
  let running = false
  let started = false
  let lastError = null
  let memState = sanitizeState({})
  let stateLoaded = false

  const cfg = () => {
    const c = config() ?? {}
    return {
      enabled: c.enabled === true,
      at: c.at ?? DEFAULT_CHECKIN_CONFIG.at,
      retryMinutes: Number.isFinite(c.retryMinutes) ? c.retryMinutes : DEFAULT_CHECKIN_CONFIG.retryMinutes,
    }
  }

  async function loadState() {
    if (stateLoaded) return memState
    stateLoaded = true
    try { memState = stateIo?.read ? await stateIo.read() : memState } catch { memState = sanitizeState({}) }
    return memState
  }

  function nextDelay(c) {
    const t = now()
    const today = toDateKey(new Date(t))
    const pending = memState.pending > 0 && memState.lastDate === today
    if (pending) return Math.max(1000, c.retryMinutes * 60_000)
    const due = computeNextRun(c, t)
    const extra = started && memState.lastAt === 0 ? Math.max(0, initialDelayMs) : 0
    return Math.max(1000, due - t + extra)
  }

  function clear() {
    if (timer !== null) {
      try { clearTimer(timer) } catch { /* ignore */ }
      timer = null
    }
  }

  function schedule() {
    clear()
    const c = cfg()
    if (!c.enabled) return
    const delay = nextDelay(c)
    timer = setTimer(() => { tick().catch(() => {}).finally(() => schedule()) }, delay)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  async function tick() {
    const c = cfg()
    if (!c.enabled) return { skipped: true, reason: 'disabled' }
    await loadState()
    const today = toDateKey(new Date(now()))
    if (memState.lastDate === today && memState.pending === 0) {
      return { skipped: true, reason: '今天已完成' }
    }
    return run()
  }

  /** 手动跑一轮（显式操作：不受 enabled 限制） */
  async function run(providers) {
    if (running) return { skipped: true, reason: 'already-running', lastError }
    running = true
    lastError = null
    const t0 = now()
    try {
      await loadState()
      const out = await executor({ providers })
      const results = Array.isArray(out?.results) ? out.results : []
      const coversToday = out?.coversToday === true
      memState = sanitizeState({
        ...memState,
        lastDate: coversToday ? toDateKey(new Date(now())) : memState.lastDate,
        lastAt: now(),
        lastResult: coversToday ? 'done' : 'pending',
        pending: coversToday ? 0 : Math.max(1, results.filter((r) => r.kind === 'failed').length),
        channels: results.map((r) => ({
          provider: r.provider,
          kind: r.kind,
          text: String(r.message ?? r.error ?? '').slice(0, 120),
          at: now(),
          gain: r.gain ?? null,
        })),
      })
      try { await stateIo?.write?.(memState) } catch { /* 状态写失败不影响结果 */ }
      logger.info?.(`签到完成：${coversToday ? '今日已覆盖' : '仍有欠账'}（${results.length} 家）`)
      return { ...out, results, takesMs: now() - t0 }
    } catch (err) {
      lastError = String(err?.message ?? err)
      logger.warn?.(`签到执行失败：${lastError}`)
      throw err
    } finally {
      running = false
    }
  }

  return {
    /** 启动（enabled=false 时不排程，但保持 started 状态便于开关后立即排） */
    start() {
      started = true
      schedule()                                   // 同步排程：status().alive 立刻为真
      loadState().then(() => schedule()).catch(() => {})  // 状态到达后按真实 lastDate/pending 重排
      return this
    },
    stop() {
      started = false
      clear()
      return this
    },
    /** 开关立即生效：true ⇒ 排程，false ⇒ 停表 */
    setEnabled(enabled) {
      if (enabled) { started = true; schedule() } else { clear() }
      return this
    },
    /** 配置变更（at/retryMinutes 变了立即重排） */
    reschedule() {
      if (started) schedule()
      return this
    },
    /** 立即跑一轮（显式操作） */
    runNow(providers) {
      return run(providers)
    },
    /** 内部 tick（测试用：模拟到点） */
    _tick: tick,
    status() {
      const c = cfg()
      return {
        enabled: c.enabled,
        alive: timer !== null,
        running,
        started,
        at: c.at,
        nextAt: c.enabled ? computeNextRun(c, now()) : null,
        lastAt: memState.lastAt || null,
        lastDate: memState.lastDate || null,
        lastResult: memState.lastResult || null,
        pending: memState.pending ?? 0,
        lastError,
        channels: memState.channels,
      }
    },
  }
}

/**
 * 默认执行器：从账号里取所有「已实现签到」的渠道，串行执行。
 *
 * @param {{accounts:object, providers?:string[]|null, fetchImpl?:Function, now:()=>number}} o
 */
export function createCheckinExecutor({ accounts, providers = null, fetchImpl, now = () => Date.now() } = {}) {
  return async ({ providers: override } = {}) => {
    const wanted = Array.isArray(override) && override.length > 0 ? override : providers
    let list = wanted
    if (!Array.isArray(list)) {
      // 默认：能力表里「能签到」的渠道 ∩ 已登录账号
      let loggedIn = []
      try { loggedIn = (await accounts.list()).map((a) => a.provider) } catch { loggedIn = [] }
      list = [...new Set(loggedIn)].filter((p) => {
        const cap = capabilityOf(p)
        return cap.checkin === true && cap.verified === true
      })
    }
    const results = await runProviders(list, async (provider) => {
      const secret = typeof accounts.secretOf === 'function' ? await accounts.secretOf(provider) : null
      return runCheckin(provider, { secret, fetchImpl, now })
    }, { now })
    const coversToday = results.length > 0 && results.every((r) => r.kind === 'claimed' || r.kind === 'already-claimed' || r.kind === 'inactive' || r.kind === 'unsupported')
    return { results, coversToday }
  }
}
