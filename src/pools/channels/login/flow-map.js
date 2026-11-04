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
import { startQoder, pollQoder } from './qoder.js'
import { startCline, pollCline } from './cline.js'
import { startMinimax, pollMinimax } from './minimax.js'
import { startOfficeAce, pollOfficeAce } from './officeace.js'
import { startTrae, pollTrae } from './trae.js'
import { startAccio, pollAccio } from './accio.js'
import { startRaccoon, pollRaccoon } from './raccoon.js'
import { startBuddy, pollBuddy } from './buddy.js'
import { startWorkbuddy, pollWorkbuddy } from './workbuddy.js'
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
  // buddy / workbuddy：external-link-v2 **轮询式**（没有 redirect_uri/code 交换；
  // authUrl 由 POST /v2/plugin/auth/state 现场下发，poll 用厂商 state 轮询 token）。
  // 端点已真机对拍（auth/state 200、token 轮询 code=11217），完整 token 交换
  // 需用户浏览器实际登录后验证 ⇒ loginVerified 暂保持 false。
  buddy: {
    type: FLOW_TYPE.BROWSER,
    start: startBuddy,
    poll: pollBuddy,
    loginVerified: false,
    loginNote: '腾讯 CodeBuddy：轮询式登录，端点已真机对拍；完整 token 交换待用户浏览器登录验证',
  },
  workbuddy: {
    type: FLOW_TYPE.BROWSER,
    start: startWorkbuddy,
    poll: pollWorkbuddy,
    loginVerified: false,
    loginNote: 'WorkBuddy 国际：轮询式登录，端点已真机对拍；完整 token 交换待用户浏览器登录验证',
  },
  trae: {
    type: FLOW_TYPE.BROWSER, start: startTrae, poll: pollTrae,
    loginVerified: false, loginNote: 'TRAE 字节：17 参授权 + ExchangeToken（端点已对拍），待真机验证',
  },
  accio: {
    type: FLOW_TYPE.BROWSER, start: startAccio, poll: pollAccio,
    loginVerified: false, loginNote: 'Accio 阿里：PKCE + return_url 回调（端点已对拍），待真机验证',
  },
  gemini: { type: FLOW_TYPE.BROWSER, loginVerified: false, loginNote: 'Gemini Code Assist：本机网络不可达' },
  officeace: {
    type: FLOW_TYPE.BROWSER, start: startOfficeAce, poll: pollOfficeAce,
    loginVerified: false, loginNote: 'OfficeAce 华为 MaaS：云侧 state + PKCE + DPoP（端点已对拍），待真机验证',
  },
  lobsterai: { type: FLOW_TYPE.BROWSER, loginVerified: false, loginNote: 'LobsterAI 有道：端点待取证' },
  // ── 设备码 ──
  qoder: {
    type: FLOW_TYPE.DEVICE,
    start: startQoder,
    poll: pollQoder,
    loginVerified: false,
    loginNote: 'Qoder：设备码+PKCE 轮询（端点已对拍），待真机验证',
  },
  qodercn: {
    type: FLOW_TYPE.DEVICE,
    start: startQoder,
    poll: pollQoder,
    loginVerified: false,
    loginNote: 'Qoder 中国版：设备码+PKCE 轮询（端点已对拍），公开端点可能已失效',
  },
  cline: {
    type: FLOW_TYPE.DEVICE,
    start: startCline,
    poll: pollCline,
    loginVerified: false,
    loginNote: 'Cline：WorkOS 标准设备码（端点已对拍），待真机验证',
  },
  minimax: {
    type: FLOW_TYPE.DEVICE, start: startMinimax, poll: pollMinimax,
    loginVerified: false, loginNote: 'MiniMax 中国版：OAuth 设备码+PKCE（端点已对拍），待真机验证',
  },
  minimaxintl: {
    type: FLOW_TYPE.DEVICE, start: startMinimax, poll: pollMinimax,
    loginVerified: false, loginNote: 'MiniMax 国际版：OAuth 设备码+PKCE（端点已对拍），待真机验证',
  },
  zcode: { type: FLOW_TYPE.DEVICE, loginVerified: false, loginNote: 'ZCode 智谱：设备码+验证码，端点待取证' },
  // ── QR 扫码 ──
  loomy: {
    type: FLOW_TYPE.QR,
    start: startLoomy,
    poll: pollLoomy,
    // ✅ 2026-11-04 真机验证通过：用户扫码登录成功 + POST /login/test 返回
    //    ok:true / 1591ms「上游已开始流式返回」
    loginVerified: true,
    loginNote: 'Loomy 讯飞：微信扫码；无续期端点，14 天后需重新扫码',
  },
  raccoon: {
    type: FLOW_TYPE.QR, start: startRaccoon, poll: pollRaccoon,
    loginVerified: false, loginNote: 'Raccoon 商汤：微信扫码（端点已对拍，无需验证码），待真机验证',
  },
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
    start,                       // 便于测试/诊断直接取用（状态机走 initial）
    initial: (p, c, opts) => start(p, c, opts),
    poll,
    loginVerified: entry?.loginVerified ?? false,
    loginNote: entry?.loginNote ?? '',
  }
}
