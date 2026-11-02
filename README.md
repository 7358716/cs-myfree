# cs-myfree

> 免费模型提供方（DSH 插件）· 零第三方依赖 · 可独立安装使用

集成了 **ourfree** 与 **dsh-providers-hub** 的全部核心能力：供给、降级链、渠道层、搜索、识图、费用管控、本地网关、模型工作台。

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
