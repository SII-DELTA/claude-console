# Plan — 消息复制 + 重新发送改为填入输入框

日期: 2026-06-13
对应 spec: `docs/specs/2026-06-13-message-copy-and-resend-to-input-spec.md`

## 改动文件

1. `apps/web/components/Composer.tsx`
   - 新增 `prefill?: { text: string; nonce: number }` prop。
   - `useEffect` 监听 `prefill?.nonce`：`setText(prefill.text)`，并聚焦 textarea、光标移到末尾。
   - 用 `textareaRef` 引用键盘模式与语音模式的 textarea（语音模式仅在有文本时渲染编辑框，聚焦尽力而为）。

2. `apps/web/components/Timeline.tsx`
   - `Timeline`/`Row`/`AssistantGroup` 透传一个 `onFillInput?: (text: string) => void`（替代原 `onResend` 语义）。
   - `UserBubble`：原「↻ 重新发送」按钮文案/图标改为「↥ 填入输入框」，点击调用 `onFillInput(clean)`，并新增「复制」按钮（复制 `clean`，显示「已复制」反馈）。
   - 助手文本消息（`Row` 的 `kind: "text"`）包一层 `group`，新增 hover 出现的「复制」按钮（复制原始 `item.text`）。
   - 抽一个小的 `CopyButton`（内部 `copied` 状态 + `copyText`）复用于两处。

3. `apps/web/app/page.tsx`
   - 新增 `draft` 状态：`const [draft, setDraft] = useState<{ text: string; nonce: number }>(...)`。
   - `<Timeline ... onFillInput={(t) => setDraft({ text: t, nonce: draft.nonce + 1 })} />`（用函数式更新避免闭包陈旧）。
   - `<Composer ... prefill={draft} />`。

## 实现顺序

1. Composer 加 `prefill` + textareaRef + 聚焦逻辑。
2. Timeline 加 `CopyButton`、改 onResend→onFillInput、助手文本复制。
3. page.tsx 接线 draft。
4. typecheck + 测试。

## 风险

- 语音模式下转写编辑框仅在 `text.trim()` 非空时渲染：填入非空文本后会渲染，聚焦在 `useEffect` 内于下一帧执行，需确保 ref 已挂载（必要时 `requestAnimationFrame`/微任务后聚焦）。
- `Timeline.test.tsx` 若断言了「重新发送」文案或 `onResend` prop，需同步更新。

## 验证

- `pnpm --filter web typecheck`（或仓库等价命令）。
- 运行 web 测试，确保 Timeline 相关用例通过。
- 手动：复制两类消息内容正确；填入按钮填入并聚焦、不自动发送。
