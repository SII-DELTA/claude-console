# Plan — 语音转写失败要有提示（并清理同类静默失败）

日期: 2026-06-14
关联 spec: docs/specs/2026-06-14-voice-asr-error-feedback-spec.md

## 改动清单

### 1. `apps/web/lib/store.ts`
- `AppState` 接口新增 `setError: (msg: string) => void;`（紧邻 `clearError`）。
- 实现 `setError(msg) { set({ error: msg }); }`。
- 将 `describeError` 改为 `export function`，供组件复用。

### 2. `apps/web/components/Composer.tsx`
- 从 store 取 `setError`：`const setError = useAppStore((s) => s.setError);`
- 引入 `import { describeError } from "../lib/store";`（或在 store 统一导出处）。
- `stopAndTranscribe()`：
  - 成功且 `t` 非空 → 原样插入。
  - 成功但 `t` 为空 → `setError("未识别到语音，请重试")`。
  - `catch (e)` → `setError(\`语音转写失败：${describeError(e)}\`)`。

### 3. `apps/web/components/Markdown.tsx`
- `CodeBlock.copy()`：`copyText` 返回 `false` 时 `setError("复制失败，请手动选择文本复制")`（接入 `useAppStore`）。

### 4. `apps/web/components/Timeline.tsx`
- `CopyButton.copy()` 同上处理失败分支。

## 复用点

- 全局 `Toast`（`app/page.tsx:359`）已根据 `error` 渲染并支持点击 `clearError` 关闭，无需新增 UI。

## 验证

- `pnpm -C apps/web typecheck`（或仓库根 typecheck 脚本）。
- 手动：未配置密钥时录音 → 出现可关闭 Toast；静音 → "未识别到语音"；复制失败 → Toast。
