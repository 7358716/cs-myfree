# cs-myfree

> 免费模型提供方（DSH 插件）· 零第三方依赖 · 可独立安装使用

集成了 **ourfree** 与 **dsh-providers-hub** 的全部核心能力：供给、降级链、渠道层、搜索、识图、费用管控、本地网关、模型工作台。

## 当前真实状态（v1.9.0，2026-11-03 实测）

> 这张表是「跑过之后再写」的，不按设计稿写。✅=本机实测通过；⚠️=部分可用/有限制；❌=未实现。

| 能力 | 状态 | 说明 |
|---|---|---|
| 免费模型（Kilo） | ✅ | `kilo-auto/free` 实测 1.3s，支持工具调用 |
| 免费模型（OVH） | ✅ | 备用；冷启动可达 43s，易触发超时 |
| Pollinations | ❌ 已默认移除 | 每 IP 每 45 秒仅 1 次，连续对话必然 402 |
| 工具调用（bash/read/write…） | ✅ | v1.8.0 修复：宿主 `options.tools` 映射 + tool 结果回放 + 流式聚合 |
| 长回答完整性 | ✅ | v1.8.0 修复：提交点之后不再丢增量（此前只输出第一段） |
| 选哪个模型就走哪个 | ✅ | v1.8.0 修复：请求的模型优先直连，失败才按链降级 |
| 降级链（页面可编辑、存了即生效） | ✅ | chain-overrides.json 是唯一事实来源，重启后一致 |
| CodeArts 渠道（AK/SK 签名） | ✅ | SDK-HMAC-SHA256 实测 200；注意上游「并发会话 3 个」上限 |
| 其余 17 家渠道 | ⚠️ 未实现登录换取 | 端点/鉴权已按真实协议登记，但缺少 OAuth/设备码换 token，**登录后仍不可用** |
| 识图 | ⚠️ 默认关闭 | 需在配置里开启；所有模型默认声明为纯文本模态 |
| 搜索 provider | ✅ 已注册 | 但宿主若已装 dsh-free-search，会优先用它的 provider |
| 账号池/签到/续期 | ⚠️ 纯函数库 | 有算法与单测，但未接宿主事件（不会自动跑） |
| 本地 OpenAI 兼容网关 | ⚠️ 库 | `createGateway` 可创建，但插件默认不监听端口 |
| 费用/用量账本 | ✅ | v1.8.0 起记录 in/out tokens（此前恒为 0） |
| 安全围栏 | ✅ | v1.8.0 修掉「伪造 cookie 即可读写」的认证绕过（现委托宿主 connection 验签） |

## v1.9.0 新增：一键登录 / 续期 / 测试 / 删除 / 自动签到

| 能力 | 状态 | 说明 |
|---|---|---|
| 华为 CodeArts 一键登录 | ✅ 真实现 | ticket 兑换 + 浏览器授权；回调走**宿主公网地址**（远程部署下的关键修复） |
| 腾讯 CodeBuddy / WorkBuddy | ⚠️ 端点已对拍 | 轮询式（无回调）；完整 token 交换待浏览器实际登录一次 |
| 讯飞 Loomy 扫码 | ⚠️ 链路已通 | 微信扫码 → uuid → 长轮询；HMAC 签名已被讯飞服务端接受；待真机扫码闭环 |
| 其余 14 家 | ❌ 未取证 | flow-map 里 `loginVerified:false` + note；UI 标「未验证/暂不可用」，**不假装可用** |
| 续期（refresh） | ⚠️ 部分 | refresh_token 已落盘；codearts 走 AK/SK 长期有效；loomy 如实提示「14 天人工重登」 |
| 一键测试连通 | ✅ | `POST /login/test` 真发最小推理请求，返回耗时与失败分类 |
| 一键删除账号 | ✅ | `POST /accounts/remove`（UI 有二次确认） |
| 自动领积分/签到 | ✅ codearts 实测 | 真机：账户积分 4532.57、签到幂等（已领取）；其余渠道按能力表标不支持 |
| 签到/续期定时器 | ✅ | setTimeout 链 + unref；`/checkin/status` 可查 alive/nextAt；开关即时启停 |

> 🔴 **部署提醒**：一键登录依赖 OAuth 回调，回调地址由**本次请求的 Host 头**推导
> （不再依赖 profile 配置）。若前面有 nginx/反代，请确保 `Host` 原样透传。

## 安装

```bash
# 从 git
dsh plugin --profile <name> add github:7358716/cs-myfree

# 或从本地目录
dsh plugin --profile <name> add /path/to/cs-myfree
```

装完重启 DSH，设置页出现「免费模型」分节即成功。

## 核心保证

| 保证 | 怎么做到 |
|---|---|
| **零第三方依赖** | `dependencies` 为空；只用 Node 内置模块 |
| **装完就能用** | 3 个免密源（Kilo / OVH / Pollinations），**不需要任何账号或 Key** |
| **不会把免费额度用错** | 免密端点绝不发 `Authorization`；付费源默认禁用 |
| **费用可控** | 五道付费闸门，deny-by-default，价格未知即拒 |
| **长期稳定** | 聚合路由按「临期最早」优先消耗；渠道健康自动移出 |

## 能力清单

### 供给层
- **免密池**（3 源，实测全可用）：Kilo 382 模型/11 免费 · OVH 4 模型（含视觉）· Pollinations
- **18 个账号渠道**：CodeArts / CodeBuddy / WorkBuddy / LobsterAI / Qoder / Qoder CN / TRAE / Cline / Loomy / Raccoon / MiniMax / MiniMax Intl / ZCode / OpenCode / Gemini / OfficeAce / Accio / Qiniu
- **多账号池**：余额排序、失败冷却、临期提醒
- **签到**：11 家支持；记账用 `coversToday`（避 Qoder 10:00 刷新漏领）
- **续期**：有 refresh 的静默续；Loomy 无续期端点 ⇒ 提前 24h 告警人工重登

### 降级链
- **6 层**：L0 重试 → L1 换号 → L2 换渠道 → L3 换模型 → L4 降档 → L5 上报
- **提交点机制**：`reasoning-delta` 不算提交 ⇒ 「想很久才撞墙」能静默切换，用户零感知
- **用户覆盖层**：钉选 / 替换 / 增删 / 排序，`mergeChain()` 唯一入口保证「页面显示 == 实际选路」
- **重试权收归自己**：`maxRetries=1`，`retryableCodes` 排除 `RATE_LIMIT`

### 本地网关（OpenAI 兼容）
- `POST /v1/chat/completions` — OpenAI
- `POST /v1/messages` — **Anthropic 原生**
- `POST /v1beta/models/*:generateContent` — Gemini
- `GET /v1/models` · `GET /health`
- 双门双钥、拒绝通配监听、防自环

### 其他
- **多源搜索**：bing-rss / bing-html / sogou / mwmbl，融合去重 + 域名轮转
- **识图**：四档位（默认 off），OVH 免费视觉链
- **省 Token**：RTK 工具输出压缩（三条不可触碰边界）
- **升级**：签名校验 + 原子替换 + 有序回滚
- **信任围栏**：默认拒绝，删文件永不自动
- **账本**：cost / free 严格区分，未知不当 0
- **工作台**：12 个功能区

## 验证

```bash
npm test            # 232 项单元测试
npm run test:static # 结构/零依赖/exports/语法/patch/import 六项
node test/live/keyless-probe.mjs   # 真实联网探测免密池
```

## 许可

MIT
