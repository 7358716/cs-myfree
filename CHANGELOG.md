# 变更日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循 semver。
**每条修复都写「根因」与「回归用例」，防止同一个坑再踩一次。**

## [未发布] - 2026-11-22

### 文档

- **探测路由明确降级为实验特性（P0-③）**：在 README 新增「⚠️ 实验特性（未接线，不生效）」一节
  - 事实核对（不是猜测，含线上实测）：
    · **选路**：`planRoute()` 在选路/降级主循环里零调用，没接进 `adapter.stream()`；
    · **开关**：`routing.useProbeRoute` 只被读入并上报，**不参与任何分支判断** ⇒ 开与关选路一致；
    · **HTTP**：`/model-chain` 给 `opts.planRoute` 留了口子，但 `src/index.js` 注册路由时
      没注入 ⇒ 线上实测 `route: null`、`/probe/refresh` 返回 `probe not configured`；
    · 整个模块里只有 `buildDetailedError()` 真正在用（拼错误文案）。
  - 因此**不建议**在任何地方把 `useProbeRoute` 说成可用能力；启用它是独立改造项
    （接 `planRoute()` 进 `stream()` + 探测器真跑 + 端到端测试 + 灰度）。
- `src/adapter/probe-route.js` 文件头、`src/adapter/index.js` 的 import 处与开关赋值处
  均加了显式「未接线」注释。

### 测试

- 新增 `test/probe-route.test.mjs`（10 例）作为最小护栏：
  构造失败→选路、全挂时候选为空、付费 fail-closed、冷启动兜底、重试计划累加、
  详细错误文案区分付费拦截与真全挂；
  以及**事实核对**四条：选路主循环不调用 `planRoute`、HTTP 层未注入（`route` 恒 null）、开关开/关选路一致、文件头保留「未接线」声明。
  → 一旦有人真的接线，这三条会立刻变红，提醒同步文档。

### 顺带

- README 安装示例版本号 v1.9.8 → v1.9.30（落后 21 个版本）；测试条数 692 → 1080。

## [1.9.30] - 2026-11-22

### 修复

- **瞬态失败不再“一失败就换源”（P0-①）**：降级链的 L0 原地重试真正接进主循环
  - 根因：`ladder.onFailure()` 早就按 `retryPerRoute`（默认 2）判好了「瞬态失败 ⇒ 原地重试 /
    超限 ⇒ 换渠道」，但主循环只消费了 `action === 'report'`，收到 `retry` 与收到
    `swap-channel` 一样都直接进 `for` 的下一轮 ⇒ 一次 503 之后 0ms 就换了渠道，
    `retryPerRoute` 从未生效（全仓它只在 ladder.js 里被读过一次）。
  - 现在：候选内先按 `retryPerRoute` 原地重试（退避 200/400ms，不越过 Retry-After 与
    本回合剩余时长），**耗尽后才换下一个渠道**。
  - 只对瞬态类生效：429 / 403 / 404 / 401 等分支行为**完全不变**（仍走换号/换渠道/换模型）。
  - 回归用例：`test/in-place-retry.test.mjs`（13 例，含「同一渠道被调用 2 次后才切换」）

- **失败尝试的 reasoning 增量会泄漏给用户**
  - 根因：`held.discard()` 从未被调用。`buffered` 里已装进缓冲区的 reasoning 增量在失败后
    没有被清掉；改造前因为「一失败就换源、`buffered` 是局部变量」侥幸没漏，
    接上原地重试后同一段输出会在恢复时一起放出去 ⇒ 用户看到「想了一下」重复两次。
  - 现在：流中途抛错即 `held.discard()` + 清空 `buffered`。
  - 回归用例：`test/in-place-retry.test.mjs` ⑧

- **已提交后失败会重复发送**
  - 根因：主循环里 `break` 只跳出内层重试循环，外层 `for` 会继续翻下一个候选；
    补救路径（second-attempt / last-resort）也没检查“内容已经吐给用户”。
  - 现在：已提交后失败 ⇒ `committed-failure` 事件 + **两层一起跳出**，一切补救关闭。
  - 回归用例：`test/in-place-retry.test.mjs` ④

### 变更

- **二次尝试（second-attempt）与 last-resort 不再与原地重试叠加**
  - 两者都在事后对同一候选补一次，与主循环的原地重试完全重叠；叠加后同一渠道会被打
    3~4 次。现在只要本回合发生过原地重试，这两条补救路径即关闭（保留代码以兼容旧行为）。
- **ladder 的 `retry` 语义补充注释**：`routesTried` 按 `provider/model` 累计，
  稍内重试必须在**同一候选**上，否则计数会被下一个路由继承。

### 注意

- 需重启 dsh-web 才生效：**是**（插件代码变更）
- 本次为行为变更（同一渠道的尝试次数变多），**不发布**，交发布管理员评估后发布。

## [1.9.29] - 2026-11-18

### 修复

- 修版本号硬编码导致前端一直加载旧缓存
  - 根因：`src/index.js` 写死 `'1.9.23'`，而 package.json 已到 1.9.28
  - 现在：`createRequire` 读 package.json；前端只认 `/state` 下发的 version
