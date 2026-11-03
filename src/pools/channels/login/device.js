// cs-myfree 登录器：device 流（渠道端点未取证，诚实降级）
export function startDevice(provider, ch) {
  return {
    flow: 'device',
    userCode: null,
    verificationUri: null,
    interval: 5,
    instructions: ['本渠道登录端点未取证，请在厂商官网登录后粘贴 token 到账号保存'],
  }
}

export async function pollDevice(session, opts = {}) {
  if (opts?.cancel) return { state: 'cancelled' }
  return { state: 'pending', hint: 'device flow 等待' }
}
