# Change Log: 移动端 UI 修复（额度行 / placeholder / 图片预览 / 选项卡）

**Date:** 2026-06-13

## 概述

修复移动端（iOS PWA）一组体验问题：移除底部常驻额度行、压短输入框 placeholder、图片可全屏预览（含已发送与历史图片的全链路持久化）、修复 AskUserQuestion 选项卡重复渲染。

## 改动文件

### 共享层
- **`packages/shared/src/schemas.ts`**
  - `ClaudeMessageBlockSchema` 新增 `image` 块：`{ kind:"image", mediaType, dataBase64 }`。
  - 重新 `npm run build` 生成 dist（web 消费 dist 类型/实现）。

### 服务端 (local-agent)
- **`packages/local-agent/src/util/claude-jsonl.ts`**
  - `RawContentBlock` 增加 `source` 字段。
  - `mapBlocks` 新增 `case "image"`：解析 Claude 的 `{type:"image", source:{type:"base64", media_type, data}}`，此前 image 块被直接丢弃（历史无法回显图片的根因）。

### 前端 (web)
- **`apps/web/components/ImageThumb.tsx`** (NEW)
  - 缩略图点击打开全屏 lightbox（点击 / Esc 关闭）。Composer 预览与 Timeline 历史图片复用。
- **`apps/web/lib/store.ts`**
  - `optimisticUserMessage` 改为携带真实 image 块（不再用 `🖼️×N` emoji 文本）；导入 `ClaudeMessageBlock`。
- **`apps/web/components/Composer.tsx`**
  - 选图预览 `<img>` 换成 `<ImageThumb>`，可点开放大。
- **`apps/web/components/Timeline.tsx`**
  - user Item 增加 `images?: string[]`；buildTimeline 收集用户消息的 image 块转 data URL；UserBubble 渲染缩略图。
  - **跳过 `AskUserQuestion` 的 tool_use 行**（由 QuestionPanel 渲染，修复「问题重复两遍」）。
- **`apps/web/app/page.tsx`**
  - 删除底部常驻额度行（`RateLimitLine`）及 `RateLimitLine`/`countdown` helper 与 `rateLimit` 解构。
  - placeholder 压短为单行：运行中·先接管… / 接管并续写… / 续写会话… / 开启新会话…
  - 顺带修复另一处遗留的 JSX 未闭合（项目下拉 `absolute` 容器缺一个 `</div>`，导致全文件 parse 失败）。
- **`apps/web/components/QuestionPanel.tsx`**
  - 选项卡出现时 `scrollIntoView` + 1.8s 高亮，作为 http 下系统弹窗的页内替代。

## 核心变更

- 图片走「全链路持久化」：schema → jsonl 解析 → 乐观消息 → Timeline 渲染，发送当下与刷新/重载历史后都能看到真实图片并可放大。
- AskUserQuestion 不再既渲染工具行又渲染选项卡。

## 影响范围

- 历史会话切片现在会带上图片 base64，payload 体积随图片增大（与 jsonl 已存内容一致，仅此前被丢弃）。
- 无破坏性接口变更；driver 等内部调用不受影响。

## 已知限制

- 系统级通知/推送要求 HTTPS（secure context）+ 用户授权。当前 http 远程 PWA 下系统通知/标题闪烁（仅后台标签）均不触发；本次以页内滚动+高亮替代，真正的推送需 HTTPS 方案另议。

## 验证结果

- `tsc -p apps/web/tsconfig.json --noEmit`：通过。
- shared 测试：15 passed；local-agent 测试：68 passed。
- 注：`claude-store.test.ts` 的 `tsc` 严格性报错为此前另一改动遗留，与本次无关，运行时测试全绿。
