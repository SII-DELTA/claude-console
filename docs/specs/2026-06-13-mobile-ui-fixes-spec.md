# Spec — 移动端 UI 修复（额度行 / placeholder / 图片预览 / 选项卡）

日期: 2026-06-13

## 背景

移动端（iOS PWA）反馈一组体验问题，集中在底部输入区与图片、选项卡渲染。

## 问题与目标

### 1. 底部额度行多余
- 现象：输入框下方常驻「5 小时额度 · N 后重置」一行（`page.tsx` 的 `RateLimitLine`）。
- 目标：移除该常驻行（顶部已有 `UsageDisplay` 展示额度）。

### 2. placeholder 过长换行
- 现象：`page.tsx:344` 的几个 placeholder 文案过长，移动端窄输入框里折成两行。
- 目标：每个文案压到 ~5–6 个汉字，单行显示，语义不丢。

### 3. 添加后的图片缩略图不能预览
- 现象：`Composer.tsx:193` 的缩略图是纯 `<img>`，点击无反应。
- 目标：点击缩略图全屏放大预览，再点关闭。

### 4. 已发送图片变成 `🖼️×N` 图标，无法预览
- 根因：`store.ts` 的 `optimisticUserMessage` 把图片渲染成 emoji 文本；且服务端 `claude-jsonl.ts` 的 `mapBlocks` **根本不解析 image block**，历史里图片被丢弃。
- 方案（全链路持久化）：
  - 共享 schema 增加 `image` 块：`{ kind:"image", mediaType, dataBase64 }`。
  - `claude-jsonl.ts` 解析 Claude 的 `{type:"image", source:{type:"base64", media_type, data}}`。
  - 乐观消息携带真实 image 块（不再用 emoji）。
  - Timeline 用户气泡渲染图片缩略图，点击全屏预览。
- 目标：发送当下与刷新/重载历史后都能看到真实图片并可放大。

### 5. 选项卡（AskUserQuestion）渲染问题
- **重复两遍（确诊）**：`AskUserQuestion` 的 `tool_use` 在 `Timeline.buildTimeline` 被当普通工具行渲染一次，`page.tsx` 又用 `QuestionPanel` 渲染选项卡一次 → 同一问题出现两遍。修法：buildTimeline 跳过 `AskUserQuestion` 工具行。
- **没通知/没弹窗**：`notify()` 系统通知要求 HTTPS（secure context）+ 已授权；标题闪烁仅在标签页隐藏时。http 远程 PWA 两者皆不满足。
  - 纯前端可做：问题出现时把 `QuestionPanel` 自动滚动进视野并短暂高亮，作为「弹出」替代。
  - 系统级推送受浏览器安全限制，需 HTTPS 方案，超出本次纯前端范围（单列说明）。

## 非目标

- 不引入服务端推送 / Web Push（需 HTTPS 与订阅链路，另议）。
- 不改图片在 jsonl 的存储格式（仅补解析）。

## 验证

- 底部不再有额度行；placeholder 单行。
- 选图后点缩略图可全屏预览；移除按钮仍可用。
- 发送图片后气泡显示真实图片并可放大；刷新/重载历史后仍在。
- AskUserQuestion 只渲染一次（选项卡），不再有重复工具行。
- typecheck + 现有测试通过。
