# 监控台动态当前任务（A+B+C）Change Log

- 日期: 2026-06-16
- spec: `docs/specs/2026-06-16-monitor-dashboard-ux-spec.md`
- plan: `docs/plans/2026-06-16-monitor-dashboard-ux-plan.md`（阶段一）

## 背景

监控台卡片标题取「开局首句」（`deriveTitle` 用第一条用户消息 / `preview`），
一个会话里连续处理多个任务时，标题永远停在第一个，看不出「当前在做什么」。

## 核心变更

三层动态标题：

- **层 A（最近指令）**：解析时记录**最后一条**用户文本 `lastUserText`，标题兜底用它而非首句。
- **层 B（活动行）**：记录最近一个 `tool_use` → 友好动作串 `lastActivity`（如「编辑 Dashboard.tsx」「运行 npm test」）；最后一条 assistant 文本 → `lastResult`（完成态结果摘要）。前端按状态展示：运行中显示「正在 …」，完成显示结果摘要。
- **层 C（Haiku 旁路摘要）**：新增 `CurrentTaskSummarizer`，监听 `claude:drive_done`，一次性 `claude -p --model haiku --output-format json` 在临时目录读取会话片段，产出 ≤24 字 `currentTask`。**只读、不写会话 jsonl、不进会话上下文、不影响 token 计费**。默认开（env `CURRENT_TASK_SUMMARY` 关闭，`CURRENT_TASK_MODEL` 改模型）。

卡片标题优先级：`currentTask → lastUserText → title`。

## 改动文件

- `packages/shared/src/schemas.ts`：`ClaudeSession` 新增 `lastUserText`/`currentTask`/`lastActivity`/`lastResult`（均可选，向后兼容）。
- `packages/local-agent/src/util/claude-jsonl.ts`：累加器记录最近 user/assistant 文本与 tool_use；新增纯函数 `deriveLastUser`/`deriveResult`/`deriveActivity`。
- `packages/local-agent/src/claude-store.ts`：`buildSession` 填充新字段；新增 `setCurrentTaskPredicate`。
- `packages/local-agent/src/current-task.ts`（新增）：Haiku 旁路观察员。
- `packages/local-agent/src/runtime.ts`：接线 `CurrentTaskSummarizer`（默认启用）。
- `apps/web/components/Dashboard.tsx`：`cardTitle` 动态标题；运行/完成/需处理卡片活动行。
- `packages/local-agent/src/__tests__/claude-jsonl-derive.test.ts`（新增）：纯函数测试。

## 影响范围

- 监控台三组卡片标题/副标题改为动态；其余功能不变。
- 后端每个完成回合最多触发一次 Haiku 一次性调用（可关）。
- 新字段可选，旧客户端忽略。

## 验证

- `pnpm typecheck` 全绿（需先 `pnpm --filter @mac/shared build` 刷新类型）。
- `@mac/local-agent` 113 测试通过（含新增 8 个 deriver 测试）。
- `@mac/web` 22 测试通过。
- 待手测：长会话切任务后标题随最近指令/摘要更新；摘要开启后会话 jsonl 行数不因摘要增长。
