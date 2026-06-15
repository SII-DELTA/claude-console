# Change Log: 忽略遗留提问

- 日期: 2026-06-13
- 关联: docs/specs/2026-06-13-dismiss-question-spec.md、docs/plans/2026-06-13-dismiss-question-plan.md

## 背景

外部终端会话提问后被直接关掉，JSONL 留下永不被回答的悬空 AskUserQuestion，
铃铛角标 `attention="question"` 一直亮、无法靠回答之外的方式清除。

## 改动文件

- `history-store.ts`：新增 `dismissed_questions` 表与 `dismissQuestions()` /
  `listDismissedQuestionIds()`。
- `util/claude-jsonl.ts`：`deriveAttention` 增加 `dismissed?` 参数，跳过已忽略的
  openQuestionId。
- `claude-store.ts`：新增 dismissed 集合（`setDismissedQuestions`/`addDismissedQuestions`）、
  `getOpenQuestionIds(id)`、`refreshSession(id)`；attention 计算传入 dismissed。
- `runtime.ts`：启动时从 SQLite 恢复已忽略集合。
- `http-server.ts`：`POST /claude/sessions/:id/dismiss-question` —— 取该会话当前
  open question ids → 持久化 + 更新内存 + 重新派生广播。
- `apps/web`：api.dismissClaudeQuestion；store.dismissQuestion（乐观清除角标/选择器）；
  page 方案 A 选择器改为按服务端 `attention==="question"` 门控，并加“忽略此提问”按钮。

## 影响范围

- 仅影响 question 角标与方案 A 选择器的显示；正常未答复提问不受影响。
- 忽略持久化，local-agent 重启后仍生效。
- 忽略不杀进程、不动会话历史；需要时仍可打开会话用方案 A 回答（resume）。

## 验证结果

- 单测：shared 15 + web 18 + local-agent 85 = 全绿（新增 dismissed CRUD、
  deriveAttention 跳过已忽略 两条用例）。
- web typecheck 通过。
