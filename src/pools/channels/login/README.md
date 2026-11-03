# cs-myfree 登录器模块（18 家渠道）

统一状态机在 `index.js`，流类型映射在 `flow-map.js`。

## 契约（不可破坏）

每个登录器模块导出 `start<Flow>(provider, ch) -> initial`，可再导出 `poll(session, opts)`：

```js
// initial 形状
{
  flow: 'browser'|'device'|'qr'|'paste'|'aksk',
  url?: string,            // 浏览器授权 URL
  qr?: string,             // 二维码内容（文本，前端自行渲染）
  shortLink?: string,
  userCode?: string,       // 设备码
  verificationUri?: string,
  interval?: number,       // 轮询间隔秒
  instructions: string[],  // 给用户看的中文步骤
  // poll 需要但不应回给前端的私有字段（_开头）
  _pkce?, _keyPair?, _server?, _deviceCode?, _session?
}

// poll(session, opts) 返回
{ state: 'pending'|'waiting'|'ok'|'error', hint?: string, credential?: object, maskedAccount?: string, error?: string }
```

## 铁律

1. **凭据绝不进日志/响应**：`poll` 的 `credential` 字段会被状态机取走，**不会**出现在 HTTP 响应里。
2. **未真机验证的渠道必须在 flow-map.js 标 `loginVerified: false`**，不得假装可用。
3. 零第三方依赖：只用 `node:*`。参考包用了 `jose`，**必须换成 `node:crypto` 重写**（ES256 JWS 可用 `crypto.createSign` / 手工 JWS）。
4. 临时 HTTP 服务器用完必须关（`server.close()`），端口用 0 自动分配。
5. 轮询要有超时（≤5 分钟）与取消支持。

## 参考实现（只读）

`/home/ubuntu/plugins/my-free-model/node_modules/dsh-codearts-auth/lib/`
- `oauth.js` — PKCE + DPoP + STS token 交换（codearts / officeace / minimax）
- `qoder.js` + `qoder-oauth.js` — 设备码轮询（404 = 等待，非错误）
- `cline-product.js` + `cline-oauth.js` — WorkOS 设备码
- `loomy.js` + `loomy-sign.js` + `loomy-oauth.js` — QR/短信 + HMAC 签名
- `raccoon-qr.js` / `minimax-oauth.js` / `trae-oauth.js` / `zcode-login.js` / `gemini-oauth.js` / `accio-oauth.js` / `buddy-oauth.js` / `lobsterai-oauth.js` / `officeace-auth.js`
