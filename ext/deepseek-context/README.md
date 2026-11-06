# DSH 上下文桥（浏览器扩展）

把 **DeepSeek 网页版**当前页面的对话，按「最近 N 条」同步给本机 DSH。
目的是让 DSH 里继续干活时，能拿到你在网页版聊过的上下文——**而且传得少**。

## 装法（Chrome / Edge，约 1 分钟）

1. 把本目录整个拷到你电脑上（这是服务器上的目录，手机/本地要能访问到才行）：
   - 服务器路径：`/home/ubuntu/output2026/butlers/dev/cs-myfree/ext/deepseek-context`
2. 浏览器地址栏打开 `chrome://extensions`（Edge 是 `edge://extensions`）
3. 右上角打开「开发者模式」
4. 点「加载已解压的扩展程序」，选中 `deepseek-context` 目录
5. 扩展列表里出现「DSH Context Bridge」即成功

## 配置（两步）

### 第一步：在 DSH 设置页面配口令

用任何能写 `config.json` 的方式，加入一项：

```json
{
  "contextBridgeCode": "你自己定的一串口令"
}
```

> 也可以让 DSH 的设置页写（若已有该输入项）。**口令不含 token/key 字样**——否则会被敏感字段拦截器拒绝落盘。

### 第二步：在扩展弹窗里填

点浏览器工具栏的扩展图标，填：

| 项 | 填什么 |
|---|---|
| DSH 地址 | `http://150.158.175.241/cs-myfree/context/deepseek` |
| 口令 | 与上面的 `contextBridgeCode` 一致 |
| 最多几条 | 默认 20（**建议别调大**，这是「传得少」的关键） |
| 每条最多字 | 默认 200 |
| 上报间隔 | 默认 30 秒 |
| 启用自动上报 | 勾上 |

点「保存」，再点「立即上报一次」验证。

## 数据怎么走

```
DeepSeek 网页版（你的浏览器）
   ↓ 只读 DOM 里的对话正文（不读 cookie、不读侧栏历史）
扩展
   ↓ POST /cs-myfree/context/deepseek（带 x-context-token 口令）
DSH（服务器）
   ↓ 滑动窗口：最近 20 条 × 每条 200 字，总上限 64KB，6 小时过期
后续工作（你在 DSH 里继续）
```

## 「传得少」的四道闸门

| 闸门 | 默认值 | 作用 |
|---|---|---|
| 条数窗口 | 20 条 | 只留最近 20 条，旧的丢掉 |
| 单条截断 | 200 字 | 长文截断并标记 `truncated` |
| 总字节上限 | 64KB | 超了从最早的开始丢 |
| 过期 | 6 小时 | 太久没更新就自动清空 |

这些都能在 DSH 侧再收紧（`read({maxMessages, maxCharsPerMessage, maxAgeMs})`）。

## 它会做什么 / 不会做什么

**会**：
- 读当前页面的消息正文和角色
- 定期 POST 到你的 DSH

**不会**：
- 读你的 cookie / 账号 / 密码
- 读侧栏里的历史对话
- 往 DeepSeek 页面写任何东西、点任何按钮
- 把数据发到除你 DSH 以外的任何地方

## 已知限制

- DeepSeek 网页版 DOM 结构会变，抓取用了「候选选择器 + 启发式」兜底；若某天抓不到，扩展会如实报「没抓到对话」，**不会编造**
- 只对 `chat.deepseek.com` 生效
- 角色判定在 DOM 拿不到标记时按奇偶位置猜，可能不准（正文本身是准的）

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 「当前页面没有本扩展」 | 当前标签页不是 chat.deepseek.com |
| 「还没有配置口令」 | 弹窗里的口令没填，或 DSH 侧 `contextBridgeCode` 没写 |
| HTTP 401 | 口令不一致；或 DSH 侧没配口令且请求不是从本机发出的 |
| 「没抓到对话」 | 页面上还没开始聊，或 DOM 变了（在 `content.js` 的 `containerSelectors` 里补充选择器） |