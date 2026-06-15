# Plan — 历史会话懒加载实现

日期: 2026-06-13
对应 spec: 2026-06-13-history-lazy-load-spec.md

## 常量

`HISTORY_PAGE = 40`（每页条数）。

## 1. 服务端 `packages/local-agent/src/claude-store.ts`

`getSession(id, opts?: { limit?; before? })` 增加分页：
- 读全量 `acc.messages`，`total = acc.messages.length`。
- `end = before != null ? clamp(before,0,total) : total`
- `limit` 缺省 → 返回全部（向后兼容 driver）；给定 → `start = max(0, end-limit)`。
- 返回 `{ session, messages: slice(start,end), total, offset: start }`。

## 2. 端点 `packages/local-agent/src/http-server.ts`

`GET /claude/sessions/:id` 读取 querystring `limit`/`before`（Number 校验），透传给 `getSession`。

## 3. `apps/web/lib/api.ts`

`claudeSession(id, opts?: { limit?; before? })`：拼 query；返回类型加 `total`、`offset`。

## 4. `apps/web/lib/store.ts`

- 新增 state：`historyOffset: number`、`loadingEarlier: boolean`；`hasMoreHistory` 由 `historyOffset > 0` 推导。
- `selectSession`：`claudeSession(id, { limit: HISTORY_PAGE })`，记录 `historyOffset = res.offset`。
- `loadEarlier()`：守卫（offset<=0 / loadingEarlier / 无选中）→ 取 `{ before: historyOffset, limit: HISTORY_PAGE }` → 前插 messages，更新 historyOffset。
- `endTurn`：改为请求尾页 `{ limit: HISTORY_PAGE }`，更新 historyOffset（结束后回到最新一页）。
- `setConnection`/`switchProject`/`selectSession(null)`：重置 historyOffset=0、loadingEarlier=false。

## 5. `apps/web/app/page.tsx`

- Timeline 上方加顶部哨兵 + 「加载更早的消息」按钮（`hasMoreHistory` 时显示）。
- IntersectionObserver 观察哨兵，进入视口自动 `handleLoadEarlier()`。
- `handleLoadEarlier`：记录 `scrollHeight/scrollTop` → await loadEarlier → rAF 内补偿 `scrollTop`，并置 `skipAutoScrollRef` 防底部跳转 effect 误触发。
- 既有跳到底 effect：`skipAutoScrollRef` 为真时直接 return 并复位。

## 6. 测试

`claude-store.test.ts` 加分页用例：尾页条数、`offset/total` 正确、`before` 取上一页、越界 clamp。

## 验证

typecheck + `pnpm test` 全绿；长会话首屏 payload 显著变小；上滑逐页补齐、滚动不跳。
