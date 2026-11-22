# cs-myfree

Myfree — 提供 18 个 AI 渠道接入（DSH 插件，零第三方依赖）。

## 安装

```bash
dsh plugin --profile web add github:7358716/cs-myfree#v1.9.30
```

重启 DSH → 设置页出现「Myfree」分节。

## 渠道接入实况（v1.9.8 起实测，最近核对 2026-11-22）

| 渠道 | 登录方式 | 状态 |
|---|---|---|
| CodeArts（华为云） | ticket 兑换 + 浏览器授权 / AK·SK | ✅ 真实现，实测通 |
| CodeBuddy（腾讯） | 轮询式（打开官方登录页即自动完成） | ✅ 真实现，端点+准入头已修 |
| WorkBuddy（国际） | 轮询式 | ✅ 真实现 |
| Qoder / Qoder CN | 设备码 + PKCE 轮询 | ✅ 真实现 |
| Cline | WorkOS 标准设备码 | ✅ 真实现 |
| MiniMax / MiniMax 国际 | OAuth 设备码 + PKCE | ✅ 真实现 |
| OfficeAce（华为 MaaS） | 云侧 state + PKCE + DPoP | ✅ 真实现 |
| Loomy（讯飞） | 微信扫码 | ✅ 真实现，实测扫码即登录 |
| TRAE（字节） | 17 参授权 + ExchangeToken | ✅ 真实现 |
| Accio（阿里） | PKCE + return_url 回调 | ✅ 真实现 |
| Raccoon / ZCode | 扫码 / 短信验证码 | ⚠️ 需输入验证码，未实现 |
| LobsterAI | 官方限定 127.0.0.1 回调 | ⚠️ 远程部署下不可用 |
| Gemini | 浏览器授权 | ⚠️ 本机网络不可达 |
| Qiniu / OpenCode | 粘贴 API Key | ✅ 粘贴即用 |

> 状态实时可查：`GET /cs-myfree/login/status`（每家 `loginVerified` + `note`）。
> **未验证的渠道 UI 会标「未验证」**，不假装可用。

## 一键操作（设置页供给源）

- **一键登录**：点按钮 → 浏览器自动打开官方登录页 → 授权后插件自己拿 token 并落盘
- **一键测试**：`POST /login/test` 真发流式请求，返回耗时与失败分类
- **一键续期**：`POST /login/refresh`（无续期端点的渠道如实提示「需人工重登」）
- **一键删除**：`POST /accounts/remove`（二次确认）
- **全部测试 / 全部续期**：批量跑并汇总

## 降级链

- 页面**全部下拉选择**（渠道 / 模型 / 优先级），不再手输
- 「设为首选」一键置顶；上移/下移/删除/清空
- `chain-overrides.json` 是唯一事实来源，保存即生效、重启一致

## ⚠️ 实验特性（未接线，不生效）

以下能力**代码已写好、但未接入真实请求路径**，打开开关也不会有任何行为变化。
写在这里是为了不让人误以为可用。

| 特性 | 开关 | 现状 |
|---|---|---|
| **探测路由**（`src/adapter/probe-route.js`） | `routing.useProbeRoute` | **未接线**：①选路主循环不调用 `planRoute()`；②开关只被读入上报，不参与分支判断；③`/model-chain` 的 `route` 字段恒为 `null` |

- 探测路由的设计是：只从「探测可用」的集合里选路（免费池优先 / 付费 fail-closed /
  失败登记重试计划 / 全挂时抛详细错误）。
- 它目前**只用到** `buildDetailedError()` 来拼「全部可用模型失败」的错误文案。
- HTTP 层同理：`web/routes.js` 的 `/model-chain` 给 `opts.planRoute` 留了口子，但
  `src/index.js` 注册路由时**没有注入** ⇒ 实测 `GET /model-chain` 返回 `route: null`、
  `POST /probe/refresh` 返回 `probe not configured`。
- 启用它是一个独立的改造项：要把 `planRoute()` 接进 `adapter.stream()`、让探测器真跑、
  补端到端测试与灰度方案 —— 不是打开开关就完事。
- 护栏：`test/probe-route.test.mjs` 会断言「`planRoute` 零调用」与「开关开/关选路一致」，
  所以**一旦有人真的接线，测试会立刻提醒去同步文档**。

## 自动领积分 / 签到

- 定时器（setTimeout 链 + unref）+ 手动一键
- CodeArts 真机实测：积分查询、签到幂等（已领取不会重复领）
- 其余渠道按能力表逐家标 `checkin: false` + 原因，绝不假成功

## 安全红线

- 凭据只存 `~/.dsh/cs-myfree/accounts.json`（**0600**，目录 0700）
- 日志全程脱敏；HTTP 响应只回掩码
- 路由围栏：伪造 cookie 一律 401（委托宿主 `connection` 验签，拿不到即 fail-closed）
- 凭据绝不进代码、绝不进日志

## 验证

```bash
npm test             # 1081 项
npm run test:static  # 零依赖 / exports / 语法 / 结构
```

## 许可

MIT
