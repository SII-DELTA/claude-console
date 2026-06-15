# Spec — 移动端键盘弹起时输入框下方空白

日期: 2026-06-13

## 背景

移动端（iOS）键盘弹起后，输入框（Composer）与键盘之间出现一段空白。视口高度已用 `visualViewport` 适配（`page.tsx` 的 `--app-height` / `--vv-offset`），但 Composer 最外层 `pb-safe` 始终保留 `env(safe-area-inset-bottom)`（home indicator 安全区，约 34px）。键盘弹起时 home indicator 已隐藏，这段底部 padding 不再需要，却仍占位 → 表现为底部空白。

## 目标

- 键盘弹起时，去掉 Composer 的安全区底部 padding（回落到一个最小内边距），让输入框紧贴键盘上沿。
- 键盘收起时，恢复 `env(safe-area-inset-bottom)` 安全区 padding（保护 home indicator 区域）。
- 桌面端不受影响。

## 设计要点

- 在已有的 `visualViewport` resize 监听里判断键盘是否弹起：
  `keyboardOpen = (window.innerHeight - visualViewport.height) > 120`（阈值区分键盘与地址栏收缩）。
- 键盘弹起时给根元素加 class `kb-open`；CSS 中 `.kb-open .pb-safe` 把 `padding-bottom` 降为最小值（如 `0.5rem`）。

## 非目标

- 不改视口高度（`--app-height`）与 `translateY(--vv-offset)` 逻辑。
- 不改回车发送 / 多行自适应逻辑（另议）。

## 验证

- 手机键盘弹起：输入框紧贴键盘，底部不再有空白。
- 键盘收起：底部安全区 padding 恢复。
- 桌面端布局无变化；typecheck + 测试通过。
