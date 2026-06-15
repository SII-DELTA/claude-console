# Spec — 移动端回车键改为换行（桌面保持 Enter 发送）

日期: 2026-06-13

## 背景

`Composer.tsx` 的 `onKeyDown`：Enter（无 Shift、非输入法组合中）→ `submit()` 发送，Shift+Enter 换行。
桌面合理，但手机软键盘的「换行」键发出的就是 Enter，且无 Shift 组合，导致换行键永远在发送，
与刚加的多行自适应高度冲突（手机无法输入多行）。

## 目标

- **触屏设备**（coarse pointer）：回车键插入换行（textarea 默认行为），发送靠右侧发送按钮。
- **桌面**（fine pointer）：保持 Enter 发送 / Shift+Enter 换行。
- 输入法组合中（isComposing）的回车一律不触发发送（已有逻辑保留）。

## 设计要点

- 挂载时用 `window.matchMedia("(pointer: coarse)").matches` 判断是否触屏，存入状态 `coarsePointer`。
- `onKeyDown`：若 `coarsePointer` 直接 return（不拦截，回车自然换行）；否则维持原 Enter 发送逻辑。

## 非目标

- 不改发送按钮、不改语音/图片逻辑。
- 不做 UA 嗅探（仅用 pointer 媒体查询）。

## 验证

- 手机：回车换行、点发送按钮才发送。
- 桌面：Enter 发送、Shift+Enter 换行不变。
- typecheck + 测试通过。
