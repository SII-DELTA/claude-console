# Web 控制台

`apps/web`：Next.js 14 App Router + TypeScript + Tailwind 3 + Zustand 5。Claude Code 风格深色 UI，电脑/手机双适配 + PWA。

## 运行

```bash
pnpm --filter @mac/web dev      # http://localhost:3005
pnpm --filter @mac/web build && pnpm --filter @mac/web start
pnpm --filter @mac/web test     # 8 测试
```

## 结构

* `lib/api.ts` — `ApiClient`：`/claude/*`（list/detail/new/continue(force)/interrupt）、`pair`。`isLiveConflict()` 识别 409。
* `lib/store.ts` — Zustand：连接（localStorage 持久化）、会话列表、当前会话消息、流式 `stream` 缓冲、`driveStatus`；集成 `WsClient` 处理 `server:claude_*`。
* `lib/ws.ts` — WebSocket 客户端（`?token=`，断线回调）。
* `components/`
  * `ConnectForm` — 服务器地址 + 密码（`MAC_AGENT_PASSWORD` 登录）。
  * `SessionList` — 会话列表（`isLive` 角标、搜索、新会话）。
  * `MessageView` — 结构化消息块：text / thinking(折叠) / tool_use(可展开入参) / tool_result(可展开)。
  * `Composer` — 底部输入栏（Enter 发送、流式时显示中断）。
* `app/page.tsx` — 主控制台：桌面侧栏 + 移动抽屉；空态 / 消息流 / 流式气泡；live 会话接管确认弹窗。SSR 用 mount gate 避免 hydration 不一致。

## 交互要点

* 新会话：不选会话直接在 Composer 输入 → `POST /claude/sessions`；ClaudeStore 镜像新 jsonl，消息经 WS 流入。
* 续写：选中历史会话 → `continue`；若 `isLive` 弹确认，确认后带 `force`。
* 流式：驱动期间 `server:claude_delta` 进流式气泡；`drive_done` 后重拉详情取权威消息。

## PWA

`public/manifest.webmanifest` + `theme-color` + 安全区内边距。
手机浏览器（iOS Safari / Android Chrome）可「添加到主屏幕」当原生 App 用，无需安装包。

## 验证

Playwright 实测：连接/控制台桌面+移动截图、真实会话流式镜像、新会话驱动端到端（见 change log）。
