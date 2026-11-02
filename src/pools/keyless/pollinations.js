/**
 * cs-myfree — Pollinations 免密（最快可用，能力较弱）
 * 实测（2026-11-02）：`text.pollinations.ai/<prompt>` → 200 / 2.14s
 * @module cs-myfree/pools/keyless/pollinations
 */

export const POLL_BASE = 'https://text.pollinations.ai'
export const KEYLESS = true

export async function* stream({ messages = [], model = 'openai', signal, fetchImpl = globalThis.fetch, timeoutMs = 45_000 } = {}) {
  const prompt = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).filter(Boolean).join('\n')
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  signal?.addEventListener?.('abort', onAbort)
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const now = () => Date.now()
  try {
    const url = `${POLL_BASE}/${encodeURIComponent((prompt || 'hello').slice(0, 2000))}?model=${encodeURIComponent(model)}`
    const res = await fetchImpl(url, {
      headers: { accept: 'text/plain', 'user-agent': 'Mozilla/5.0 (compatible; cs-myfree)' },
      signal: ctrl.signal,
    })
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
    const text = await res.text()
    if (text) yield { type: 'text-delta', text, at: now() }
    yield { type: 'finish', reason: { kind: 'stop' }, at: now() }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}
