# Plan: 挂起选择器跨端/重启接管（方式二）

- 日期: 2026-06-13
- 关联 spec: docs/specs/2026-06-13-pending-permission-recovery-spec.md

## 改动清单

### packages/local-agent/src/history-store.ts
- migrate 增表 `pending_permissions(requestId PK, sessionId, toolName,
  questions TEXT, createdAt TEXT)` + `idx_pending_session`。
- 方法：`savePendingPermission(rec)`、`deletePendingPermission(requestId)`、
  `deletePendingPermissionsBySession(sessionId)`、`listPendingPermissions(sessionId)`、
  `getPendingPermission(requestId)`。

### packages/shared/src/schemas.ts
- `ClaudePendingPermissionSchema` { requestId, toolName, questions[], live }。
- `ClaudePendingPermissionsResponseSchema` { pending: [...] }。

### packages/local-agent/src/claude-driver.ts
- ClaudeDriverOptions 增 `pendingStore?: PendingPermissionStore`（接口含上述 CRUD）。
- WarmProc 增 `resumeAnswers?: Record<string,string|string[]>`（恢复时自动应答）。
- can_use_tool(AskUserQuestion)：
  - 若 `w.resumeAnswers` 存在 → 自动 allow+answers、清空、删持久、不发 UI 事件（恢复路径）。
  - 否则 → 记内存 + `pendingStore.save` + 发 permission_request。
- `answerPermission`（内存存活）：控制 allow+answers + `pendingStore.delete` + 发 cancel。
- 新 `recoverAnswerPermission(sessionId, requestId, answers)`：查持久 → spawnWarm(--resume)
  并置 resumeAnswers、写轻推 prompt、删持久；返回是否成功。
- `listPending(sessionId)`：持久列表，`live = procs.pending 是否含该 requestId`。
- 清理时机：control_cancel / done → 删持久；崩溃 close → 保留（仅发 cancel）；
  interrupt → 删该会话持久。

### packages/local-agent/src/runtime.ts
- 给 ClaudeDriver 传 `pendingStore: store`（HistoryStore 实现该接口）。

### packages/local-agent/src/http-server.ts
- `GET /claude/sessions/:id/pending-permission` → driver.listPending。
- answer-permission：先 `answerPermission`，false 再 `await recoverAnswerPermission`，
  仍 false → 409。

### apps/web
- lib/api.ts：`getClaudePendingPermission(id)`。
- lib/store.ts：`refreshPendingPermission(id)`；在 selectSession 成功后、WS open/重连后调用；
  pendingPermission 增 `live` 字段（仅 UI 提示）。
- app/page.tsx：无需大改（已按 pendingPermission 渲染）；可加一行"来自历史，回答后恢复会话"提示。

## 测试
- 单测：history-store CRUD；driver 持久化保存/删除、recoverAnswerPermission 写
  --resume + resumeAnswers、re-ask 自动 allow+answers、崩溃保留 vs 取消删除。
- 集成：扩展 itest，新增"杀进程→listPending 命中→recover 回答→干净结果"。
- 全量 test + web typecheck。

## 切换
- 仍由 interactivePermissions 控制；默认开。
