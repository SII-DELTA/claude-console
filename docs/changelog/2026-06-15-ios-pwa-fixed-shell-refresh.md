# 2026-06-15 iOS PWA 键盘顶飞输入框 + 刷新按钮无反馈 修复

## 背景
真机（iOS、PWA 全屏 standalone）反馈：
1. 软键盘弹出后，输入框被顶到屏幕顶部，不在键盘上方。
2. 顶部刷新按钮点击「无效」，看不到任何反应。

## 根因
- **键盘顶飞**：iOS standalone PWA 下 `window.innerHeight` 永不变化；输入框聚焦时**系统直接滚动布局视口**把输入框露出来。我们的外壳是普通流（in-flow），这个滚动把整个布局往上顶 → composer 飞到顶部。普通流 + 改 `--app-height` 无法阻止系统级滚动。
- **刷新无反馈**：刷新按钮只是静默调用 `loadSessions()`，无任何加载动画，数据又常无变化，点了像没反应。

## 核心变更
- **固定外壳贴合 visualViewport**（`app/page.tsx` + `app/globals.css`）：
  - 根容器改为 `position: fixed; inset-x-0; top: var(--vv-top); height: var(--app-height)`。
  - `--app-height = visualViewport.height`（键盘上方的可见区），`--vv-top = visualViewport.offsetTop`（跟随 iOS 滚动偏移）；新增 `visualViewport` 的 `scroll` 监听。
  - `html,body { overflow: hidden }` 锁死文档滚动，让 iOS 无处可滚 → 输入框聚焦时布局纹丝不动，composer 始终贴在键盘上方。
  - **关键区别**：固定的是「根容器单个元素」，**不是 body**，且不再用 `transform` —— 上一轮把 `position:fixed` 加在 body 上 + root `transform` 才导致底部 Tab 透明/穿透；本方案规避了这点。
  - 保留 `.kb-open`（键盘开时去掉 composer 下方 safe-area 空隙）。
- **刷新按钮反馈**（`HomeHeader`）：
  - 旋转动画：刷新中 svg 加 `animate-spin`，按钮 `disabled` 防重复点。
  - 刷新内容扩展为 `Promise.all([loadSessions(), loadProjects()])`，`await` 完成后再停转（至少转 500ms，读得出是一次刷新）。

## 影响范围
仅 web 前端（apps/web）：`app/page.tsx`、`app/globals.css`。后端无改动。

## 验证
- `pnpm --filter @mac/web typecheck` 通过。
- `pnpm --filter @mac/web build` 成功。
- iOS PWA 真机键盘/刷新表现需复测确认。
