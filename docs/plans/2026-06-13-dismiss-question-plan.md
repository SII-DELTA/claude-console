# Plan: 忽略遗留提问

- 日期: 2026-06-13
- 关联 spec: docs/specs/2026-06-13-dismiss-question-spec.md

## 改动
- history-store: `dismissed_questions` 表 + `dismissQuestions()` / `listDismissedQuestionIds()`。
- claude-jsonl: `deriveAttention(acc, isLive, dismissed?)` 跳过已忽略 id。
- claude-store: `dismissedQuestions` 集 + `setDismissedQuestions/addDismissedQuestions`、
  `getOpenQuestionIds(id)`、`refreshSession(id)`；buildSession 传 dismissed。
- runtime: 启动时 `claude.setDismissedQuestions(store.listDismissedQuestionIds())`。
- http: `POST /claude/sessions/:id/dismiss-question` → 取 open ids → 持久化 + 内存 + refresh 广播。
- web: api.dismissClaudeQuestion；store.dismissQuestion（乐观清角标/选择器）；
  page A 选择器按 `attention==="question"` 门控 + “忽略此提问”按钮。

## 测试
- history-store: dismissed CRUD（幂等）。
- claude-jsonl: deriveAttention 跳过已忽略。
- 全量 test + web typecheck。
