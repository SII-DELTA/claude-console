# 2026-06-15 监控台/移动端布局修复（滚动 / 安全区 / 状态徽章）

## 核心变更

- **滚动溢出**：根容器 `h-screen` → `h-dvh`（iOS 100vh 含地址栏区域会导致整页可滚）；监控台/设置/会话滚动区加 `overscroll-contain`，防止滚动链冒泡到整页（修复「中间内容滚动时整屏含底部菜单跟着滚」）。
- **顶部被状态栏遮挡**：监控台、设置页滚动区加 `pt-safe`（`env(safe-area-inset-top)`），PWA 全屏下内容下移到状态栏之下（Sessions 页经 `Brand` 已有 `pt-safe`）。
- **状态徽章固定 + 标题自适应**：监控台卡片改为 title `flex-1 min-w-0 truncate` 自适应缩略，状态徽章与时间 `shrink-0` 固定在行尾。

## 改动文件
- `apps/web/app/page.tsx`：根 `h-dvh`；消息滚动区 `overscroll-contain`。
- `apps/web/components/Dashboard.tsx`：卡片布局重排；滚动区 `pt-safe`/`overscroll-contain`。
- `apps/web/components/SettingsPage.tsx`：滚动区 `pt-safe`/`overscroll-contain`。

## 追加：移动端统一表头
- 移动 home（监控台/Sessions/Settings）顶部加统一 `HomeHeader`：标题(当前页) + **usage 余量** + **连接状态圆点** + **刷新按钮**（刷新=重拉会话列表），带 `pt-safe`。
- 由表头统一提供顶部安全区后，移除 Dashboard/Settings 各自的 `pt-safe`。
- `Brand` 拆出可复用的 `ProjectPicker`：桌面侧栏仍用 `Brand`；移动 Sessions 页用 `ProjectPicker`（不再重复标题/安全区）。

## 验证
- `pnpm --filter @mac/web typecheck` 通过；web 测试 18 全绿。
- 监控台视觉重设计（image2）另行进行。
