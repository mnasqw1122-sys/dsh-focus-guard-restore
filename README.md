# 🎯 FocusGuard 专注守卫（Anchored Focus Mode）

> DSH（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)）动态 Cordis 插件
> 单点锁定思维范式 · 冻结计划 · 续链锚注入 · 拦截范式谈判与反刍 · 强制自审收尾
>
> 仓库：[github.com/mnasqw1122-sys/dsh-focus-guard-restore](https://github.com/mnasqw1122-sys/dsh-focus-guard-restore)

FocusGuard 为 DSH 会话提供一套「锚定专注模式」：任务开始即锁定思维风格，计划一经提交即冻结，
执行层每轮注入同一锚点续链，任何"重新规划 / 自我怀疑 / 越界动作"都会被拦截并计数，
谈判超过上限由外部强制否决——从机制上杜绝模型在同一任务里"左右互搏"。

![版本](https://img.shields.io/badge/版本-1.0.0-green) ![DSH](https://img.shields.io/badge/DSH-0.1.0--rc.7-blue) ![阶段](https://img.shields.io/badge/阶段-思考→计划→执行→自审-blue)

---

## 特性

| # | 机制 | 说明 |
|---|------|------|
| 1 | 单点决策 + 冻结 | `start` 按任务类型自动锁定思维风格（修 bug/维护→**调查优先**；新开发/构建→**产出优先**），整场不换，也可用 `style` 参数强制指定 |
| 2 | 续链锚 | `plan` 冻结生成恒定锚文本，执行层每轮注入同一锚点 + 「当前第 N 步」指针 |
| 3 | 禁止范式谈判 | `check` 拦截"重新规划 / 调整计划 / 换思路"等意图，计数警告 |
| 4 | 提示面恒定 | 锚以系统提示段注入（自动探测可用通道），任务期间引导文本不增删 |
| 5 | 反刍抑制 | `check` 拦截"再确认 / 重新检查 / 我是不是应该"等反复自我怀疑 |
| 6 | 外部兜底裁决 | 谈判超过 2 次直接否决修订请求，模型无权再切换范式 |
| 7 | 7 项强制自审 | 全部步骤完成后进入自审（需求完整性 / 正确性 / 健壮性 / 实际验证 / 清理收尾 / 范围 / 分层纪律），全部 pass 才能收尾 |
| 8 | 多会话隔离 | 每个会话独立状态机，多个会话可并行起任务、互不干扰 |
| 9 | 只读工具面硬隔离 | 思考层装配时系统提示的工具列表被裁剪为只读调查工具（read/glob/grep/web_search/skill/read_image/ask_user_question/focus），写入与执行类工具不可见 |

## 适用场景

- 长任务防漂移：目标中途被遗忘、越做越偏
- 执行纪律：边做边想、执行中反复另起计划
- 效率损耗：反复确认环境、自我怀疑、重查同一处
- 交付质量：缺少收尾自审导致的遗漏与粗糙

## 环境要求

- DSH `0.1.0-rc.7` 及以上（插件源码对照 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `dsh-v0.1.0-rc.7` 逐项核验）
- 在「创造模式」（cordis preset）会话中运行

---

## 快速开始

### 方式一：AI 恢复（推荐）

DSH 重启后动态插件会丢失。把本目录（或本仓库文件）放到会话工作区，对 AI 说：

> **启动插件** 或 **恢复专注插件**

AI 会读取本仓库的 `host.js` 与 `client.js`，用 `cordis_define` + `cordis_run` 重建并运行插件。
首次运行客户端半段需要在 Run 卡片上批准。

### 方式二：手动重建

在 cordis 会话中让 AI 执行：

1. `cordis_define` — 新建插件：`code.host` = `host.js` 内容，`code.client` = `client.js` 内容
2. `cordis_run` — 激活返回的 `pluginId/packageId`（首次需在 Run 卡片批准 Client 半段）

---

## 使用方法

### 方式 A：Client 专注条（零提示词）

插件激活后，输入框上方会出现 FocusGuard 专注条：

1. 点 **「✍️ 专注任务」**
2. 输入任务描述（一句话目标），回车发送
3. 插件自动锁定思维风格（调查优先/产出优先）→ 进入思考层，专注指令自动附加到消息中

专注条实时显示：当前阶段徽章（🧠 思考层 / 📋 计划已冻结 / ⚙️ 执行层 / 🔍 自审）、
思维风格、目标、进度（如 `2/5`）、步骤状态点、谈判计数与最近意图判定。
Run 卡片内另有完整的流程说明卡。

### 方式 B：`focus` 工具（AI 侧主流程）

工具名：`focus`，`action` 为必填参数。

```
start → plan → execute →〔check → step〕×N → complete → review ×7 → finalize
```

| action | 必填参数 | 作用 |
|--------|----------|------|
| `start` | `objective`（一句话目标）；可选 `style=investigate/produce` | 锁定思维风格，进入思考层 |
| `plan` | `steps`（每步含执行逻辑与验收标准）；可选 `exclusions`（禁止范围） | 提交完整计划并冻结，生成续链锚 |
| `execute` | — | 切换到执行层（注入同一锚点 + 当前第 N 步） |
| `check` | `intention`（接下来打算做什么） | 每步前校验意图（判定见下表） |
| `step` | `index`、`status=done/in_progress/blocked/pending`；可选 `note` | 标记步骤进度 |
| `note` | `note` | 记录笔记 |
| `report` | — | 查看当前目标/阶段/进度/判定 |
| `complete` | — | 全部步骤完成后进入 7 项自审 |
| `review` | `item`（1~7）、`status=pass/fail`；可选 `note` | 逐项自审；fail 需修复后重新 pass |
| `finalize` | — | 全部 pass 后正式收尾 |

#### `check` 判定表

| 场景 | 判定 | 行为 |
|------|------|------|
| 意图与当前步骤一致 | 🟢 GO | 执行这一步 |
| 触犯 `exclusions` 禁止范围 | 🔴 DIVERT | 立即停止，仅用户明确要求扩展时才允许 |
| 思考层出现写入/执行意图（修改/写入/运行/删除/安装…） | 🔴 DIVERT | 思考层只做理解与规划 |
| 思考层只读调查（读取/搜索/分析…） | 🟢 GO | 调查充分后立即 plan |
| 执行层出现重新规划类意图 | 🟡 HOLD | 谈判计数 +1；超过 2 次 → 🔴 外部否决，禁止再切换 |
| 执行层出现反复确认/自我怀疑 | 🟡 HOLD | 反刍抑制：信任已完成步骤，继续当前步 |
| 意图属于其他步骤 | 🟡 HOLD | 一次只做当前步 |
| 意图关联不明 | 🟡 HOLD | 不做计划外的事 |

#### 谈判计数规则

- 执行层内每次"重新规划/调整计划/换思路"意图触发谈判，`flips` +1
- 第 3 次起由外部强制否决（DIVERT）：继续当前冻结计划；卡住则把当前步骤标记为
  `blocked` 并如实报告，交由用户决定
- 计划修订仍被允许但受限：修订会占用谈判次数，用尽后模型无权再切换

---

## 阶段流

```
🧠 思考层         📋 计划冻结           ⚙️ 执行层             🔍 自审 7 项           ✅ 完成
start ──────────► plan ──────────────► execute ──────────► complete ──────────► finalize
只读调查/规划      恒定续链锚           每轮注入同锚+第N步     逐项 review 全部 pass   总结交付物
（写入工具禁用）    不再谈判              check 拦越界/谈判      fail 先修复再 pass
```

---

## 架构

```
┌─ host.js（Host 半段，挂在根 fiber）─────────────────────────────┐
│  • 状态机表：Map<sessionId, state>，每会话独立（上限 64，超出淘汰最旧）│
│  • system-prompt/assemble 监听：按会话注入 focus-anchor 锚        │
│    + 思考层工具裁剪；通道自动探测（sections/contexts/none）        │
│  • focus 工具：defineTool + registerTool（参数/输出经 rc7 guard 校验）│
│  • RPC：focus.getState / focus.prepareTask（按 sessionId 寻址）   │
└─────────────────────────────────────────────────────────────────┘
┌─ client.js（Client 半段，浏览器页面）────────────────────────────┐
│  • conversation.input.dock：专注条（状态徽章 + 任务对话框）         │
│  • tool.view.cordis（key:'self'）：流程说明卡                     │
│  • 轮询 focus.getState（1.5s）显示本会话状态机                    │
└─────────────────────────────────────────────────────────────────┘
```

### 锚注入通道自动探测（rc7）

rc7 中若 preset 注册了 `complete: true` 提示段，waterfall 结束后 `sections` 会被恢复为
单一 complete 段；若同时 `includeRuntimeContext: false`，`contexts` 也会被清空。插件在任务
激活后的首次装配做一次实测（防重入、仅一次），自动选择：

| preset 类型 | 通道 | 锚的位置 |
|------------|------|---------|
| cordis / standard / code（无 complete 段） | `sections` | 系统提示末尾（默认） |
| 自定义（complete 段但保留运行时上下文） | `contexts` | 运行时上下文块（系统提示之后、用户消息之前） |
| minimal 类（complete + 抑制运行时上下文） | `none` | 不注入（该 preset 设计意图即屏蔽外部提示文本）；工具隔离仍生效 |

---

## 兼容性与已知限制

- **版本**：对照 `@deepseek-ai/dsh 0.1.0-rc.7` 核验（`system-prompt/assemble` waterfall、
  `harness.defineTool/registerTool/handle` guard、两个 Client 槽契约、内置符号）。
- `focus` 工具注册在根作用域，所有会话可见；状态按会话隔离——各会话任务互不影响。
- 思考层工具裁剪名单固定为：`focus, read, glob, grep, web_search, skill, read_image, ask_user_question`；
  若部署环境工具集不同（如缺少 `read_image`），裁剪结果相应减少，不影响主流程。
- 状态机为进程内存态，DSH 重启后任务进度丢失（插件本身也需重新启动）。
- 历史变更见 [CHANGELOG.md](CHANGELOG.md)。

## 开发与验证

`host.js` / `client.js` 为纯 JavaScript 函数体（`code.host` / `code.client` 格式），
无构建步骤。语法检查（按运行器包裹方式）：

```bash
node -e "const vm=require('vm'),fs=require('fs');for(const f of ['host.js','client.js']){new vm.Script('(async()=>{\n'+fs.readFileSync(f,'utf8')+'\n})()');console.log(f,'OK')}"
```

验证覆盖：状态机完整流程、多会话隔离、通道探测三场景（sections/contexts/none）、
防重入、RPC 按会话寻址、谈判否决、会话竞态。

## 许可证

[MIT](LICENSE) — Copyright (c) 2026 mnasqw1122-sys 柳暗花明

## 鸣谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH 平台）
- 本插件的开发、审查与测试由 **deepseek-v4-flash** 与 **deepseek-v4-pro** 协作完成

## 版本

v1.0.0 — 首个公开发布版（详见 [CHANGELOG.md](CHANGELOG.md)）
