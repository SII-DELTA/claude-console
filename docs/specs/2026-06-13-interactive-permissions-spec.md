# Spec: AskUserQuestion 交互应答（驱动层控制协议，方案 B）

- 日期: 2026-06-13
- 状态: 已确认（在方案 A 之上实现 B，A 作为兜底保留）
- 关联: docs/specs/2026-06-13-fix-askuserquestion-headless-picker-spec.md

## 背景

方案 A 已让 Web 控制台在 `AskUserQuestion` 无头失败后仍能渲染选择器，但答案以
新一轮对话文本注入、且工具结果为 `is_error`。方案 B 让该工具在**同一回合内**
拿到真实答案（`Your questions have been answered: ...`），语义与终端交互一致。

## 协议验证（实测结论）

通过 `scripts/probe-askuserquestion.mjs` 实测 claude 2.1.160：

1. 仅靠 `initialize` 握手不够——CLI 仍 headless 自动拒绝 `AskUserQuestion`
   （`"Answer questions?"`）。
2. 必须额外传 `--permission-prompt-tool stdio`，CLI 才会把"询问"类权限通过
   stdio 控制协议以 `can_use_tool` 的 `control_request` 发给宿主。
3. 宿主对 `can_use_tool`：
   - 回 `{behavior:"allow", updatedInput:{...input, answers:{<question>:<label|labels[]>}}}`
     → 工具成功（`is_error` 未置），结果为 `Your questions have been answered`。
     单选 answers 值用字符串、多选用字符串数组，均验证可行。
   - 回 `{behavior:"deny", message}` → `is_error` 工具结果，message 作为内容。
4. `initialize` 与首条 prompt 可背靠背发送，CLI 会先处理 initialize（顺序无关）。

## 范围与零回归策略

启用 `--permission-prompt-tool stdio` 后，宿主接管**所有**"询问"类权限决策。
为不改变其他工具的现有行为：

- `tool_name === "AskUserQuestion"`：推送给 UI 渲染选择器，用户选择后回 allow+answers。
- 其他工具：立即回 `deny`（今天这些"需批准"的工具在无头下本就被自动拒绝，
  回 deny 行为等价，零回归）。后续如需 UI 审批可单独立项。

> 说明：被 permission-mode 自动放行的工具（如 acceptEdits 下的编辑/读取）不会
> 走到询问路径，不受影响。

## 开关与兜底

- 驱动新增开关 `interactivePermissions`（env `CLAUDE_INTERACTIVE_PERMISSIONS`，
  `0/false` 关闭）。关闭时回到方案 A（不传 prompt-tool、不发 initialize）。
- 前端同时保留方案 A 的 `findPendingQuestions`（错误结果兜底渲染）。
- 验证通过后默认开启 B。

## 交互流程（B）

1. 模型调用 AskUserQuestion → CLI 发 `can_use_tool` control_request。
2. driver 暂存该请求（requestId+input），保持回合 live，发 bus 事件
   `claude:permission_request`。
3. ws-bridge 广播 `server:claude_permission_request`。
4. 前端 store 记录 pendingPermission，page 渲染 QuestionPanel。
5. 用户选择 → `POST /claude/sessions/:id/answer-permission { requestId, answers }`。
6. driver 回 allow+answers 给 CLI → 工具成功 → 正常续写。
7. 回合被打断/进程结束时，driver 清理未决请求并发 `claude:permission_cancel`，
   前端清除选择器。

## 验收

1. 开关开启时，Web 触发 AskUserQuestion → 选择器弹出 → 选择 → 工具成功
   （非错误结果），Agent 同回合续写。
2. 其他"需批准"工具行为与之前一致（被拒绝），无新增自动放行。
3. 开关关闭时，行为与方案 A 完全一致。
4. 单测（driver 控制协议、前端）通过；真实 claude 集成验证通过。
