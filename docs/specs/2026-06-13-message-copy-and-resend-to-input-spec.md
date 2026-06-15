# Spec — 消息复制 + 重新发送改为填入输入框

日期: 2026-06-13

## 背景

会话时间线（`Timeline.tsx`）当前的交互：

- 用户气泡有一个「↻ 重新发送」按钮，点击后直接调用 `onResend(clean)` → `page.tsx` 的 `handleSend(t)` **立即发送**，无法在发送前编辑。
- 助手的文本消息（`kind: "text"`）**没有复制按钮**；仅工具的 IN/OUT（`Pre` 组件）已有复制功能。
- `Composer` 的输入框文本是组件内部 `useState`，外部无法写入。

## 目标

### 1. 消息复制功能

- 覆盖范围：**用户消息气泡** 与 **助手文本消息**（`kind: "text"`）。
- 工具 IN/OUT（`Pre`）已有复制，保持不变；思考块（thinking）本次不加。
- 复制内容为该消息的纯文本（用户气泡复制 `cleanUserText` 清洗后的文本；助手文本复制原始 markdown 文本）。
- 复用 `lib/clipboard.ts` 的 `copyText`，复制成功后短暂显示「已复制」反馈。
- 复制按钮样式与现有 hover-only 风格一致（桌面端 hover 出现，移动端常驻淡显）。

### 2. 「重新发送」改为「填入输入框」

- 用户气泡上原「↻ 重新发送」按钮不再直接发送。
- 点击后：将该条文本**填入 Composer 输入框并聚焦**，光标定位到文本末尾，由用户编辑后手动发送。
- 按钮文案与图标相应调整（如「↥ 填入输入框」/「编辑后发送」），语义清晰。
- 若处于语音模式（voiceMode），填入后转写编辑框可见，行为一致。

## 设计要点

- `Composer` 输入框文本需支持外部写入。方案：在 `page.tsx` 维护一个 `draft` 状态，通过 `value` + `onChange` 的受控方式或一次性 `prefill` prop 传入。
  - 倾向：新增 `prefill`（`{ text: string; nonce: number }` 或带 key 的信号）prop，Composer 内 `useEffect` 监听 nonce 变化 → `setText(text)` 并 `focus()` + 光标到末尾。这样不破坏 Composer 现有内部状态管理，改动最小。
- `Timeline` 的 `onResend` 回调语义从「发送」改为「填入」，对应 `page.tsx` 改为写入 draft 而非 `handleSend`。可重命名为 `onFillInput` 以表意。

## 非目标

- 不改变实际发送链路（接管 / takeover / 权限等逻辑不动）。
- 不为 thinking 块、工具行新增复制（IN/OUT 已有）。
- 不引入第三方复制库。

## 验证

- 用户气泡与助手文本消息均出现复制按钮，点击后剪贴板内容正确，并显示「已复制」反馈（HTTPS 与 plain-http 远程均可，依赖现有 `copyText` fallback）。
- 点击用户气泡的「填入输入框」按钮：文本进入输入框、自动聚焦、光标在末尾、**不自动发送**；编辑后可正常手动发送。
- typecheck 与现有测试（含 `Timeline.test.tsx`）通过。
