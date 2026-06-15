# Spec: 消息已读回执 + 权威运行状态（loading 可靠化）

- 日期: 2026-06-16
- 状态: 已确认（A+B 都做）

## 问题与根因

1. **loading 时有时无**：`driveStatus`/`stream` 是纯前端乐观本地状态，只在本客户端
   发送时置 streaming、靠 WS drive_done/error 清除。刷新、换端、断线重连、回合在别处
   发起都会脱节。服务端权威的 `driver.isDriving`（write→done 间正在跑一轮）**从未暴露**。
2. **不确定消息有没有被收到**：发送是 `await continueClaudeSession`，HTTP 200 即"已收到
   并写入 claude"，但 UI 无"发送中/已送达/失败"可视状态，也无"已读(开始处理)"概念。

## 方案 A：权威运行状态

- driver 维护 busy 切换并发新事件 `claude:driving(sessionId, driving)`：write→true；
  done/error/进程结束/kill/interrupt→false（去重，只在变化时发）。
- session 元数据加 `driving`（claude-store 经 `drivingPredicate=()=>driver.isDriving(id)`）。
- ws 广播 `server:claude_driving`。
- 前端：`sessions[].driving` 跟随事件更新；有效 loading =
  本地 `driveStatus==="streaming"` **或** `selected.driving`。刷新/换端/重连都正确，
  回合真正结束(driving=false)可靠清除。

## 方案 B：已读回执

- store 维护 `sendStatus { id, state }`：sending →(HTTP 200) delivered →
  (driving=true / 首个 delta) read；POST 失败 → failed。endTurn(回合结束)后清除。
- UI：在最后一条用户气泡下显示 发送中… / 已送达 ✓ / 已读·处理中 ✓✓ / 发送失败 ↻。

## 验收
1. 发送后立即显示"发送中"，HTTP 成功转"已送达"，agent 开始跑转"已读"。
2. 刷新/换设备/断线重连后，正在跑的会话仍显示 loading；跑完可靠消失。
3. 失败显示"发送失败"，气泡不丢。
4. 单测 + typecheck 通过。
