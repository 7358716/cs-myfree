/**
 * cs-myfree — 公告推送与热重载（ourfree 能力面）
 *
 * @module cs-myfree/ops/feed
 */

/**
 * 公告优先级与去重。
 * 关键：同 id 的公告只推一次（除非内容变了）。
 */
export function createFeedStore({ now = () => Date.now() } = {}) {
  const seen = new Map()   // id -> {hash, at}
  return {
    /** 过滤出「该给用户看的」公告 */
    filter(items = []) {
      const out = []
      for (const it of items) {
        if (!it?.id) continue
        const hash = simpleHash(JSON.stringify(it))
        const prev = seen.get(it.id)
        if (prev && prev.hash === hash) continue
        seen.set(it.id, { hash, at: now() })
        out.push(it)
      }
      // 高优先级在前
      return out.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    },
    size() { return seen.size },
  }
}

function simpleHash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return String(h)
}

/**
 * 热重载规划：哪些改动需要重启，哪些可以热生效。
 * 依据：v3 §16（ourfree 的 partialReload 5 步镜像）。
 */
export const RELOAD_SCOPE = Object.freeze({
  HOT: 'hot',          // 只改配置值 ⇒ 热生效
  RELOAD: 'reload',    // 改代码 ⇒ 需重载插件
  RESTART: 'restart',  // 改依赖/patch ⇒ 需重启
})

export function planReload({ changed = [] } = {}) {
  const files = changed.map((c) => (typeof c === 'string' ? c : c.path ?? ''))
  const has = (re) => files.some((f) => re.test(f))

  if (files.length === 0) return { scope: RELOAD_SCOPE.HOT, reason: '无改动', files }
  if (has(/package\.json$|pnpm-lock|cordis\.patch\.yml$/)) {
    return { scope: RELOAD_SCOPE.RESTART, reason: '依赖或 patch 变更，必须重启', files }
  }
  if (has(/\.(js|mjs|ts)$/)) {
    return { scope: RELOAD_SCOPE.RELOAD, reason: '代码变更，需重载插件', files }
  }
  return { scope: RELOAD_SCOPE.HOT, reason: '仅配置变更，可热生效', files }
}
