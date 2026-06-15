# Change Log: 消息已读回执（方案 B）

- 日期: 2026-06-16
- 关联: docs/specs/2026-06-16-delivery-and-driving-state-spec.md（方案 B）
- 前置: 权威运行状态（方案 A / liveness）已由 `52b74f3` 完成；本次补「已读回执」。

## 背景

发送是 `await continueClaudeSession`，HTTP 200 即"已写入 claude"，但 UI 没有
"发送中/已送达/已读/失败"的可视状态,用户不确定消息有没有被收到/开始处理。

## 改动文件（仅前端,2 文件 + 1 测试,未触碰并行在改的 page.tsx/Dashboard）

- `apps/web/lib/store.ts`
  - 新增 `SendState` 与 `sendStatus { sessionId, messageId, state }`。
  - `sendPrompt`：发送即 `sending`；HTTP 成功 `markDelivered`→`delivered`；
    失败时——live 冲突走接管(丢气泡、清回执)，其他错误**保留气泡 + 标 `failed`**（不再静默吞消息）。
  - `markRead`：收到该会话首个 delta 或 `driving=true` → `read`。
  - 回合结束(`endTurn`)清除回执。
- `apps/web/components/Timeline.tsx`：从 store 读 `sendStatus`，在匹配的最后一条用户
  气泡下渲染 `发送中… / 已送达 ✓ / 已读·处理中 ✓✓ / 发送失败`（直接读 store，不经 page.tsx 传参）。
- `apps/web/__tests__/Timeline.test.tsx`：新增 3 条回执渲染用例。

## 影响范围

- 纯前端、客户端状态,无 schema/后端改动;与并行的 liveness/push/swipe-back 解耦。
- 利用方案 A 的 `driving` 事件驱动"已读",刷新/换端由 liveness 的 driving 兜底。

## 验证

- web 测试 21/21（+3）；local-agent 97、shared 15 全绿；web typecheck 通过。
