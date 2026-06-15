# Plan — 移动端键盘弹起时输入框下方空白

日期: 2026-06-13
对应 spec: `docs/specs/2026-06-13-keyboard-bottom-gap-spec.md`

## 改动文件

- `apps/web/app/page.tsx`
  - 在 `setH()`（visualViewport 监听）里计算 `kbOpen = vv ? (window.innerHeight - vv.height > 120) : false`，
    `document.documentElement.classList.toggle("kb-open", kbOpen)`；
  - cleanup 时移除 `kb-open` class。
- `apps/web/app/globals.css`
  - 新增 `.kb-open .pb-safe { padding-bottom: 0.5rem; }`。

## 验证

- `pnpm typecheck`、`pnpm test`（web）。
- 手机实测：键盘弹起底部贴合、收起恢复安全区。
