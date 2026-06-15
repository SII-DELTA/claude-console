# Spec: 挂起选择器的跨端/重启接管（持久化恢复，方式二）

- 日期: 2026-06-13
- 状态: 已确认（方式二：SQLite 持久化 + 恢复）
- 关联: docs/specs/2026-06-13-interactive-permissions-spec.md

## 背景

方案 B 让 AskUserQuestion 可交互应答，但待答请求只存在 driver 内存 + 一条实时
WS 广播里。错过广播（换设备、刷新、断线重连）或 local-agent 重启后，前端无法
再拿到挂起的选择器，导致"接管挂很久的选择器"做不到。

## 实测结论（claude 2.1.160）

- driver 在有待答问题时已停掉空闲回收，进程与待答请求会一直挂着不丢（只要
  agent 进程活着）。
- 进程被杀后（模拟 agent 重启），会话历史里留下"有提问、无答复"的悬空 tool_use。
  `--resume` 该会话并轻推一句，claude 会**重新发起**同一 AskUserQuestion；此时用
  持久化的选择回 `allow+answers` → 得到干净结果
  `Your questions have been answered`（非错误）。

## 设计

### 持久化（SQLite，复用 history.sqlite）

新表 `pending_permissions(requestId PK, sessionId, toolName, questions JSON,
createdAt)`。

- 收到 `can_use_tool`(AskUserQuestion) 且需用户回答时：写入。
- 用户回答成功 / claude 主动取消(control_cancel) / 该会话回合结束(done) /
  显式 interrupt：删除。
- 进程崩溃/重启（非显式取消）：**保留**（这正是要恢复的对象），仅向 UI 发 cancel
  让当前选择器消失，但记录仍可被 GET 拉回。

### 恢复读取

`GET /claude/sessions/:id/pending-permission` → `{ pending: [{ requestId,
toolName, questions, live }] }`。`live=true` 表示内存中仍可用控制协议直接应答；
`live=false` 表示只在持久层（进程已死，需 resume 恢复）。

前端在**选中会话**与 **WS 重连**时拉取；有则渲染 QuestionPanel。

### 回答

`POST /claude/sessions/:id/answer-permission { requestId, answers }`：

1. 先试内存存活：driver.answerPermission → 控制协议 `allow+answers`（干净、同回合）。
2. 不在内存：查持久层 → driver.recoverAnswerPermission：`--resume` 该会话、为其
   置 `resumeAnswers`、轻推一句；driver 对 resume 后**重新发起**的
   AskUserQuestion 自动 `allow+answers`，不再打扰用户 → 干净结果。
3. 两种路径都删除持久记录并广播 cancel。

### 开关

整体受 `interactivePermissions`（方案 B 开关）约束；关闭时不持久化、不恢复，回到
方案 A 兜底。

## 验收

1. 电脑会话挂起选择器后，手机打开同一会话能看到并回答（错过实时广播也行）。
2. 刷新/断线重连后选择器能恢复。
3. local-agent 重启后，打开会话仍能看到挂起选择器；回答后会话以干净结果续写。
4. 回答/回合结束/取消后，持久记录被清理，不残留过期选择器。
5. 单测（store CRUD、driver 持久化与恢复）+ 集成（重启恢复）通过；关闭开关回退方案 A。
