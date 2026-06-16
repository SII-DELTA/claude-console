# 工具权限审批 Plan

- 日期: 2026-06-16
- 关联 spec: [2026-06-16-tool-permission-approval-spec.md](../specs/2026-06-16-tool-permission-approval-spec.md)
- 分支: `feat/tool-permission-approval`（隔离 worktree，避开并行会话改动）

## Phase 0 — shared（@mac/shared）

`packages/shared/src/schemas.ts`：

1. `ClaudeToolApprovalSchema = { requestId, toolName, summary, live }` + 类型。
2. `ServerClaudeToolApprovalRequestSchema`（`type:"server:claude_tool_approval_request"`,
   `sessionId, requestId, toolName, summary`）→ 并入 `ServerMessageSchema`。
3. `ClaudeSessionSchema.attention` 枚举加 `"approval"`。
4. `ClaudePendingPermissionsResponseSchema` 加 `approvals: ClaudeToolApproval[]`。
5. `ClaudeAnswerToolApprovalBodySchema = { requestId, decision: "allow"|"deny" }`。

验证：`tsc -b`、`pnpm --filter @mac/shared test`。

## Phase 1 — history-store（落库）

`packages/local-agent/src/history-store.ts`：

1. `PendingPermissionRecord` 加 `kind?: "question"|"approval"`、`toolInput?: unknown`。
2. 表加列 `kind TEXT NOT NULL DEFAULT 'question'`、`toolInput TEXT`；guarded
   `ALTER TABLE ADD COLUMN`（PRAGMA table_info 检测）兼容旧库。
3. save/get/list/rowToPending 带上 kind/toolInput。
4. 新增 `hasPendingApproval(sessionId): boolean`（attention 派生用）。

## Phase 2 — driver

`packages/local-agent/src/claude-driver.ts`：

1. `PendingPermissionStore` 接口加 `kind?`/`toolInput?`。
2. `WarmProc.pending` 值改为 `{ input, toolName, kind: "question"|"approval" }`。
3. `handleControl` 非 AskUserQuestion 分支：挂起(kind=approval)+持久化+广播
   `claude:tool_approval_request`（替换原 deny）。
4. 新方法 `approveTool(sessionId, requestId, "allow"|"deny")`：写 allow/deny
   control_response，删内存+库行，广播 `claude:permission_cancel`，touch。
5. `summarizeToolInput(toolName, input)` 纯函数（Bash→command、Write/Edit/Read→file_path、
   其它→JSON 截断）。
6. `listPendingApprovals(sessionId): ToolApprovalView[]`（库行 kind=approval → summary+live）。
7. bus 事件 `claude:tool_approval_request` 类型。

## Phase 3 — 接线（bus/ws-bridge/http-server/runtime）

1. bus.ts：`claude:tool_approval_request(sessionId, requestId, toolName, summary)`。
2. ws-bridge：转 `server:claude_tool_approval_request`；surface/resolve 后
   `claude.refreshSession(id)`（driver 触发，见下）。
3. http-server：`POST /claude/sessions/:id/answer-tool-approval`；`pending-permission`
   GET 返回 `{ pending, approvals }`。
4. runtime：`claude.setPendingApprovalPredicate((id)=>store.hasPendingApproval(id))`。
5. claude-store：`pendingApprovalPredicate` + buildSession attention 覆盖为 `"approval"`；
   driver surface/resolve 后调 `store.refreshSession(id)` 重新派生广播。

## Phase 4 — web

1. `lib/api.ts`：`answerToolApproval`；`pending-permission` 解析 approvals。
2. `lib/store.ts`：`toolApproval` 状态 + `answerToolApproval(decision)`；reducer 处理
   `server:claude_tool_approval_request` / 复用 `permission_cancel` 关闭。
3. `components/ToolApprovalPanel.tsx`：工具名 + summary + 允许一次/拒绝。
4. `app/page.tsx`：渲染面板，与 AskUserQuestion 互斥。
5. `components/Dashboard.tsx`：`AttKind` 加 `approval`（「待批准」），进「需要你处理」。

## Phase 5 — 测试 + 交付

- driver 单测：非 AskUserQuestion → 广播 approval；allow/deny control_response；写失败保留。
- web reducer 单测：approval 事件 + 提交。
- 探针/集成：真实 claude 触发 Bash 审批，allow 执行 / deny 续跑。
- 全量 test + typecheck；写 changelog；commit。
