# Plan — 回车行为：触屏=换行，桌面不变

日期: 2026-06-13
对应 spec: `docs/specs/2026-06-13-composer-enter-newline-on-touch-spec.md`

## 改动文件

- `apps/web/components/Composer.tsx`
  - `onKeyDown` 开头加触屏判定：
    `const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;`
    若 `coarse` 为真则 `return`（让回车走默认换行）；其余逻辑不变。

## 验证

- `pnpm typecheck`（web）。
- `pnpm test`（web）。
- 手动：桌面回车发送 / 触屏回车换行。
