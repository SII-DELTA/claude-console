# Plan — 输入框多行自适应高度

日期: 2026-06-13
对应 spec: `docs/specs/2026-06-13-composer-autogrow-textarea-spec.md`

## 改动文件

- `apps/web/components/Composer.tsx`
  - 新增 `useEffect(() => { resize(); }, [text])`，`resize()` 对 `textareaRef.current` 执行
    `height = "auto"` → `height = scrollHeight + "px"`。
  - `onChange` 仍走 `setText`，由上面的 effect 统一触发高度调整（无需在 onChange 内手动 resize）。
  - 两处 textarea（键盘模式 / 语音模式转写框）已共用 `textareaRef`，保留各自的
    `max-h-*` 与 `minHeight`，由 CSS 约束上下限。

## 验证

- `pnpm typecheck`（web）。
- `pnpm test`（web）。
- 手动：多行增高 / 上限滚动 / 发送后回落 / prefill 适配。
