# Spec: 忽略遗留提问（清除一直亮的“等待回答”角标）

- 日期: 2026-06-13
- 状态: 已确认（加“忽略提问”动作）
- 关联: docs/specs/2026-06-13-pending-permission-recovery-spec.md

## 问题

`attention="question"` 由会话 JSONL 派生（存在未被非错误答复关闭的
AskUserQuestion）。当一个会话在**外部终端**里提问后被直接关掉，JSONL 留下永远
不会被回答的悬空提问 → 铃铛角标**一直显示“等待回答”**，无法靠回答之外的方式清除。
（这类会话仍可在控制台打开、用方案 A 选择器回答并 --resume，但用户可能只想丢弃。）

## 方案

新增“忽略提问”：不回答也能消除该会话的 question 角标。

- 服务端持久化“已忽略的提问 id”（SQLite `dismissed_questions`）。
- `deriveAttention` 计算时跳过已忽略的 openQuestionId；全部被忽略 ⇒ 不再是 question。
- 忽略后重新派生并广播 `claude:session_updated`，各端角标即时清除。
- 前端方案 A 选择器改为按服务端 `attention === "question"` 门控：忽略后选择器同步隐藏；
  仍未答复的正常提问 attention 仍是 question，选择器照常显示（无回归）。
- 提供“忽略此提问”按钮（A 选择器旁）。B 实时提问不提供忽略（用中断/回答）。

## 验收

1. 终端遗留提问的会话，点“忽略”后铃铛角标在各端清除，选择器隐藏。
2. 正常未答复提问不受影响（角标/选择器照常）。
3. 忽略持久化：local-agent 重启后不再把已忽略的提问算作 question。
4. 单测/typecheck 通过。
