# Spec — AskUserQuestion 自由回复后选择器不消失（方案 B）

日期: 2026-06-14
关联: docs/specs/2026-06-13-interactive-permissions-spec.md

## 现象

方案 B 交互式 AskUserQuestion 选择器弹出时，面板提示「也可在下方输入框自由回复」。
但用户在输入框发送自由文本后，**选择器仍然停留**，回合也没有继续。

## 根因

- 选择器由 store 的 `pendingPermission` 驱动（`bPermission`），CLI 此刻通过 stdio 控制协议
  发来 `can_use_tool` 的 `control_request` 并**阻塞等待 `control_response`**。
- 「提交选择」走 `answerPermission(answers)` → 回 `allow+answers` 给 CLI、发
  `claude:permission_cancel` 关闭选择器、同回合续写。
- 而「自由回复」走 `handleSend → sendPrompt → continueClaudeSession`：只是向 CLI 写了一条
  新的 `user` turn，**既没回应那个待决的 `control_request`，也没清 `pendingPermission`**。
  结果：选择器不消失（前端 bug），且 CLI 仍阻塞在等待选择题答案（协议层不正确）。

## 决策（已与用户确认）

自由回复语义 = **把自由文本作为该题的答案，同回合续写**（方案 A 语义）。
依据 2026-06-13 spec 实测结论：`allow + answers:{<question>:<value>}` 中 value 可为任意字符串，
CLI 返回「Your questions have been answered」，同回合继续。

## 设计

- 复用现有 `answerPermission(answers)` 通道——它已做 allow+answers、`permission_cancel` 关闭、续写。
  **无需改动 agent / 控制协议。**
- 前端 `handleSend(text)`：当 `bPermission` 激活且 `text` 非空时，
  把自由文本映射为每道待决问题的答案（`multiSelect` 题用 `[text]`，单选用 `text`），
  调用 `answerPermission(answers)` 并 return，不再走 `sendPrompt`。

## 范围 / 非目标

- 仅影响方案 B（`bPermission`，存在 live 控制请求）下的自由回复。
- 方案 A 兜底（`pendingQuestions`，源自历史的无头失败、无 live 控制请求）行为不变：
  自由回复仍是一条新 prompt。
- 不改 agent、不改控制协议、不改「提交选择」路径。
- 自由回复路径忽略附带图片（选择题答案不承载图片）；纯图片无文本时仍走原 `sendPrompt`。

## 验证

- 方案 B 选择器弹出 → 输入框自由回复 → 选择器消失、CLI 同回合续写、模型收到该文本作为答案。
- 「提交选择」与方案 A 行为不回归。
- typecheck 通过。
