# Change Log: 修复会话「久了没更新 / 自己停掉」（WS 假死 + 重连补数据 + 回前台自愈）

- 日期: 2026-06-16
- 关联: docs/specs/2026-06-16-ws-liveness-resync-spec.md、
  docs/plans/2026-06-16-ws-liveness-resync-plan.md

## 改动文件

### web
- `lib/ws.ts`：新增客户端主动心跳——每 20s 发 `client:ping`，下一拍仍未收到
  `server:pong` 即判定链路假死，`close()` 触发既有重连；`server:pong` 帧在 WsClient
  内部消化不外泄；新增 `isOpen()`；`close()` 与假死路径均停表复位。
- `lib/store.ts`：
  - `onOpen`（重连成功）对当前会话调用 `revalidateTail`，补回断线期间漏掉的
    `claude:message`/`delta`/`drive_done`；
  - 新增 `handleVisible()` action：页面可见时若 socket 非 OPEN 立即重连（不等可能被
    冻结的 3s 定时器），否则对当前会话补拉尾部。
- `app/page.tsx`：新增 `visibilitychange` 监听 → `handleVisible()`（回前台自愈）。

## 核心变更

- 解决移动端长空闲/切后台/网络切换后 WebSocket 静默断开却不触发 `close`、前端误以为
  在线而停更的问题：客户端主动探活 + 回前台立即重连 + 重连/恢复后补拉当前会话。

## 影响范围

- 仅前端 WS 连接与会话恢复；服务端心跳（已正确）与协议未改。
- 复用既有 `client:ping`/`server:pong` 协议与 `revalidateTail` 补数据逻辑。

## 验证结果

- `pnpm --filter @mac/web typecheck` 通过；`pnpm --filter @mac/web test` 21 项全绿。
- 真机后台/断流恢复需手动确认。

## 备注

- 本次提交的 `page.tsx` 一并带入了另一会话尚未单独提交的「点击推送通知打开会话」
  wiring（`onPushOpenSession`），其代码已完整且整树可编译。
