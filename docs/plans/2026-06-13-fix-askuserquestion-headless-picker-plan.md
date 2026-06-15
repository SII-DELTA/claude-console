# Plan: 修复 Web 控制台 AskUserQuestion 选择器不弹出（方案 A）

- 日期: 2026-06-13
- 关联 spec: docs/specs/2026-06-13-fix-askuserquestion-headless-picker-spec.md

## 改动点

### 1. `apps/web/app/page.tsx` — `findPendingQuestions()`

把"已回答"判定中对 `tool_result` 的匹配，增加 `!b.isError` 条件：
仅当存在**非错误**的 `tool_result`（真实答案，如 `Your questions have been
answered`）时才视为已回答。无头模式下 `is_error: true` 的
`"Answer questions?"` 结果不再被当成已回答，于是 `QuestionPanel` 正常渲染。

### 2. 单测 `apps/web/__tests__/`

新增/补充用例：
- 当 `AskUserQuestion` 仅有 `isError: true` 的 `tool_result` 时，
  `findPendingQuestions` 返回问题（待回答）。
- 当存在非错误 `tool_result` 时，返回 `null`（已回答）。

> 注：`findPendingQuestions` 当前未导出。为可测试，将其导出（或在测试中通过
> 现有导出路径覆盖）。优先最小改动：导出该函数。

## 验证

- `pnpm --filter web test`（或仓库既定测试命令）全绿。
- 手动：在 Web 控制台触发问题 → 选项卡出现 → 选择提交 → Agent 续写。

## 风险

- 极低。仅放宽前端"已回答"判定；不触及驱动/子进程/协议。
