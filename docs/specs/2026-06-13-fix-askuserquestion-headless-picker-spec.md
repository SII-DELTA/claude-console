# Spec: 修复 Web 控制台 AskUserQuestion 选择器不弹出

- 日期: 2026-06-13
- 状态: 已确认（方案 A）

## 问题

在 Web 控制台（手机/桌面浏览器）里，Claude 调用 `AskUserQuestion` 时不会弹出选项卡，
而是直接显示一条 `ERR: Answer questions?`，用户无从选择。

## 根因

Web 控制台通过 `claude-driver.ts` 以无头子进程方式运行
`claude --output-format stream-json`，**没有 TTY，也未实现交互/权限应答协议**。
`AskUserQuestion` 在终端里本是交互式工具，无头模式下立即失败，写回一条
`is_error: true` 的 `tool_result`，内容为 `"Answer questions?"`（即权限提示原文）。

前端 `findPendingQuestions()`（`apps/web/app/page.tsx`）判定逻辑为：只要该
`tool_use` 存在任意 `tool_result`，即视为"已回答" → 返回 `null` → 不渲染
`QuestionPanel`。那条错误结果被误当成"已回答"，导致选择器永不出现。

经真实会话 JSONL 验证：失败时原始 `tool_use.input` 中的 `questions/options`
完整保留，可直接用于渲染。

## 方案 A（已选）

前端兜底渲染：`findPendingQuestions()` 在判断"是否已回答"时，**忽略错误
（`isError`）的 `tool_result`**。即只有非错误结果才算真正回答。这样无头模式下
被判失败的 `AskUserQuestion` 仍视为待回答，正常渲染 `QuestionPanel`；用户选择后
作为普通文本消息发回，Agent 读取后在下一轮继续。

### 取舍

- 优点：改动小（仅前端 1 处）、低风险、手机/桌面同时生效、贴合现有架构。
- 缺点：答案以新一轮对话文本注入，而非原 tool 的真实返回值（语义近似，不影响体验）。
- 放弃方案 B（驱动层实现 control/canUseTool 协议）：语义最正确但改动大、风险高，
  后续如有需要再单独立项。

## 验收

1. Web 控制台触发 `AskUserQuestion` 后，即使底层返回 `Answer questions?` 错误，
   仍渲染出可点击的选项卡。
2. 用户选择并提交后，选项作为文本发回，Agent 正常续写，选择器消失。
3. 已正常回答（`Your questions have been answered`）的问题不再重复弹出。
4. 现有单测通过。
