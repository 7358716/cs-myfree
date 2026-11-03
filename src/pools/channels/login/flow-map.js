/**
 * cs-myfree — 登录流类型映射（18 家渠道）
 *
 * 参考：recon2/62-调研-市面渠道协议盘点与供应源候选.md §1.1
 * 本机真实运行的参考包：/home/ubuntu/plugins/my-free-model/node_modules/dsh-codearts-auth/lib/
 *
 * loginVerified=true 表示**本机真机验证通过**；false 一律要在 UI 标「未验证」，
 * 不得假装可用。
 *
 * @module cs-myfree/pools/channels/login/flow-map
 */
import { startAksk } from './aksk.js'
import { startBrowser, pollBrowser } from './browser.js'
import { startDevice, pollDevice } from './device.js'
import { startPaste } from './paste.js'
import { startQr, pollQr } from './qr.js'
import { startCodearts, pollCodearts } from './codearts.js'
import { startLoomy, pollLoomy } from './loomy.js'

export const FLOW_TYPE = Object.freeze({
  AKSK: 'aksk',
  BROWSER: 'browser',
  DEVICE: 'device',
  QR: 'qr',
  PASTE: 'paste',
})

/**
 * 每渠道：{ type, start?, poll?, loginVerified, loginNote }
 *
 * ⚠️ 未提供 start/poll 的渠道会回落到该 type 的通用实现（诚实降级：
 *    只给流程说明，不编造端点）。
 */
export const FLOW_MAP = Object.freeze({
  // ── 真实现（已对拍参考包）──
  codearts: {
    type: FLOW_TYPE.BROWSER,
    start: startCodearts,
    poll: pollCodearts,
    loginVerified: true,
    loginNote: '华为 ticket 兑换：浏览器登录后自动完成（也支持 AK/SK 一步）',
  },
  // ── 浏览器回调 OAuth（端点待逐个取证）──
  buddy: { type: FLOW_TYPE.BROWSER, loginVerified: false, loginNote: '腾讯 CodeBuddy：端点待取证' },
  workbuddy: { type: FLOW_TYPE.BROWSER, loginVerified: false, loginNote: 'WorkBuddy 国际：端点待取证' },
  trae: { type: FLOW_TYPE.BROWSER, loginVerified: false, loginNote: 'TRAE 字节：端点待取证' },
  accio: { type: FLOW_TYPE.BROWSER, loginVerified: false, loginNote: 'Accio 阿里：端点待取证' },
  gemini: { type: FLOW_TYPE.BROWSER, loginVerified: false, loginNote: 'Gemini Code Assist：本机网络不可达' },
  officeace: { type: FLOW_TYPE.BROWSER, loginVerified: false, loginNote: 'OfficeAce 华为 MaaS：OAuth PKCE，端点待取证' },
  lobsterai: { type: FLOW_TYPE.BROWSER, loginVerified: false, loginNote: 'LobsterAI 有道：端点待取证' },
  // ── 设备码 ──
  qoder: { type: FLOW_TYPE.DEVICE, loginVerified: false, loginNote: 'Qoder：设备码轮询，端点待取证' },
  qodercn: { type: FLOW_TYPE.DEVICE, loginVerified: false, loginNote: 'Qoder 中国版：公开端点已失效' },
  cline: { type: FLOW_TYPE.DEVICE, loginVerified: false, loginNote: 'Cline：WorkOS 设备码，端点待取证' },
  minimax: { type: FLOW_TYPE.DEVICE, loginVerified: false, loginNote: 'MiniMax：OAuth PKCE，端点待取证' },
  minimaxintl: { type: FLOW_TYPE.DEVICE, loginVerified: false, loginNote: 'MiniMax 国际：端点待取证' },
  zcode: { type: FLOW_TYPE.DEVICE, loginVerified: false, loginNote: 'ZCode 智谱：设备码+验证码，端点待取证' },
  // ── QR 扫码 ──
  loomy: {
    type: FLOW_TYPE.QR,
    start: startLoomy,
    poll: pollLoomy,
    loginVerified: false,
    loginNote: 'Loomy 讯飞：微信扫码；无续期端点，14 天后需重新扫码',
  },
  raccoon: { type: FLOW_TYPE.QR, loginVerified: false, loginNote: 'Raccoon 商汤：扫码/短信，端点待取证' },
  // ── 粘贴 API Key ──
  qiniu: { type: FLOW_TYPE.PASTE, loginVerified: false, loginNote: 'Qiniu 七牛：粘贴 API Key' },
  opencode: { type: FLOW_TYPE.PASTE, loginVerified: false, loginNote: 'OpenCode：免费层已关闭' },
})

const DEFAULT_START = {
  [FLOW_TYPE.BROWSER]: startBrowser,
  [FLOW_TYPE.DEVICE]: startDevice,
  [FLOW_TYPE.QR]: startQr,
  [FLOW_TYPE.PASTE]: startPaste,
  [FLOW_TYPE.AKSK]: startAksk,
}
const DEFAULT_POLL = {
  [FLOW_TYPE.BROWSER]: pollBrowser,
  [FLOW_TYPE.DEVICE]: pollDevice,
  [FLOW_TYPE.QR]: pollQr,
}

/**
 * 取渠道登录器。
 * @param {string} provider
 * @param {object|null} ch 渠道协议（poll 时可传 null）
 * @param {string} [forcedType] 会话里记录的流类型（poll 时用）
 * @returns {{type:string, initial:Function, poll:Function|null, loginVerified:boolean, loginNote:string}}
 */
export function getFlow(provider, ch, forcedType) {
  const entry = FLOW_MAP[provider]
  const type = forcedType ?? entry?.type ?? FLOW_TYPE.PASTE
  const sameType = !entry || !entry.type || entry.type === type
  const start = (sameType && entry?.start) || DEFAULT_START[type] || startPaste
  const poll = (sameType && entry?.poll) || DEFAULT_POLL[type] || null
  return {
    type,
    initial: (p, c, opts) => start(p, c, opts),
    poll,
    loginVerified: entry?.loginVerified ?? false,
    loginNote: entry?.loginNote ?? '',
  }
}
