# Changelog

本项目的版本记录遵循 [语义化版本](https://semver.org/lang/zh-CN/)（SemVer）。

Copyright (c) 2026 mnasqw1122-sys 柳暗花明 · 鸣谢：deepseek-v4-flash、deepseek-v4-pro

## [1.0.0] - 2026-08

首个公开发布版。基于 DSH `0.1.0-rc.7` 完整重构与核验。

### 新增

- 锚定专注模式完整状态机：`start → plan → execute → check/step ×N → complete → review ×7 → finalize`
- 6 项防左右互搏机制：单点决策+冻结、续链锚、禁止范式谈判、提示面恒定、反刍抑制、外部兜底裁决
- 7 项强制自审（含分层纪律检查），全部 pass 才能 `finalize`
- 多会话隔离：状态机按会话独立存储（`ToolRunContext.agent` / `AssembleContext.agent` 寻址），
  多会话可并行起任务互不干扰；Client 专注条/卡片按槽 `sessionId` 属性寻址
- 锚注入通道自动探测：任务首轮实测一次（防重入），自动选择 `sections` / `contexts` / `none`
- Client UI：`conversation.input.dock` 专注条（阶段/风格/谈判徽章 + 任务对话框）、
  `tool.view.cordis` 流程说明卡

### 修复

- rc7 契约：`AssembledSection` 移除多余的 `order` 字段（rc7 仅 `{ name, text }`）
- 会话锁定竞态：Host 半挂在根 fiber，旧"首装配捕获 sessionId"会被其他会话的装配抢先
  导致插件永久静默——改为工具调用时用 `ToolRunContext.agent` 精确锁定会话

### 兼容性

- 目标版本：`@deepseek-ai/dsh 0.1.0-rc.7`
- `system-prompt/assemble` waterfall 签名、`harness.defineTool/registerTool/handle` guard、
  `conversation.input.dock` / `tool.view.cordis` 槽契约、内置符号均经 rc7 实机核验

### 已知限制

- minimal 类 preset（`complete: true` + `includeRuntimeContext: false`）按设计屏蔽外部
  提示文本，锚判定为 `none` 不注入（工具隔离仍生效）
- 状态机为进程内存态，DSH 重启后任务进度与插件本体均丢失，需重新启动
