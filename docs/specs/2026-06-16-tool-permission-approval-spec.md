# 工具权限审批 Spec

- 日期: 2026-06-16
- 状态: 待确认
- 关联: docs/changelog/2026-06-13-interactive-permissions.md、
  docs/2026-06-13-askuserquestion-edge-audit.md

## 背景与问题

当前 headless driver 只为 `AskUserQuestion` 做了交互式处理（方案 B）。其余任何走到权限
「询问」路径的工具，在 [claude-driver.ts handleControl](../../packages/local-agent/src/claude-driver.ts)
里一律 `respondPermissionDeny` 直接拒绝并报错：

```
${tool_name} 需要交互式批准，Web 控制台暂不支持该工具的审批。
```

后果：除非把权限模式设成 `bypassPermissions`/对编辑用 `acceptEdits` 全放行，否则
Bash 等敏感工具一触发就报错，手机端**没有任何「批准」入口**。

## 目标

给非 AskUserQuestion 的工具增加**真正的允许/拒绝审批**：claude 询问某工具时，把
「工具名 + 参数摘要」推到 web，用户点：

- **允许一次**：本次放行。
- **拒绝**：拒绝本次，并把原因回给模型，回合继续不卡死。

AskUserQuestion 维持现状（它是「提问」不是「审批」，UI/语义不同）。

## 决策（已确认）

- 审批选项：**仅允许一次 / 拒绝**（不做「始终允许」，不留任何放行记忆，安全优先）。
- 默认权限模式：保持 `acceptEdits`（编辑自动放行，Bash 等才触发审批）。

## 行为规格

### 驱动 / 控制协议（local-agent）

`handleControl` 收到 `can_use_tool`：

1. `tool_name === "AskUserQuestion"` → 现有提问选择器路径（不变）。
2. 其它工具：挂起请求、关闭空闲回收、持久化、广播 `claude:tool_approval_request`
   （携带 `toolName` 与 `summary`），等待 web 决定。

审批应答 `approveTool(sessionId, requestId, decision)`：

- `allow` → `behavior:"allow"`，`updatedInput` 为原 input。
- `deny` → `behavior:"deny"`，`message:"用户拒绝了该操作。"`（干净非错误，回合继续）。
- 两者都：删内存+持久行、广播 `claude:permission_cancel`（复用，按 requestId 关弹窗）、
  re-arm 空闲回收。
- 写 stdin 失败（进程刚死）→ 返回 false，不删记录（与 AskUserQuestion 同策略，避免静默丢）。

参数摘要 `summary`（纯函数，可单测）：按工具名抽关键字段，例如
- `Bash` → `command`（截断）
- `Write`/`Edit`/`Read` → `file_path`
- 其它 → `JSON.stringify(input)` 截断到 ~200 字。
仅用于展示，真正放行用原始 `input`。

### 持久化（落库）/ 恢复

工具审批请求**必须落库**（与 AskUserQuestion 同等持久），存到现有 SQLite
`pending_permissions` 表，便于重连、刷新、跨端、agent 重启后仍能看到并处理：

- 表结构扩展：新增 `kind TEXT NOT NULL DEFAULT 'question'`（`question` | `approval`）
  与 `toolInput TEXT`（approval 的原始 input，JSON）。用 guarded `ALTER TABLE ADD COLUMN`
  迁移，旧行默认 `kind='question'`。
- `savePendingPermission` / `getPendingPermission` / `listPendingPermissions` 带上
  `kind`、`toolInput`。`listPending` 同时返回两类：question → 选择器；approval → 审批面板。
- 进程仍存活时重连可继续审批。进程已死的 approval **不做 resume 自动重放**（工具调用无法
  像问题那样被「重问」），标 `live:false`，前端可「拒绝/忽略」收敛，绝不静默。

### 广播 / 跨端一致（与问答选择器完全一致）

- **出现即广播**：surface 时 `claude:tool_approval_request` → ws 广播到所有在线端；
  同时该会话 attention 变化通过 `claude:session_updated` 广播（驱动 surface/resolve 后调用
  `claude.refreshSession(id)` 重新派生并广播）。
- **任一端处理后广播取消**：任意一端 allow/deny/dismiss 后 →
  1) 删库行；2) 广播 `claude:permission_cancel`（按 requestId，让**所有端**关闭审批面板）；
  3) `refreshSession` → 广播 `session_updated`（让所有端清除「待批准」角标）。
  与现有 AskUserQuestion 取消路径同构。先到者成功，后到者 HTTP 409（前端按「已失效」静默收敛）。

### Dashboard（监控页）提示与处理

- attention 枚举新增 `"approval"`（`ClaudeSessionSchema.attention`）。approval **不在 JSONL 里**
  （是运行时控制协议事件），故 `ClaudeStore` 构建会话 meta 时合并查询库中该会话的
  pending approval：存在则 `attention = "approval"`（优先级高于 `done`，与 `question` 同属
  「需要你处理」）。
- `Dashboard.tsx`：`AttKind` 增加 `approval` 配置（图标 + 文案，如「待批准」），纳入
  「需要你处理」列表；整卡可点进会话处理（沿用 commit 78d6afa 的整卡可点交互）。

### 数据模型（@mac/shared）

- `ClaudeToolApprovalSchema = { requestId, toolName, summary, live }`
- `ServerClaudeToolApprovalRequestSchema = { type:"server:claude_tool_approval_request",
  sessionId, requestId, toolName, summary }` → 并入 `ServerMessageSchema`。
- 关闭复用 `server:claude_permission_cancel`（仅 requestId）。
- `ClaudeSessionSchema.attention` 枚举新增 `"approval"`。
- REST: `POST /claude/sessions/:id/answer-tool-approval`
  body `{ requestId, decision: "allow"|"deny" }`。
- `pending-permission` GET 响应同时含 question 与 approval（按 kind 区分）。

### Web

- store：新增 `toolApproval` 状态 + `answerToolApproval(decision)`；处理
  `server:claude_tool_approval_request`（仅选中会话弹面板，后台会话照旧系统通知）。
- 新组件 `ToolApprovalPanel`：标题「Claude 想执行 <toolName>」+ `summary` + 两个按钮
  （允许一次 / 拒绝）。
- 与 AskUserQuestion 互斥：同一时刻最多一个面板。
- 决策提交后乐观关闭；`permission_cancel` / `session_updated` 兜底对账（同现有选择器）。

## 验证

- driver 单测：非 AskUserQuestion can_use_tool → 广播 approval 而非 deny；
  allow/deny 两分支写出的 control_response 正确；写失败保留记录。
- 探针/集成：用真实 claude 触发一次 Bash 审批，allow 后命令执行、deny 后回合继续。
- web：reducer 处理 approval 事件 + 两按钮提交；面板互斥。

## 验证（补充）

- store/库：approval 落库 + `kind`/`toolInput` 迁移；listPending 区分两类；
  resolve 后删库行。
- 跨端：A 端 surface → B 端也收到 `tool_approval_request` 且看到「待批准」角标；
  A 端 allow → B 端面板关闭、角标消失（permission_cancel + session_updated）。
- Dashboard：pending approval 的会话出现在「需要你处理」，整卡点进可处理。

## 非目标 / 取舍

- 不改默认权限模式（保持 acceptEdits）。
- approval 落库持久，但**不做 resume 自动重放**（进程死亡 → 标 live:false，用户手动收敛，非静默）。
- **不做「始终允许」**：每次触发都问，不留放行记忆，也不写 `updatedPermissions` 规则（安全优先，实现更简单）。
