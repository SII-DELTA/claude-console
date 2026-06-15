# Spec — 语音转写失败要有提示（并清理同类静默失败）

日期: 2026-06-14

## 背景

语音输入转写失败时，用户没有任何反馈：转写转圈结束后输入框毫无变化，也不报错。

根因在 `apps/web/components/Composer.tsx` 的 `stopAndTranscribe()`：

- `catch {}` 空捕获——网络超时、后端 `502 asr_failed`、`503 asr_not_configured`（未配置腾讯云密钥）等任何异常都被吞掉。
- `if (t)` 空结果忽略——后端识别为空（静音/没说话/噪音）时返回 `{ text: "" }`，前端直接跳过，同样无提示。

后端 `http-server.ts` 的 `/asr` 其实已返回结构化错误 `{ error, message }`（如"未配置 VOICE_SECRET_ID / VOICE_SECRET_KEY"），前端没有读取展示。

项目里已有一个**可手动点击关闭的全局错误提示组件** `Toast`（`app/page.tsx`），由 store 的 `error: string | null` 状态驱动，`clearError()` 关闭。网络类错误已在复用它。本次要把语音转写失败也接入同一机制，并顺带清理其他同类被静默吞掉的用户可感知错误。

## 目标

- 语音转写**抛错**时，复用全局 `Toast` 展示可读错误（带后端 message），用户可点击关闭。
- 语音转写**返回空结果**时，提示"未识别到语音，请重试"。
- 排查并修复其他同类"用户主动操作失败却无提示"的静默路径。

## 范围内的同类静默失败

- **复制按钮**（`Markdown.tsx` 代码块复制、`Timeline.tsx` 的 `CopyButton`）：`copyText` 返回 `false` 时只是不显示"已复制"，无失败提示。改为失败时弹 Toast。

## 非目标（保持静默，确有合理理由）

- 后台轮询 / 校验类静默 catch（`useUsage.ts`、`UsageDisplay.tsx`、`store.ts` 的 `loadProjects` / `revalidateTail` / 历史回填）——失败仅退回缓存或可选 UI，不该打扰用户。
- JSON 解析回退、`recorder` 关闭清理、通知降级等纯内部容错。
- `interrupt()` 失败——本地乐观置 idle 是预期行为，不在本次扩大范围。
- 麦克风权限 / 非安全上下文已有 `voiceHint` 行提示，保持不变。

## 设计要点

- store 新增公共 action `setError(msg: string)`，并导出 `describeError` 供组件复用（统一提取 `ApiError.body.message`）。
- `Composer.stopAndTranscribe()`：
  - `catch (e)` → `setError(\`语音转写失败：${describeError(e)}\`)`。
  - 空结果 → `setError("未识别到语音，请重试")`。
- 复制失败 → `setError("复制失败，请手动选择文本复制")`。

## 验证

- 未配置密钥 / 后端 502 / 断网超时：转写结束后出现可关闭的红色 Toast，文案含原因。
- 录到静音：提示"未识别到语音，请重试"。
- 复制成功仍显示"已复制"；复制失败弹 Toast。
- typecheck 通过。
