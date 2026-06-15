# Change Log: 消息复制 + 重新发送改为填入输入框

- 日期: 2026-06-13
- 关联: docs/specs/2026-06-13-message-copy-and-resend-to-input-spec.md、
  docs/plans/2026-06-13-message-copy-and-resend-to-input-plan.md

## 改动文件

### web
- `components/Composer.tsx`：
  - 新增 `prefill?: { text: string; nonce: number }` prop；
  - `useEffect` 监听 `prefill.nonce`，将外部文本写入输入框，并在下一帧
    （`requestAnimationFrame`）聚焦 textarea、把光标移到末尾；
  - 键盘模式与语音模式两处 textarea 都挂上 `textareaRef`。
- `components/Timeline.tsx`：
  - `onResend` 语义改为 `onFillInput`（填入输入框，不直接发送），逐层透传；
  - 新增可复用的 `CopyButton`（内部 `copied` 状态 + `copyText`，显示"已复制"反馈）；
  - 用户气泡：原"↻ 重新发送"改为"↥ 填入输入框"，并新增"复制"按钮（复制清洗后文本）；
  - 助手文本消息（`kind: "text"`）新增 hover 出现的"复制"按钮（复制原始 markdown 文本）。
- `app/page.tsx`：
  - 新增 `draft` 状态；`<Timeline onFillInput>` 用函数式更新 `setDraft((d) => ({ text, nonce: d.nonce + 1 }))`；
  - 给 `<Composer>` 传入 `prefill={draft}`。

## 核心变更

- 复制：用户气泡 + 助手文本消息均可一键复制（工具 IN/OUT 原有复制保持不变）。
- 重新发送 → 填入：点击后文本进入输入框并自动聚焦（光标在末尾），**不再直接发送**，
  用户可编辑后手动发送。

## 影响范围

- 仅前端交互，未触碰发送 / 接管 / 权限链路。
- thinking 块、工具行未新增复制（IN/OUT 已有）。

## 验证结果

- `pnpm typecheck`（web）通过。
- `pnpm test`（web）：18 项全绿，含 `Timeline.test.tsx`（未引用旧 `onResend`，无需改）。
