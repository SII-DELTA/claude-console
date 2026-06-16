# Change Log: 工具权限审批（允许一次 / 拒绝）

- 日期: 2026-06-16
- spec: docs/specs/2026-06-16-tool-permission-approval-spec.md
- plan: docs/plans/2026-06-16-tool-permission-approval-plan.md
- 分支: `feat/tool-permission-approval`（隔离 worktree）

## 背景

此前除 AskUserQuestion 外，任何走到权限「询问」路径的工具一律被 driver 直接拒绝并报错
（`respondPermissionDeny`）。手机端没有任何「批准」入口——不把权限模式设成全放行
（acceptEdits/bypassPermissions），敏感工具一触发就报错。

## 核心变更

- **driver**（[claude-driver.ts](../../packages/local-agent/src/claude-driver.ts)）：
  非 AskUserQuestion 的 `can_use_tool` 不再直接 deny，而是挂起 + 持久化 + 广播
  `claude:tool_approval_request`（工具名 + 参数摘要），等待用户决定。新增
  `approveTool(sessionId, requestId, "allow"|"deny")`：allow → `behavior:"allow"`，
  deny → `behavior:"deny"`（干净非错误，回合继续）；`summarizeToolInput` 纯函数；
  `listPendingApprovals`；surface/resolve/cancel 后调 `store.refreshSession` 刷新 attention。
- **落库**（[history-store.ts](../../packages/local-agent/src/history-store.ts)）：
  `pending_permissions` 加 `kind`(question|approval) + `toolInput` 两列（guarded
  `ALTER TABLE` 迁移）；`PendingPermissionRecord` 带 kind/toolInput；新增 `hasPendingApproval`。
- **attention**（[claude-store.ts](../../packages/local-agent/src/claude-store.ts)）：
  审批不在 JSONL 里，故 buildSession 经 `pendingApprovalPredicate` 合并库状态，置
  `attention="approval"`；runtime 注入 `()=>store.hasPendingApproval(id)`。
- **接线**：bus 新增 `claude:tool_approval_request`；ws-bridge 转
  `server:claude_tool_approval_request`；http `POST /answer-tool-approval`；
  `pending-permission` GET 增加 `approvals`。
- **shared**：`ClaudeToolApproval`、`ServerClaudeToolApprovalRequest`、
  `ClaudeAnswerToolApprovalBody`、attention 枚举加 `"approval"`。
- **web**：store `toolApproval` 状态 + `answerToolApproval`；reducer 处理 approval 事件、
  复用 `permission_cancel`/`session_updated` 跨端收敛；`ToolApprovalPanel`（允许一次/拒绝）
  与问答选择器互斥；Dashboard 新增 `approval`「待批准工具」卡片进「需要你处理」。

## 影响范围

- 仅当权限模式真正会 gate 某工具时触发：实测 `acceptEdits` 下编辑/`echo` 自动放行不弹；
  `default` 下 Write 等会弹审批。用户切到 `default` 即可获得逐工具审批，不必再全放行。
- 决策为**仅允许一次/拒绝**，不留任何放行记忆（无「始终允许」、不写 updatedPermissions）。

## 验证

- 全量测试：shared 15 + web 22 + local-agent 98 = **135 全绿**；shared/local-agent/web typecheck 通过。
- driver 单测：非 AskUserQuestion → 广播 approval（不再 deny）；approveTool allow/deny
  control_response 正确；二次决策 no-op。
- 真实 claude 探针（[scripts/probe-tool-approval.mjs](../../scripts/probe-tool-approval.mjs)）：
  `default` 模式 Write → can_use_tool → allow 建文件 / deny 回「用户拒绝了该操作。」回合继续。
- web：ApiClient `answerClaudeToolApproval` 单测。
