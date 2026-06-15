# 2026-06-15 移动端键盘/视口 + 发送失败吞输入 修复

## 背景
用户在手机上反馈三个问题：
1. 底部 Tab 菜单位置仍不正确（底部留空，需下拉才正常）。
2. 点击输入框、软键盘弹出后，输入框被顶到屏幕顶部、与键盘之间留大片空白。
3. 发送消息失败后，刚输入的内容被静默清空、无法重发；且「经常发送失败（timeout）」。

## 根因
- **视口/键盘**：`--app-height` 由 `window.innerHeight` 驱动。现代 Chrome/Android 默认 `interactive-widget=resizes-visual`，键盘弹出时 *布局视口*（innerHeight）不变，只有 *视觉视口* 收缩；容器没收缩到可见区，composer 被挤出可见范围。`body` 也未锁定滚动，页面可滚出空隙。
- **发送吞输入**：`Composer.submit()` 在异步 `onSend` 解析前就同步清空了输入框；失败时 store 又移除乐观气泡 → 输入彻底丢失。
- **经常 timeout**：`api.request()` 对所有请求硬编码 12s `AbortController` 超时，包含 `POST /continue`。冷 `claude --resume`（进程启动 + 大 jsonl 解析 + Tailscale 远程延迟）常超过 12s 才 ack。

## 核心变更
- **视口**：
  - `app/layout.tsx`：viewport 增加 `interactiveWidget: "resizes-content"`，键盘弹出时收缩布局视口，composer 自然贴在键盘上方。
  - `app/page.tsx`：`--app-height` 改由 `visualViewport.height` 驱动（回退 innerHeight），并写入 `--vv-offset = visualViewport.offsetTop`；新增 `visualViewport` 的 `scroll` 监听；根容器 `transform: translateY(var(--vv-offset))` 跟随偏移（兼容 iOS 键盘覆盖式弹出）。
  - `app/globals.css`：`html,body { overflow: hidden }`，`body { position: fixed; inset: 0 }` 锁定页面滚动，杜绝底部 Tab 漂移留空。
- **发送失败保留输入**：
  - `lib/store.ts`：`sendPrompt` 返回 `Promise<boolean>`（成功 true / 失败 false）。
  - `app/page.tsx`：`handleSend` 改为 `async` 返回 boolean。
  - `components/Composer.tsx`：`submit()` 先快照 text/images 再乐观清空；`onSend` 解析为 `false`（或抛错）时还原草稿并重新聚焦输入框。
- **超时**：
  - `lib/api.ts`：`request()` 增加 `opts.timeoutMs`（默认 12s）；`newClaudeSession` / `continueClaudeSession` 改用 **45s**，给冷 resume + 大会话解析 + 远程链路足够预算。

## 影响范围
仅 web 前端（apps/web）。后端无改动。`sendPrompt` 返回类型由 `void`→`boolean`，调用点（QuickActions / QuestionPanel）忽略返回值，向后兼容。

## 验证
- `pnpm --filter @mac/web typecheck` 通过（`interactiveWidget` 为 Next 14.2 合法字段）。
- `pnpm --filter @mac/web test` 18 全绿。
- `pnpm --filter @mac/web build` 成功。
- 设备端键盘/底部 Tab 表现需在真机复测确认。
