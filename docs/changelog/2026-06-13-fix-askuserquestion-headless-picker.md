# Change Log: 修复 Web 控制台 AskUserQuestion 选择器不弹出

- 日期: 2026-06-13
- 关联: docs/specs/2026-06-13-fix-askuserquestion-headless-picker-spec.md、
  docs/plans/2026-06-13-fix-askuserquestion-headless-picker-plan.md

## 改动文件

- `apps/web/components/QuestionPanel.tsx`：新增并导出 `findPendingQuestions()`，
  修正"已回答"判定——仅当存在**非错误**的 `tool_result` 才算已回答。
- `apps/web/app/page.tsx`：删除本地 `findPendingQuestions`，改为从 QuestionPanel
  导入；同步精简未再使用的 `parseAskUserQuestion` / `AskQuestion` 导入。
- `apps/web/__tests__/QuestionPanel.test.tsx`：新增 `findPendingQuestions` 用例
  （无结果待答 / 错误结果仍待答 / 真实答案后消失 / 新回合无问题返回 null）；
  补 `scrollIntoView` 桩，修复既有 jsdom 渲染用例红灯。

## 核心变更

无头子进程（无 TTY）运行 `AskUserQuestion` 会立即失败并写回
`isError: true` 的 `tool_result`（内容 `"Answer questions?"`）。原逻辑把任何
`tool_result` 当作"已回答"，导致选择器永不渲染。现忽略错误结果，使被判失败的
问题仍视为待回答 → 正常渲染 `QuestionPanel`，用户选择后作为文本发回续写。

## 影响范围

- 仅前端渲染判定，不触及驱动/子进程/协议。
- 手机与桌面浏览器一致生效。
- 已正常回答的问题不会重复弹出（非错误结果仍判为已回答）。

## 验证结果

- `pnpm --filter web test`：18/18 通过（含 4 条新增用例）。
- `pnpm --filter web typecheck`：通过。
