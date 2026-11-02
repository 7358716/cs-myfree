/**
 * cs-myfree — 余额查询（对应本机 myfree 的「左下角实时余额 chip」）
 *
 * 🔴 安全红线（这是最敏感的功能，因为它碰到了真实付费账户）：
 *   1. **绝不返回、绝不记录 API Key 的任何片段**
 *   2. 只返回**余额数字**与「可用」布尔
 *   3. 路由必须过 guard（外部未登录一律 403）
 *   4. 响应 `cache-control: no-store`
 *
 * 数据来源（与本机同款）：
 *   GET https://api.deepseek.com/user/balance
 *   → { is_available, balance_infos: [{currency, total_balance, granted_balance, topped_up_balance}] }
 *
 * @module cs-myfree/web/cash
 */

export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
export const CASH_PATH = '/cs-myfree/cash'

/**
 * 从凭据解析器取 DeepSeek Key。
 * ⚠️ 只在内存中使用，函数返回后不留引用。
 */
async function resolveDeepSeekKey(ctx) {
  try {
    const envKey = process.env.DEEPSEEK_API_KEY
    if (envKey && envKey !== '') return envKey
  } catch { /* ignore */ }
  try {
    const creds = ctx?.get?.('credentials', false)
    if (creds && typeof creds.resolve === 'function') {
      const r = await creds.resolve('DEEPSEEK_API_KEY')
      if (r && typeof r.value === 'string' && r.value !== '') return r.value
    }
  } catch { /* ignore */ }
  return null
}

/**
 * 归一化余额响应 —— **只保留数字**，丢弃任何可能敏感的字段。
 * @param {object} j DeepSeek 原始响应
 */
export function normalizeBalance(j) {
  const infos = Array.isArray(j?.balance_infos) ? j.balance_infos : []
  return {
    available: j?.is_available === true,
    balances: infos.map((b) => ({
      currency: String(b?.currency ?? ''),
      total: Number(b?.total_balance ?? 0),
      granted: Number(b?.granted_balance ?? 0),
      topped: Number(b?.topped_up_balance ?? 0),
    })),
  }
}

/**
 * 查询余额。
 * @returns {Promise<{ok:boolean, deepseek:object|null, errors:string[]}>}
 */
export async function queryCash(ctx, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const out = { ok: true, deepseek: null, errors: [] }

  let key = null
  try { key = await resolveDeepSeekKey(ctx) }
  catch { out.errors.push('凭据读取失败') }

  if (!key) {
    out.errors.push('未配置 DEEPSEEK_API_KEY（余额功能需要你自己的 DeepSeek Key）')
    return out
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(DEEPSEEK_BALANCE_URL, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      out.errors.push(`余额接口返回 HTTP ${res.status}`)
      return out
    }
    out.deepseek = normalizeBalance(await res.json())
  } catch (err) {
    // ⚠️ 错误信息里绝不能出现 key（上面的 err.message 不会含，但保险起见截断）
    out.errors.push(`余额查询失败：${String(err?.message ?? err).slice(0, 120)}`)
  } finally {
    clearTimeout(timer)
    key = null   // 主动丢弃引用
  }

  return out
}

/**
 * 把余额格式化成人看的文本（客户端也用同一套规则）。
 * @param {{available:boolean, balances:Array}} ds
 */
export function formatCash(ds) {
  if (!ds || !Array.isArray(ds.balances) || ds.balances.length === 0) return '¥ —'
  return ds.balances
    .map((b) => (b.currency === 'CNY' ? '¥' : `${b.currency} `) + Number(b.total).toFixed(2))
    .join(' ')
}

/**
 * 在 webServer 上注册余额路由。
 * @param {object} webServer 宿主 web 服务
 * @param {object} ctx 插件上下文
 * @param {{trustedHosts?:string[], logger?:object}} opts
 * @returns {boolean} 是否注册成功
 */
export function registerCashRoute(webServer, ctx, opts = {}) {
  try {
    if (!webServer || typeof webServer.register !== 'function') return false
    const { judge, sendJson } = opts.helpers ?? {}
    if (!judge || !sendJson) return false

    webServer.register({
      kind: 'exact',
      path: CASH_PATH,
      handler: async (req, res) => {
        const verdict = judge(req, { trustedHosts: opts.trustedHosts ?? [] })
        if (!verdict.ok) return sendJson(res, 403, { ok: false, error: verdict.reason })
        try {
          const data = await queryCash(ctx, { fetchImpl: opts.fetchImpl })
          return sendJson(res, 200, data)
        } catch (err) {
          return sendJson(res, 500, { ok: false, errors: ['内部错误'] })
        }
      },
    })
    return true
  } catch {
    return false
  }
}
