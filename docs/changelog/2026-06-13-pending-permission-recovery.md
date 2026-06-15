# Change Log: 挂起选择器的跨端/重启接管（方式二，持久化恢复）

- 日期: 2026-06-13
- 关联: docs/specs/2026-06-13-pending-permission-recovery-spec.md、
  docs/plans/2026-06-13-pending-permission-recovery-plan.md

## 背景

方案 B 的待答 AskUserQuestion 只存在 driver 内存 + 一条实时 WS 广播，错过广播
（换设备/刷新/重连）或 local-agent 重启后就无法接管。本次用既有 SQLite 持久化
待答请求，使选择器可跨端恢复，并在 agent 重启后仍可接管回答。

## 改动文件

### local-agent
- `history-store.ts`：新增 `pending_permissions` 表及 CRUD
  （save/delete/deleteBySession/get/list）。
- `claude-driver.ts`：
  - 新增 `PendingPermissionStore` 接口与 `pendingStore` option；`PendingPermissionView`。
  - WarmProc 增 `resumeAnswers`：恢复路径下自动应答 resume 后重新发起的提问。
  - 收到 can_use_tool(AskUserQuestion) surface 时写入持久层；
  - answerPermission / control_cancel / done / interrupt 删除持久行；
  - 进程崩溃 close **保留**持久行（用于恢复，仅向 UI 发 cancel）；
  - 新增 `recoverAnswerPermission()`：`--resume` 会话、置 resumeAnswers、轻推一句，
    对重新发起的问题自动 `allow+answers` → 干净成功结果；
  - 新增 `listPending()`：合并持久行，`live` 表示内存中是否仍可直接应答。
- `runtime.ts`：把 HistoryStore 作为 `pendingStore` 注入 driver。
- `http-server.ts`：`GET /claude/sessions/:id/pending-permission`；answer-permission
  在内存未命中时回退 `recoverAnswerPermission`。

### shared
- `schemas.ts`：`ClaudePendingPermission`、`ClaudePendingPermissionsResponse`。

### web
- `lib/api.ts`：`getClaudePendingPermission()`。
- `lib/store.ts`：`refreshPendingPermission()`；在选中会话、WS open/重连时拉取并恢复；
  pendingPermission 增 `live`。
- `app/page.tsx`：B 选择器在 `live===false`（来自历史）时显示一行恢复提示。

### 脚本 / 测试
- `scripts/itest-pending-recovery.mts`：重启恢复端到端集成（真实 claude + SQLite）。
- `__tests__/history-store.test.ts`：pending CRUD 用例。
- `__tests__/claude-driver.test.ts`：持久化保存/删除、close 保留、listPending live、
  done 清理、recoverAnswerPermission resume+自动应答 等 6 条用例。

## 验证结果

- 单测：shared 15 + web 18 + local-agent 83 = 全绿；web typecheck 通过。
- 集成：`itest-pending-recovery.mts` ✅ PASS —— 问题持久化 → 模拟 agent 重启
  （销毁进程，行仍在）→ 新 driver listPending(live=false) → 恢复回答 → resume
  重新发起 → 自动 allow+answers → 干净成功结果。

## 影响范围 / 限制

- 仍受 `interactivePermissions`（方案 B 开关）约束；关闭则不持久化、回退方案 A。
- 仅 AskUserQuestion 持久化；其他工具行为不变。
- 重启恢复时，被杀的那一轮会在历史里留下一条
  "Tool permission stream closed" 的失败结果（无害），随后的重新提问得到干净结果。
