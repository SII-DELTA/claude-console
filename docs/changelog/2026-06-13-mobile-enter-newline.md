# Change Log: 移动端回车键改为换行

- 日期: 2026-06-13
- 关联: docs/specs/2026-06-13-mobile-enter-newline-spec.md、
  docs/plans/2026-06-13-mobile-enter-newline-plan.md

## 改动文件

### web
- `components/Composer.tsx`：`onKeyDown` 起始处内联判断
  `coarse = window.matchMedia("(pointer: coarse)").matches`，触屏设备直接 return，
  让回车键插入换行；桌面（fine pointer）维持 Enter 发送 / Shift+Enter 换行。

## 核心变更

- 触屏：回车换行，发送靠右侧发送按钮（配合多行自适应可正常多行输入）。
- 桌面：Enter 发送行为不变。
- 输入法组合中（isComposing）回车仍不发送。

## 影响范围

- 仅 Composer 键盘交互。

## 备注

- 代码改动已随 `3333c2f`（键盘底部空白修复）一并提交；本条 changelog 与 spec/plan 为补记，
  确保文档与已落地实现一致。
- 撤回了一处冗余的 `coarsePointer` useState（与内联实现重复，未使用）。

## 验证结果

- `pnpm typecheck`（web）通过；`pnpm test` 18 项全绿。
