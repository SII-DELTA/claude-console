# Plan — AskUserQuestion 自由回复后选择器不消失（方案 B）

日期: 2026-06-14
关联 spec: docs/specs/2026-06-14-askuserquestion-free-reply-dismiss-spec.md

## 改动清单

### `apps/web/app/page.tsx` — `handleSend`
当前：
```ts
function handleSend(text, images) {
  void sendPrompt(text, { force: externalLive || undefined, images });
  setDrawerOpen(false);
}
```
改为：方案 B 待决时，自由文本作为答案走 `answerPermission`，否则维持原 `sendPrompt`。
```ts
function handleSend(text, images) {
  // 方案 B：选择器待决时，自由回复 = 该题答案（同回合续写），复用 answerPermission
  if (bPermission && text.trim()) {
    const answers: Record<string, string | string[]> = {};
    for (const q of bPermission.questions) {
      answers[q.question] = q.multiSelect ? [text] : text;
    }
    void answerPermission(answers);
    setDrawerOpen(false);
    return;
  }
  void sendPrompt(text, { force: externalLive || undefined, images });
  setDrawerOpen(false);
}
```

## 复用点

- `answerPermission`（store）→ `POST /claude/sessions/:id/answer-permission` → driver `answerPermission`
  回 allow+answers、发 `claude:permission_cancel`（前端 `pendingPermission` 置空、选择器消失）、同回合续写。

## 不改动

- agent / 控制协议 / driver。
- 方案 A 的 `pendingQuestions` 自由回复路径。
- 「提交选择」按钮路径。

## 验证

- `pnpm -C apps/web typecheck`。
- 手动：方案 B 选择器 → 输入框自由回复 → 选择器消失 + 续写；选项点击与方案 A 不回归。
