# Plan: AskUserQuestion 交互应答（方案 B）

- 日期: 2026-06-13
- 关联 spec: docs/specs/2026-06-13-interactive-permissions-spec.md

## 改动清单

### packages/shared/src/schemas.ts
- 新增 `ClaudePermissionQuestion`（question/header/multiSelect/options[{label,description}]）。
- 新增 `ServerMessage` 成员：
  - `server:claude_permission_request` { sessionId, requestId, toolName, questions }
  - `server:claude_permission_cancel` { sessionId, requestId }
- 新增 `ClaudeAnswerPermissionBodySchema` { requestId, answers: Record<string, string|string[]> }。

### packages/local-agent/src/bus.ts
- 新增事件 `claude:permission_request(sessionId, requestId, toolName, questions)`、
  `claude:permission_cancel(sessionId, requestId)`。

### packages/local-agent/src/claude-driver.ts
- 新增 option `interactivePermissions`（env `CLAUDE_INTERACTIVE_PERMISSIONS`，默认开，`0/false` 关）。
- 开启时 spawn 追加 `--permission-prompt-tool stdio`；spawn 后发送 initialize control_request。
- handleLine 前拦截 `control_request`/`control_cancel_request`：
  - `can_use_tool` + AskUserQuestion → 暂存 pending{requestId→{sessionId,input}}，发 `claude:permission_request`。
  - `can_use_tool` 其他工具 → 立即 deny。
  - `control_cancel_request` / 进程 kill|close → 清理 pending 并发 `claude:permission_cancel`。
- 新增 `answerPermission(sessionId, requestId, answers)`：回 allow+updatedInput.answers。
- 工具方法：writeControl 写 stdin。

### packages/local-agent/src/http-server.ts
- 新增 `POST /claude/sessions/:id/answer-permission` → driver.answerPermission。

### packages/local-agent/src/ws-bridge.ts
- subscribeBus 广播 permission_request / cancel。

### apps/web
- lib/api*.ts：新增 `answerClaudePermission(sessionId, requestId, answers)`。
- lib/store.ts：处理 `server:claude_permission_request`/`cancel`，维护 `pendingPermission`；
  收到该 tool 的 tool_result 或 cancel 时清除。
- app/page.tsx：优先渲染 B 的 pendingPermission（结构化提交→answerPermission）；
  保留 A 的 findPendingQuestions 兜底（文本提交）。
- components/QuestionPanel.tsx：submit 同时给出结构化答案
  `{question, labels[]}[]`（A 仍用拼接文本）。

## 测试
- 单测：claude-driver 用 fake spawn 驱动控制协议（initialize、can_use_tool→allow、
  非 Ask→deny、cancel 清理）。前端：QuestionPanel 结构化提交。
- 集成：scripts 真实 claude 验证（已完成探针）。
- 全量 `pnpm -r test` + web typecheck。

## 切换
- 单测+集成通过后，确认 `interactivePermissions` 默认开启；env 可一键回退 A。
