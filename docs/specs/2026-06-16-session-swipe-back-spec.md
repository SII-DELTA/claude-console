# 会话详情页边缘滑动返回手势 Spec

- 日期：2026-06-16
- 主题：移动端进入会话详情页后，支持左/右边缘滑动返回上一级
- 状态：设计已确认（待实现）

## 背景

移动端进入某个 session 的会话详情页（`apps/web/app/page.tsx` 中 `mobileDetail` 为真时渲染的 `<main>`）后，目前只能点击左上角返回按钮（`goBack()`）回到首页 tab。需要增加手势：从屏幕**左或右边缘**水平滑动即可返回，符合移动端直觉。

## 现状

- 框架：Next.js 14 + React 18，Zustand 状态，无路由库；选中会话写入 URL query。
- 返回逻辑：`goBack()` → `selectSession(null)` + `setComposeNew(false)`（`apps/web/app/page.tsx:230`）。
- 已有触摸代码：下拉刷新（`apps/web/lib/usePullToRefresh.ts`、`SessionList.tsx`），均为原生 Touch Events，无第三方手势库。
- 详情页内含可横向滚动的代码块/表格（Timeline），以及垂直滚动消息列表。

## 需求与确认的设计

1. 触发区域：**仅屏幕左右边缘**（距左边缘或右边缘约 24px 内开始的水平滑动）。
   - 理由：最大程度避免与代码块/表格横向滚动、消息垂直滚动冲突，类似 iOS 侧滑返回。
2. 方向：**左滑或右滑都返回**（任一水平方向超过阈值即触发）。
3. 视觉反馈：**跟手位移 + 回弹**。
   - 滑动时 `<main>` 跟随手指水平位移；松手时超过阈值则返回，否则回弹归位。

## 行为细节

- 起始判定：`touchstart` 落点 `clientX <= EDGE(24)` 或 `clientX >= innerWidth - EDGE` 才进入候选；否则忽略。
- 轴锁定：移动超过 8px 后判定主方向；若垂直位移大于水平位移则取消手势（交还给原生滚动）。
- 跟手：水平位移 `dx` 限幅 `[-MAX(120), MAX]`，应用到 `<main>` 的 `translateX`。
- 触发阈值：`|dx| >= THRESHOLD(60)` 时松手触发 `goBack()`。
- 回弹：未达阈值松手，`dx` 归零并加 `transition` 平滑回弹。
- 仅在 `mobileDetail` 为真时启用（桌面端无影响）。
- `touchmove` 在锁定为水平手势后 `preventDefault`，避免页面横向抖动。

## 涉及改动

- 新增 `apps/web/lib/useEdgeSwipeBack.ts`：封装边缘滑动检测，返回 `{ ref, dx }`。
- 修改 `apps/web/app/page.tsx`：在详情 `<main>` 挂载 `ref`，按 `dx` 应用 `transform`/`transition`，`enabled = mobileDetail`，回调复用 `goBack`。

## 验证

- 移动端从左/右边缘水平滑动 → 详情页跟手位移，超过阈值松手返回首页。
- 未达阈值松手 → 回弹归位，不返回。
- 在代码块/表格上横向滚动、消息列表上垂直滚动 → 不误触发返回。
- 桌面端无任何变化。
- `pnpm --filter web typecheck`（或等价）通过。
