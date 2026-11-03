/**
 * cs-myfree — 各渠道「签到/领积分/余额」能力实况表
 *
 * 依据：2026-11-03 渠道调研（对拍 dsh-codearts-auth@1.10.261021 的
 * `*-credits.js`）。**不实现就明确标注**，绝不返回假的 0 或假成功。
 *
 * 每项：
 *   checkin  是否已实现「每日签到/领积分」（true 且 verified=true 才是实测通过）
 *   credits  是否已实现「余额/积分查询」
 *   verified 是否在本机用真实凭据实测过
 *   endpoint 参考实现里的真实端点（供后续补齐，本插件未接的也列出来）
 *   reason   不可用/未验证的原因（UI 直接展示）
 *
 * @module cs-myfree/pools/channels/credits/capabilities
 */

export const CREDITS_CAPABILITIES = Object.freeze({
  codearts: {
    checkin: true,
    credits: true,
    verified: true,
    endpoint: {
      balance: 'GET https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/statistics/plugin',
      activities: 'GET /v1/ops/delivery?channel=IDE',
      claim: 'POST /v1/ops/claim {campaignId, channel:"IDE"}',
      confirm: 'POST /v1/ops/confirm {campaignId}',
    },
    note: 'SDK-HMAC-SHA256 直签，本机实测可用',
  },
  minimax: {
    checkin: false, credits: false, verified: false,
    endpoint: {
      status: 'GET {host}/minimax-cloud/api/v1/signin/status?timezone_id=<IANA>',
      claim: 'POST {host}/minimax-cloud/api/v1/signin/claim?timezone_id=<IANA>',
      balance: 'GET {host}/minimax-cloud/api/v1/credit/details',
    },
    reason: '需有效 OAuth token；本插件未实现 token 兑换，未实测',
  },
  minimaxintl: {
    checkin: false, credits: false, verified: false,
    endpoint: { status: '同上（agent.minimax.io，307 需重建 Authorization）' },
    reason: '需有效 OAuth token；另有跨域 307 丢 Authorization 的坑，未实现',
  },
  loomy: {
    checkin: false, credits: false, verified: false,
    endpoint: {
      balance: 'GET https://loomyad.xunfei.cn/api/v1/points/records?pageNo=1&pageSize=1&recordType=all',
      claim: 'POST /api/v1/points/first-login',
    },
    reason: '需扫码/短信登录换 token（本插件未实现 token 兑换），未实测',
  },
  qoder: {
    checkin: false, credits: false, verified: false,
    endpoint: {
      balance: 'GET {openApiBase}/sash/api/v2/me/usage',
      campaigns: 'GET /sash/api/v1/me/campaigns',
      claim: 'POST /sash/api/v1/me/campaigns/{campaignId}/claim（body 空）',
    },
    reason: '需设备码登录换 token + 专属客户端头；本插件未实现，未实测。' +
      '注意：活动每日 10:00(UTC+8) 才刷新，上午领取属于「昨天」',
  },
  qodercn: {
    checkin: false, credits: false, verified: false,
    endpoint: { claim: '加密网关（WASM 信封），无公开 OpenAI 端点' },
    reason: '公开端点已下线（实测 404），真链路为 WASM 加密，本插件无实现',
  },
  trae: {
    checkin: false, credits: false, verified: false,
    endpoint: {
      status: 'POST /trae/api/v2/ug/checkin_credits/status',
      claim: 'POST /trae/api/v2/ug/checkin_credits/claim',
    },
    reason: '需 Cloud-IDE-JWT + 7 个客户端头 + SOLO 协议信封；本插件未实现，未实测',
  },
  lobsterai: {
    checkin: false, credits: false, verified: false,
    endpoint: {
      slot: 'GET /api/client-activities/slot?placement=…&clientVersion=…',
      context: 'GET /api/client-activities/{activityCode}/context?configRevision=…',
      claim: 'POST /api/client-activities/{activityCode}/actions/check_in',
    },
    reason: '需有效 access_token（登录换取未实现）+ 客户端版本参数，未实测',
  },
  buddy: { checkin: false, credits: false, verified: false, reason: '需 cli-external-link OAuth 换 token；本插件未实现' },
  workbuddy: { checkin: false, credits: false, verified: false, reason: '需 OAuth 换 token；本插件未实现（域名已修为真实入口）' },
  cline: { checkin: false, credits: false, verified: false, reason: '参考实现明确「不支持每日签到」；且需 WorkOS 设备码换 token' },
  raccoon: { checkin: false, credits: false, verified: false, reason: '参考实现明确「不支持每日签到」（每日积分由服务端自动发放）' },
  zcode: { checkin: false, credits: false, verified: false, reason: '签到需现场产阿里云验证码（有代价），本插件不自动做' },
  officeace: { checkin: false, credits: false, verified: false, reason: '需 OAuth 换 token；自动领取未实现' },
  accio: { checkin: false, credits: false, verified: false, reason: '无签到端点（每日积分由登录触发），且需 AK/SK 签名协议' },
  opencode: { checkin: false, credits: false, verified: false, reason: '上游 403 FreeTierError，无可领取积分' },
  gemini: { checkin: false, credits: false, verified: false, reason: '本机网络不可达（HTTPS 超时）' },
  qiniu: { checkin: false, credits: false, verified: false, reason: '无每日签到端点' },
})

/** 取某渠道能力（未知渠道返回全 false + 原因） */
export function capabilityOf(provider) {
  return CREDITS_CAPABILITIES[provider] ?? {
    checkin: false, credits: false, verified: false,
    reason: '未登记的渠道（本插件没有该渠道的积分/签到实现）',
  }
}

/** 可自动签到的渠道清单（checkin=true 且 verified=true） */
export function autoCheckinProviders() {
  return Object.entries(CREDITS_CAPABILITIES)
    .filter(([, c]) => c.checkin === true && c.verified === true)
    .map(([id]) => id)
}
