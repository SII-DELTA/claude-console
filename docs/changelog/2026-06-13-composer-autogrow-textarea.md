# Change Log: 输入框多行自适应高度（类微信）

- 日期: 2026-06-13
- 关联: docs/specs/2026-06-13-composer-autogrow-textarea-spec.md、
  docs/plans/2026-06-13-composer-autogrow-textarea-plan.md

## 改动文件

### web
- `components/Composer.tsx`：新增依赖 `[text, voiceMode]` 的 `useEffect`，对
  `textareaRef.current` 执行 `height = "auto"` → `height = scrollHeight`，实现
  textarea 随内容自适应增高。沿用现有 `max-h-40`/`max-h-32` 作上限、`minHeight`
  作下限，超过上限后内部滚动。键盘模式与语音模式转写框共用同一 ref，行为一致。

## 核心变更

- 默认单行高度不变；多行输入时输入框平滑增高，到上限后内部滚动。
- 发送 / 清空文本后高度回落到默认单行；`prefill` 填入后高度同步适配（由 text effect 触发）。
- effect 依赖含 `voiceMode`，切换输入模式后新挂载的 textarea 也会按当前内容重算高度。

## 影响范围

- 仅 Composer 视觉/布局，未触碰发送、录音、图片等逻辑。

## 验证结果

- `pnpm typecheck`（web）通过。
- `pnpm test`（web）：18 项全绿。
