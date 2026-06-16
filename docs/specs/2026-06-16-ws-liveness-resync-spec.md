# Spec — 修复会话「久了没更新 / 自己停掉」（WS 假死 + 重连不补数据）

日期: 2026-06-16

## 背景

移动端长时间空闲 / 切后台 / 网络切换后，会话经常「停在某处不再更新」。排查确认：本地 agent 仍在运行并写会话文件，问题在前端 WS 推送通道：

1. **客户端无主动心跳 / 无假死检测**：服务端每 30s ping 客户端（`HEARTBEAT_INTERVAL_MS`）并 terminate 不回 pong 的；但客户端（`ws.ts`）自己不发 ping，也不检测假死。手机锁屏/后台/WiFi↔流量切换时 WebSocket 常静默断开却不触发 `close`，于是 `store.ts` 的 3s 自动重连根本不触发——前端仍以为在线（`wsConnected=true`），收不到任何推送。
2. **重连后不补数据**：`store.ts` 的 `onOpen` 只 `refreshPendingPermission`，未重新拉取当前会话消息，断线期间的 `claude:message`/`delta`/`drive_done` 全丢，时间线冻结。
3. **回前台无重连/重拉**：全局无 `visibilitychange` 处理（仅 notify.ts 用于标题闪烁），手机切回前台不校验连接、不重连、不补消息。

## 目标（完整修复）

- **A. 客户端主动心跳**：WsClient 定期发 `client:ping`，服务端回 `server:pong`；若一个周期内未收到 pong 即判定假死，主动关闭触发既有重连。pong 帧在 WsClient 内部消化，不外泄给 store。
- **B. 重连补数据**：`onOpen` 在恢复连接后，对当前选中会话调用 `revalidateTail` 重新拉取尾部消息，补回断线期间更新。
- **C. 回前台自愈**：监听 `visibilitychange`，页面可见时若 socket 非 OPEN 立即重连（不等可能被冻结的 3s 定时器）；若仍 OPEN 则对当前会话 `revalidateTail` 补数据。

## 设计要点

- `WsClient` 新增：`isOpen()`；心跳定时器（间隔 ~20s，复用现有 `HEARTBEAT_INTERVAL_MS` 或略小）；`awaitingPong` 标志；收到 `server:pong` 清标志并不转发；下一拍仍 `awaitingPong` 则 `terminate→close`。
- `store.ts`：`onOpen` 增补 `revalidateTail`；新增 `handleVisible()` action（可见时按 socket 状态重连或补数据）。
- `page.tsx`：`useEffect` 注册/清理 `visibilitychange` → `handleVisible()`（仅一次）。

## 非目标

- 不改服务端心跳（已正确）。
- 不改协议（复用既有 `client:ping`/`server:pong`）。
- 不引入消息序列号/断点续传等重型可靠投递（本次以「重连即重拉尾部」覆盖）。

## 验证

- typecheck + 现有测试通过。
- 手动（真机）：切后台几分钟回前台 → 会话自动补到最新、继续更新。
- 前台拔网/断流 → ~一个心跳周期内检测到并重连、补数据。
