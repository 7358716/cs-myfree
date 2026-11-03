// cs-myfree 登录器：browser 流（渠道端点未取证，诚实降级）
export function startBrowser(provider, ch) {
  return {
    flow: 'browser',
    url: null,
    instructions: ['本渠道登录端点未取证，请在厂商官网登录后粘贴回调链接 / code 到账号保存'],
  }
}

export async function pollBrowser(session, opts = {}) {
  if (opts?.cancel) return { state: 'cancelled' }
  return { state: 'pending', hint: 'browser flow 等待本地回调' }
}
