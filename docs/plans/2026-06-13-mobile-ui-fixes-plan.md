# Plan — 移动端 UI 修复实现

日期: 2026-06-13
对应 spec: 2026-06-13-mobile-ui-fixes-spec.md

## 1. 共享 schema `packages/shared/src/schemas.ts`

`ClaudeMessageBlockSchema` 判别联合新增：
`z.object({ kind: z.literal("image"), mediaType: z.string(), dataBase64: z.string() })`
改后需 `npm run build`（web 消费 dist）。

## 2. jsonl 解析 `packages/local-agent/src/util/claude-jsonl.ts`

- `RawContentBlock` 增加 `source?: { type?; media_type?; data? }`。
- `mapBlocks` 增加 `case "image"`：当 `source.type==="base64"` 且有 `data` 时，push image 块（`media_type` 缺省 `image/png`）。

## 3. 已发送图片乐观消息 `apps/web/lib/store.ts`

`optimisticUserMessage(prompt, sessionId, images?)`：不再用 `🖼️×N` 文本，改为先 push 每张图的 image 块，再 push text 块。

## 4. 可放大缩略图 `apps/web/components/ImageThumb.tsx`（NEW）

点击全屏 lightbox（Esc / 点击关闭）。Composer 预览与 Timeline 用户图片复用。

## 5. Composer `apps/web/components/Composer.tsx`

选图预览的 `<img>` 换成 `<ImageThumb>`。

## 6. Timeline `apps/web/components/Timeline.tsx`

- user Item 增加 `images?: string[]`（data URL）。
- buildTimeline 用户分支收集 image 块 → data URL；有文字或图片即生成气泡。
- **跳过 `AskUserQuestion` 的 tool_use**（它由 QuestionPanel 渲染，避免重复两遍）。
- UserBubble 渲染图片缩略图（ImageThumb）。

## 7. page.tsx `apps/web/app/page.tsx`

- 删除底部 `RateLimitLine` 常驻行及其 helper（`RateLimitLine`/`countdown`）与 `rateLimit` 解构。
- placeholder 文案压短：运行中·先接管… / 接管并续写… / 续写会话… / 开启新会话…

## 8. QuestionPanel `apps/web/components/QuestionPanel.tsx`

出现时 `scrollIntoView` + 短暂高亮（http 下系统弹窗不可用的替代）。

## 说明（超出本次范围）

系统级通知/推送要求 HTTPS（secure context）+ 授权，http 远程 PWA 无法实现，另议。

## 验证

- web typecheck 通过；shared/local-agent 测试通过（68+15）。
- 选图点缩略图全屏预览；发送后气泡显示真实图片并可放大；刷新历史后仍在。
- AskUserQuestion 只渲染选项卡一次；底部无额度行；placeholder 单行。
