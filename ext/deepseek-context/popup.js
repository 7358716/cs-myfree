/**
 * DSH Context Bridge — 弹窗脚本
 *
 * 负责配置读取/保存、立即上报、状态展示。
 * 所有读取/写入都走 chrome.storage.local，由 content script 执行上报。
 */

const DEFAULTS = {
  endpoint: 'http://150.158.175.241/cs-myfree/context/deepseek',
  code: '',
  maxMessages: 20,
  maxChars: 200,
  intervalMs: 30000,
  enabled: false,
}

const $ = (id) => document.getElementById(id)

async function load() {
  const got = await chrome.storage.local.get(Object.keys(DEFAULTS))
  const merged = Object.assign({}, DEFAULTS, got)
  $('endpoint').value = merged.endpoint
  $('code').value = merged.code
  $('maxMessages').value = merged.maxMessages
  $('maxChars').value = merged.maxChars
  $('intervalSec').value = Math.round((merged.intervalMs || 30000) / 1000)
  $('enabled').checked = merged.enabled === true
}

async function save() {
  const cfg = {
    endpoint: $('endpoint').value.trim() || DEFAULTS.endpoint,
    code: $('code').value.trim(),
    maxMessages: Math.max(1, Math.min(200, parseInt($('maxMessages').value, 10) || 20)),
    maxChars: Math.max(20, Math.min(4000, parseInt($('maxChars').value, 10) || 200)),
    intervalMs: Math.max(10000, Math.min(600000, (parseInt($('intervalSec').value, 10) || 30) * 1000)),
    enabled: $('enabled').checked,
  }
  await chrome.storage.local.set(cfg)
  show(cfg.enabled ? '✅ 已保存并启用' : '✅ 已保存（自动上报未启用）', cfg.enabled ? 'ok' : 'err')
  // 触发 content script 重启定时器
  try { await chrome.tabs.sendMessage({ type: 'config-changed' }) } catch { /* 页面可能没开 */ }
}

async function pushNow() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab) return show('❌ 没有当前活动页', 'err')
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'push-now' })
    if (!r) return show('⚠️ 当前页面没有本扩展（只对 chat.deepseek.com 生效）', 'err')
    if (r.ok) show(`✅ 上报成功：发送 ${r.sent} 条`, 'ok')
    else show(`❌ ${r.error || '上报失败'}`, 'err')
  } catch (e) {
    show(`❌ ${e?.message || e}`, 'err')
  }
}

function show(text, kind) {
  const el = $('status')
  el.textContent = text
  el.className = 'status ' + (kind === 'ok' ? 'ok' : 'err')
  el.style.display = 'block'
}

$('save').onclick = save
$('push').onclick = pushNow
load()