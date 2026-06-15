# Spec — 回车行为：触屏=换行，桌面不变

日期: 2026-06-13

## 背景

`Composer.tsx` 的 `onKeyDown`：回车（非 Shift、非输入法 composing）即 `submit()` 发送，Shift+回车换行。该行为在触屏设备上不友好——移动端软键盘的回车通常期望换行，发送应走发送按钮。

## 目标

- **触屏设备**：回车 = 换行（默认行为），不触发发送；发送通过发送按钮。
- **桌面端**：保持现状——回车发送，Shift+回车换行，输入法 composing 中不发送。

## 设计要点

- 用 `window.matchMedia("(pointer: coarse)")` 判定触屏（coarse pointer）。
- `onKeyDown` 中若为触屏，直接 return（不 `preventDefault`，让回车走默认换行）；否则维持原逻辑。
- keydown 仅在客户端触发，无 SSR 顾虑；判定即时计算，兼容混合设备当下状态。

## 非目标

- 不改桌面端任何快捷键。
- 不新增"发送键可配置"等设置项。

## 验证

- 桌面：回车发送、Shift+回车换行不变。
- 触屏（移动端 / coarse pointer）：回车插入换行、不发送，点发送按钮才发送。
- typecheck + 现有测试通过。
