# 2026-06-16 监控台「需要你处理」准确性 + 卡片整块可点

## 背景
监控台「需要你处理」列表里混入大量**普通对话**（明明不需要回答，却标成「等待你的回答」）。
另外用户希望去掉卡片里的「去回答」按钮，直接点整张卡片进入会话更顺手。

## 根因（误判）
`deriveAttention` 把历史里**任何**未被「非错误 tool_result」关闭的 `AskUserQuestion`
都视为待回答。但在 headless 下，问题常被自动拒绝（error result）或被用户「直接改说别的」
绕过——这两种都不会关闭它，于是长对话永远挂着「question」，且点进去根本没有问题可答。

## 核心变更
- **后端 `claude-jsonl.ts` 让 question 贴合「确实在等回答」**：
  - `AskUserQuestion` 在收到**任意** `tool_result`（含 error/自动拒绝）时即关闭——错误结果也意味着不再阻塞用户。
  - 出现**真实用户文本消息**（不是 tool_result）后，清空所有未决问题——用户已经继续对话，旧问题不再待回答。
  - 只有「有 tool_use 但完全没有 tool_result」（如实时一轮暂停等待作答）才保持 open → 仍标 `question`。
- **前端 `Dashboard.tsx`**：`AttentionCard` 整块改为 `<button>`，点击直接进会话；移除「去回答」按钮与底部操作行。
- **测试**：新增两例——问题被后续用户消息取代、问题被 error tool_result 关闭，均应判为 `done` 而非 `question`。

## 影响范围
- `packages/local-agent/src/util/claude-jsonl.ts`（attention 判定）
- `apps/web/components/Dashboard.tsx`（卡片交互）
- `packages/local-agent/src/__tests__/claude-store.test.ts`（用例）
前端 in-session 的问题作答仍按 `attention === "question"` 门控，二者语义现已一致。

## 验证
- `pnpm --filter @mac/local-agent test` 89 全绿（含 2 新例）；local-agent / web typecheck 通过；web build 成功。
