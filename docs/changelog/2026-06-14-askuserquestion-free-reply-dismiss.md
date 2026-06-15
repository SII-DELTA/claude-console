# Change Log — AskUserQuestion 自由回复后选择器不消失（方案 B）

日期: 2026-06-14
关联: docs/specs/2026-06-14-askuserquestion-free-reply-dismiss-spec.md, docs/plans/2026-06-14-askuserquestion-free-reply-dismiss-plan.md

## 改动文件

- `apps/web/app/page.tsx`
- `apps/web/lib/store.ts`

## 核心变更

- **修复方案 B 选择器在自由回复后不消失**：`handleSend` 在 `bPermission`（存在 live 控制请求的
  AskUserQuestion）激活且文本非空时，把自由文本作为该题答案，映射为 `answers`（`multiSelect`
  题用 `[text]`，单选用 `text`），改走现有 `answerPermission(answers)`，而非 `sendPrompt`。
  - 复用既有通道：driver 回 `allow+answers` → CLI 解除阻塞、同回合续写 → 发 `claude:permission_cancel`
    → 前端 `pendingPermission` 置空、选择器消失。**未改动 agent / 控制协议。**
  - 之前自由回复走 `sendPrompt`：只写了新 user turn，既没回应待决 control_request，也没清
    `pendingPermission`，导致选择器停留且 CLI 仍阻塞。
- **附带修复测试回归**：`loadPermissionMode()` 的 `window.localStorage.getItem` 增加 try/catch
  兜底。jsdom（node 25 下 `--localstorage-file` 无效路径）会让 `localStorage.getItem` 不可用，
  上一提交给 `Timeline.tsx` 引入 store 依赖后触发 `Timeline.test.tsx` 收集失败；兜底后恢复，
  同时对 SSR/无存储环境更健壮。

## 影响范围

- 仅影响方案 B（`bPermission`）下的自由回复；方案 A 兜底（`pendingQuestions`）与「提交选择」路径不变。
- 自由回复路径忽略附带图片（选择题答案不承载图片）。
- `loadPermissionMode` 仅在 localStorage 不可用时回退默认，正常浏览器行为不变。

## 验证

- `pnpm -C apps/web typecheck` 通过。
- `pnpm -C apps/web test` 全部通过（18/18，含此前失败的 Timeline 套件）。
- 预期手动：方案 B 选择器 → 输入框自由回复 → 选择器消失 + 同回合续写 + 模型收到该文本作为答案。
