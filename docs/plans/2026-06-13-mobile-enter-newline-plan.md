# Plan — 移动端回车键改为换行

日期: 2026-06-13
对应 spec: `docs/specs/2026-06-13-mobile-enter-newline-spec.md`

## 改动文件

- `apps/web/components/Composer.tsx`
  - `onKeyDown` 起始处内联判断触屏：
    `const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;`
    `if (coarse) return;`，其后维持 Enter 发送逻辑。

> 注：该改动已由手工编辑落地，并随键盘空白修复一并提交于 `3333c2f`（本计划补记实现细节）。
> 实现采用 onKeyDown 内联 matchMedia（每次按键判断），未引入额外 state；与 spec 行为一致。

## 验证

- `pnpm typecheck`、`pnpm test`（web）。
- 手机回车换行 / 桌面 Enter 发送。
