# Change Log: 回车行为——触屏=换行，桌面不变

- 日期: 2026-06-13
- 关联: docs/specs/2026-06-13-composer-enter-newline-on-touch-spec.md、
  docs/plans/2026-06-13-composer-enter-newline-on-touch-plan.md

## 改动文件

### web
- `components/Composer.tsx`：`onKeyDown` 开头用 `matchMedia("(pointer: coarse)")`
  判定触屏；触屏时直接 return，让回车走默认换行（发送靠发送按钮）。桌面端逻辑
  不变（回车发送、Shift+回车换行、输入法 composing 中不发送）。

## 核心变更

- 触屏：回车换行、不发送。
- 桌面：行为完全不变。

## 影响范围

- 仅 Composer 键盘事件，未触碰发送链路本身。

## 验证结果

- `pnpm typecheck`（web）通过。
- `pnpm test`（web）：18 项全绿。
