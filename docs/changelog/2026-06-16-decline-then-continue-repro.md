# Change Log: 关闭问答选择器后继续会话的复现脚本

- 日期: 2026-06-16
- 分支: `feat/tool-permission-approval`

## 背景

用户报告：点击 AskUserQuestion 选择器的关闭按钮（declinePermission）后，再发一条消息，Claude session 没有回复。需要复现脚本定位问题。

## 核心变更

- **itest**（`scripts/itest-decline-then-continue.mts`）：集成测试路径，使用 `Bus` + `ClaudeDriver` API，模拟 decline → continueSession 流程，验证是否能收到 text delta。
- **probe**（`scripts/probe-decline-then-resend.mjs`）：底层协议路径，直接 spawn claude 进程通过 stream-json 协议交互，手动模拟 can_use_tool decline → 第二条 prompt，验证结果。

## 影响范围

仅新增脚本文件，无生产代码改动。

## 验证

- 脚本可运行，未通过前输出 `❌ FAIL`（用于确认 bug 存在）。
