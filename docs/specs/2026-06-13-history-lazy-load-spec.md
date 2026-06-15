# Spec — 历史会话懒加载（服务端分页 + 上滑加载更早）

日期: 2026-06-13

## 问题

打开历史会话很慢：`getSession` 一次性返回整条会话的全部消息，服务端大 JSON 过慢链路（公网→Tailscale→Mac），前端又一次性渲染几百条（含 markdown 解析）。两头都慢。

## 目标

- 初次打开会话只加载**最近 N 条**（默认 40），首屏网络与渲染都变小。
- 向上滚动到顶部时**自动加载更早**一页，保持滚动位置不跳。
- 不破坏：内部调用者（driver）、发送消息后的增量、结束驱动后的权威刷新。

## 非目标

- 不做虚拟列表（窗口化渲染）；本方案靠分页控制规模即可。
- 不改消息存储格式（jsonl 仍 append-only，按数组下标分页稳定）。

## 接口契约

`GET /claude/sessions/:id?limit=<n>&before=<index>`

- 无参数：返回最后 `limit`（默认 40）条。
- `before`=绝对下标：返回 `[max(0, before-limit), before)` 区间（用于加载更早）。
- 响应：`{ session, messages, total, offset }`
  - `total`：完整消息数（= `messageCount`）
  - `offset`：本次返回切片的起始下标
  - `hasMore`（前端推导）= `offset > 0`

兼容：`store.getSession(id)` 不传 opts 时返回全部消息（driver 等内部调用不受影响）。

## 前端行为

- `selectSession`：请求尾页（不带 before），记录 `total/offset`。
- 顶部出现「加载更早」触发点（IntersectionObserver 或按钮），调用 `loadEarlier()` 取 `before=offset` 的上一页，**前插**消息并补偿 scrollTop 防跳动。
- `offset===0` 时隐藏触发点。
- 发送/流式/结束驱动后的刷新仍取尾页。

## 验证

- 长会话首屏只传最近 N 条（payload 显著变小）。
- 上滑能逐页补齐到最早；滚动位置不跳。
- typecheck + 现有测试通过；getSession 新增分页单测。
