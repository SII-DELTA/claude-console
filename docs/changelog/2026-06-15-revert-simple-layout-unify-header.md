# 2026-06-15 回退到简单布局（修底部空隙/透明）+ 统一表头/刷新

## 背景
连续多轮针对 iOS 的视口修复（`--app-height` / `position:fixed` 外壳 / `visualViewport` /
`kb-open` 阈值）反而引入新问题：底部 Tab 下方留空、Sessions 页内容穿透「透明」。
用户指出「底部三个菜单之前的版本是好好的」，要求回到那套做法。

## 核心变更
- **回退到改版前的简单布局**（来自初始版本 `ea02850` 的做法）：
  - 根容器 `flex h-[100dvh] overflow-hidden flex-col md:flex-row`，**纯 CSS 定高**，不再用 JS 算高度。PWA / `dvh` 下 `100dvh` 恰好等于整屏，底部 Tab 永远贴底，无空隙、无穿透。
  - 删除整段 `--app-height` / `--vv-top` / `kb-open` 的 `useEffect`。
  - `globals.css` 删除 `.app-shell`、`.kb-open`，`html/body` 恢复 `min-height:100dvh`（去掉 `overflow:hidden`/`position:fixed`）。
- **刷新按钮 = 整页刷新**：之前只是静默重拉 + 转圈，用户预期是整页刷新。抽出共享 `RefreshButton`，点击 `window.location.reload()`，按下时图标旋转 180° 作反馈。
- **会话详情页表头去掉 `⋯` 菜单**：改为与上级页面一致的刷新按钮（`复制会话ID`/`断开` 移除——断开在 Settings 页可用）。
- **连接状态圆点统一位置**：移到右侧簇 `usage 之后、刷新按钮之前`。
  - HomeHeader：`usage → 圆点 → 铃铛 → 刷新`。
  - 详情页：`usage → 圆点 → 刷新`（无铃铛）。

## 关于键盘
首页（监控台/Sessions/Settings）静止态本就没有键盘/输入框，之前的空隙/透明纯属布局问题，已随回退解决。会话详情页的软键盘行为交回浏览器默认（`interactive-widget=resizes-content` 仍保留给 Android）；如 iOS 详情页再现「顶飞」，将单独做最小化处理，不再动首页布局。

## 影响范围
仅 web 前端：`app/page.tsx`、`app/globals.css`。删除未用的 `DetailMenu`/`MenuItem`。

## 验证
- `pnpm --filter @mac/web typecheck` 通过；`build` 成功；无残留 `--app-height/app-shell/kb-open` 引用。
- iOS PWA 真机需复测：首页底部 Tab 贴底、Sessions 页不透明、刷新整页、表头圆点位置。
