# 会话详情页边缘滑动返回手势

- 日期：2026-06-16
- Spec：[docs/specs/2026-06-16-session-swipe-back-spec.md](../specs/2026-06-16-session-swipe-back-spec.md)

## 核心变更

- 新增 `apps/web/lib/useEdgeSwipeBack.ts`：移动端边缘滑动返回手势 Hook。
  - 仅当 `touchstart` 落在屏幕左/右边缘 24px 内才进入候选。
  - 左右任一水平方向，位移超过 60px 松手触发：页面按方向滑出屏幕（220ms 动画），动画结束后才真正返回；未达阈值回弹。
  - 轴锁定：垂直位移为主时取消手势，交还原生滚动（避免与代码块横向滚动、消息垂直滚动冲突）。
  - 跟手位移限幅 ±120px。
- 修改 `apps/web/app/page.tsx`：
  - 详情页 `<main>` 挂载手势 `ref`，按 `dx` 应用 `translateX`（跟手）与 `transition`（回弹）。
  - 启用条件为 `mobileDetail`，返回回调复用既有 `goBack()`。

## 影响范围

- 仅移动端会话详情页新增手势，桌面端无变化。
- 不引入任何第三方手势库，沿用原生 Touch Events。

## 验证

- `apps/web` 类型检查：本功能涉及文件（`page.tsx`、`useEdgeSwipeBack.ts`）零报错。
  - 注：工作区中 `Dashboard.tsx` 存在并发未完成改动导致的 `onIgnore` 报错，与本功能无关，未纳入本次提交。
- 待手动验证：移动端左/右边缘滑动跟手位移、超阈值返回、未达阈值回弹、代码块/列表滚动不误触。
