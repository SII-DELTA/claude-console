# Change Log: AskUserQuestion 交互应答（方案 B，保留 A 兜底）

- 日期: 2026-06-13
- 关联: docs/specs/2026-06-13-interactive-permissions-spec.md、
  docs/plans/2026-06-13-interactive-permissions-plan.md

## 改动文件

### 协议探针 / 集成验证
- `scripts/probe-askuserquestion.mjs`：逆向 + 实测 claude stdio 控制协议。
- `scripts/itest-interactive-permission.mts`：用真实 ClaudeDriver 跑端到端集成验证。

### shared
- `packages/shared/src/schemas.ts`：新增 `ClaudePermissionQuestion`、
  `ClaudeAnswerPermissionBody`，以及 `ServerMessage`：
  `server:claude_permission_request` / `server:claude_permission_cancel`。

### local-agent
- `bus.ts`：新增 `claude:permission_request` / `claude:permission_cancel`。
- `claude-driver.ts`：实现 stdio 控制协议——
  - 新开关 `interactivePermissions`（env `CLAUDE_INTERACTIVE_PERMISSIONS`，默认开）；
  - 开启时 spawn 追加 `--permission-prompt-tool stdio` 并发送 `initialize`；
  - 拦截 `can_use_tool`：AskUserQuestion → 暂存 + 发 `permission_request`，
    其他工具 → 立即 deny（零回归）；
  - `control_cancel_request` / 进程结束 → 清理 pending 并发 cancel；
  - 新方法 `answerPermission()` → 回 `allow + updatedInput.answers`（单选字符串、
    多选数组），使工具在同一回合返回 `Your questions have been answered`。
- `http-server.ts`：新增 `POST /claude/sessions/:id/answer-permission`。
- `ws-bridge.ts`：广播 permission_request / cancel。

### web
- `lib/api.ts`：新增 `answerClaudePermission()`。
- `lib/store.ts`：新增 `pendingPermission` 状态与 `answerPermission()` action；
  处理 WS 的 request/cancel；切换会话时清空。
- `app/page.tsx`：优先渲染 B 的实时选择器（即使 streaming 中也显示，因回合在等
  用户），保留 A 的 `findPendingQuestions` 兜底。
- `components/QuestionPanel.tsx`：`onSubmit` 同时给出拼接文本（A）与结构化答案（B）。

### 测试
- `packages/local-agent/src/__tests__/claude-driver.test.ts`：新增 5 条 B 用例
  （initialize+stdio、AskUserQuestion allow+answers、非 Ask deny、cancel、close 清理）；
  既有用例显式关闭开关以保持"首条 stdin 即 prompt"的断言。
- `apps/web/__tests__/QuestionPanel.test.tsx`：更新 onSubmit 双参断言。

### 文档
- `docs/local-agent.md`：补充 `CLAUDE_INTERACTIVE_PERMISSIONS` 说明。

## 协议要点（实测 claude 2.1.160）

- 仅 `initialize` 不够，还须 `--permission-prompt-tool stdio`，CLI 才把"询问"类
  权限以 `can_use_tool` control_request 发给宿主。
- allow + `updatedInput.answers`（按问题文本→标签）→ 成功结果；deny+message → 错误结果。
- acceptEdits / bypassPermissions 下 AskUserQuestion 均经 can_use_tool，B 都生效。

## 影响范围 / 零回归

- 仅 AskUserQuestion 走交互选择；其他"需批准"工具仍被拒绝（与启用前无头自动拒绝
  等价）。被 permission-mode 自动放行的工具不经询问路径，不受影响。
- 关闭开关（`CLAUDE_INTERACTIVE_PERMISSIONS=0`）即回退到方案 A，前端兜底仍在。

## 验证结果

- 单测：shared 15 + web 18 + local-agent 74 = 全绿。
- typecheck：web 通过；local-agent 仅余既有 claude-store.test 历史告警（非本次引入）。
- 集成：`itest-interactive-permission.mts` ✅ PASS（真实 claude，acceptEdits 默认模式，
  AskUserQuestion 同回合得到非错误成功结果）。
- 探针另验证 bypassPermissions / acceptEdits 两种模式均生效。
