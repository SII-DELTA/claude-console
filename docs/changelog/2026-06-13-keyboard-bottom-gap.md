# Change Log: 修复移动端键盘弹起时输入框下方空白

- 日期: 2026-06-13
- 关联: docs/specs/2026-06-13-keyboard-bottom-gap-spec.md、
  docs/plans/2026-06-13-keyboard-bottom-gap-plan.md

## 改动文件

### web
- `app/page.tsx`：在 `visualViewport` 监听的 `setH()` 中计算
  `kbOpen = window.innerHeight - vv.height > 120`，并 `documentElement.classList.toggle("kb-open", kbOpen)`；
  cleanup 时移除 `kb-open`。
- `app/globals.css`：新增 `.kb-open .pb-safe { padding-bottom: 0.5rem; }`。

## 核心变更

- 键盘弹起时（home indicator 已隐藏）去掉 Composer 的 `env(safe-area-inset-bottom)` 底部 padding，
  输入框紧贴键盘上沿，消除底部空白；键盘收起恢复安全区 padding。

## 影响范围

- 仅移动端键盘场景的底部留白；桌面端无 `kb-open`，行为不变。

## 验证结果

- `pnpm typecheck`（web）通过；`pnpm test` 18 项全绿。
- 视觉效果需真机键盘弹起确认（开发机无法模拟软键盘）。
