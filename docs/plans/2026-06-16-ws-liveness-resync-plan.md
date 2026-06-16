# Plan — 修复 WS 假死 + 重连补数据 + 回前台自愈

日期: 2026-06-16
对应 spec: `docs/specs/2026-06-16-ws-liveness-resync-spec.md`

## 改动文件

### 1. `apps/web/lib/ws.ts`（客户端心跳）
- 新增字段：`pingTimer`、`awaitingPong = false`。
- `open()` 的 `open` 事件里启动心跳：`pingTimer = setInterval(tick, PING_INTERVAL)`（PING_INTERVAL ≈ 20s）。
- `tick()`：若 `awaitingPong` 为真（上一拍未回 pong）→ 判定假死，`socket.close()`（触发 onClose 重连）并停表；
  否则 `awaitingPong = true` 并 `send({type:"client:ping", ts: Date.now()})`。
- message 处理：解析后若 `type === "server:pong"` → `awaitingPong = false` 并 `return`（不转发给 store）。
- 新增 `isOpen(): boolean`（`socket?.readyState === WebSocket.OPEN`）。
- `close()` 与假死路径都要 `clearInterval(pingTimer)` 并复位 `awaitingPong`。

### 2. `apps/web/lib/store.ts`
- `onOpen`：在 `set({wsConnected:true})` 后，若有 `selectedId` 且有 `api`，调用 `revalidateTail(api, sel, set, get)` 补数据（函数声明已 hoist，可直接引用）。
- 新增 action `handleVisible()`：
  - `if (document.hidden) return;`
  - 无 `connection` 直接返回；
  - `ws` 不存在或 `!ws.isOpen()` → 清 `reconnectTimer` 并 `connectWs()`；
  - 否则（仍 OPEN）→ 有 `selectedId`+`api` 时 `revalidateTail` 补数据。
- 在 `AppActions` 接口补 `handleVisible: () => void;`。

### 3. `apps/web/app/page.tsx`
- `Console` 内新增 `useEffect`：`addEventListener("visibilitychange", () => useAppStore.getState().handleVisible())`，cleanup 移除。

## 验证
- `pnpm --filter @mac/web typecheck`、`pnpm --filter @mac/web test`。
- 真机手动验证后台/断流恢复。
