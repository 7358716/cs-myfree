/**
 * DSH Context Bridge — 内容脚本
 *
 * 职责：只做一件事 —— 把 DeepSeek 网页版**当前页面**的对话，按「最近 N 条」抓下来，
 * 定期 POST 给本机 DSH。绝不读取侧栏历史、绝不上传 cookie、绝不写回页面。
 *
 * 🔴 三条纪律（与 DSH 侧 bridge.js 对应）：
 *   1. 传得少：只取最近 maxMessages 条，每条截断 maxChars 字
 *   2. 只读：不改 DOM、不点按钮、不提交输入
 *   3. 不抓敏感：只取消息正文与角色，绝不抓 token/cookie/账号信息
 */

const DEFAULTS = {
  endpoint: 'http://150.158.175.241/cs-myfree/context/deepseek',
  code: '',
  maxMessages: 20,
  maxChars: 200,
  intervalMs: 30000,
  enabled: false,
}

let timer = null

/** 从 storage 读配置 */
async function loadConfig() {
  try {
    const got = await chrome.storage.local.get(Object.keys(DEFAULTS))
    return Object.assign({}, DEFAULTS, got)
  } catch {
    return Object.assign({}, DEFAULTS)
  }
}

/**
 * 抓取当前页面的对话消息。
 *
 * DeepSeek 网页版 DOM 结构会变，所以不写死单一选择器：
 * 用「候选选择器列表 + 结构启发式」双重兜底，任一命中就返回。
 * 拿不到就如实返回空数组（**绝不编造消息**）。
 *
 * @param {number} maxMessages
 * @param {number} maxChars
 */
function scrapeMessages(maxMessages, maxChars) {
  const out = []

  // ── 候选 1：常见的消息容器（按经验优先）──
  const containerSelectors = [
    '[class*="message"]',
    '[class*="chat-message"]',
    '[class*="conversation"] [class*="item"]',
    'div[data-message-id]',
  ]

  let nodes = []
  for (const sel of containerSelectors) {
    try {
      const found = Array.from(document.querySelectorAll(sel))
      // 只接受「看起来像消息」的节点：有文本、长度合理、不是整页容器
      const plausible = found.filter((n) => {
        const t = (n.innerText || '').trim()
        return t.length >= 2 && t.length < 20000 && n.children.length < 30
      })
      if (plausible.length >= 1 && plausible.length <= 200) {
        nodes = plausible
        break
      }
    } catch { /* 选择器非法就跳过 */ }
  }

  for (const n of nodes) {
    const text = String(n.innerText || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    // 角色判定：优先看 class/data 属性，拿不到就按位置猜（偶数 user / 奇数 assistant）
    let role = 'user'
    const cls = String(n.className || '')
    const aid = String(n.getAttribute?.('data-author') || n.getAttribute?.('data-role') || '')
    if (/assistant|bot|ai|reply|answer/i.test(cls) || /assistant|bot|ai/i.test(aid)) role = 'assistant'
    else if (/user|human/i.test(cls) || /user|human/i.test(aid)) role = 'user'
    else role = out.length % 2 === 0 ? 'user' : 'assistant'

    out.push({
      role,
      text: text.length > maxChars ? text.slice(0, maxChars) : text,
      at: Date.now(),
    })
  }

  return out.slice(-maxMessages)
}

/** 上报一次 */
async function pushOnce(cfg) {
  if (!cfg.enabled) return { ok: false, error: '未启用（在扩展弹窗里打开）' }
  if (!cfg.code) return { ok: false, error: '还没有配置口令（DSH 设置页「外部上下文」）' }
  const messages = scrapeMessages(cfg.maxMessages, cfg.maxChars)
  if (messages.length === 0) return { ok: false, error: '当前页面没抓到对话（可能还没开始聊，或页面结构变了）' }

  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-context-token': cfg.code },
      body: JSON.stringify({
        threadId: location.pathname,
        url: location.href,
        messages,
        maxMessages: cfg.maxMessages,
        maxCharsPerMessage: cfg.maxChars,
      }),
    })
    const data = await res.json().catch(() => ({}))
    return res.ok ? { ok: true, data, sent: messages.length } : { ok: false, error: data?.error || ('HTTP ' + res.status) }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** 启动/重启定时上报 */
async function restartTimer() {
  if (timer) clearInterval(timer)
  const cfg = await loadConfig()
  if (!cfg.enabled) return
  timer = setInterval(() => { pushOnce(cfg).catch(() => {}) }, Math.max(10000, Number(cfg.intervalMs) || 30000))
}

// 启动
restartTimer().catch(() => {})
try {
  chrome.storage.onChanged.addListener(() => { restartTimer().catch(() => {}) })
} catch { /* 老浏览器没有 onChanged */ }

// 供 popup 手动触发
try {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'push-now') {
      loadConfig().then((cfg) => pushOnce(cfg)).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e) }))
      return true
    }
    if (msg?.type === 'scrape-preview') {
      loadConfig().then((cfg) => {
        const msgs = scrapeMessages(cfg.maxMessages, cfg.maxChars)
        sendResponse({ ok: true, count: msgs.length, sample: msgs.slice(-2) })
      }).catch((e) => sendResponse({ ok: false, error: String(e) }))
      return true
    }
    return false
  })
} catch { /* 无 runtime 权限时忽略 */ }