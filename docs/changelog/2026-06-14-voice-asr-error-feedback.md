# Change Log — 语音转写失败要有提示（并清理同类静默失败）

日期: 2026-06-14
关联: docs/specs/2026-06-14-voice-asr-error-feedback-spec.md, docs/plans/2026-06-14-voice-asr-error-feedback-plan.md

## 改动文件

- `apps/web/lib/store.ts`
- `apps/web/components/Composer.tsx`
- `apps/web/components/Markdown.tsx`
- `apps/web/components/Timeline.tsx`

## 核心变更

- **修复语音转写静默失败**：`Composer.stopAndTranscribe()` 原本 `catch {}` 吞掉所有异常、`if (t)` 忽略空结果，导致转写失败无任何提示。
  - 抛错 → `setError(\`语音转写失败：${describeError(e)}\`)`，带后端可读原因（如"未配置 VOICE_SECRET_ID / VOICE_SECRET_KEY"）。
  - 空结果 → `setError("未识别到语音，请重试")`。
- **复用已有的可关闭全局 Toast**：store 新增公共 action `setError(msg)`（驱动 `app/page.tsx` 的 `Toast`，用户可点击关闭）；`describeError` 改为导出以统一提取 `ApiError` 后端 message。
- **清理同类静默失败**：复制按钮（`Markdown.tsx` 代码块、`Timeline.tsx` 的 `CopyButton` 与 `Pre`）在 `copyText` 返回 `false` 时改为弹 Toast「复制失败，请手动选择文本复制」，不再只是无声地不显示「已复制」。

## 影响范围

- 仅 web 前端；不改后端 `/asr` 接口与协议。
- 不影响成功路径：转写成功仍插入文本，复制成功仍显示「已复制」。
- 后台轮询 / 缓存校验 / 解析回退等合理静默路径保持不变（见 spec 非目标）。

## 验证

- `pnpm -C apps/web typecheck` 通过。
- 预期手动验证：未配置密钥 / 后端 502 / 断网超时 → 出现可关闭红色 Toast 且含原因；录到静音 → 「未识别到语音，请重试」；复制失败 → Toast。
