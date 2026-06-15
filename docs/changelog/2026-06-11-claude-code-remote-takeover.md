# Change Log — Claude Code 远程接管重构

- 日期：2026-06-11
- spec：[../specs/2026-06-11-claude-code-remote-takeover-spec.md](../specs/2026-06-11-claude-code-remote-takeover-spec.md)
- plan：[../plans/2026-06-11-claude-code-remote-takeover-plan.md](../plans/2026-06-11-claude-code-remote-takeover-plan.md)

## 核心变更

把整套「Copilot 磁盘镜像 + 续话 + lm-stream」替换为「Claude Code 磁盘镜像 + resume/新开驱动」，
并把客户端从 Flutter iOS 改为 Web(PWA) + Capacitor Android APK，删除 VS Code 插件、改 launchd 常驻。

## 改动文件（按 Phase）

- **shared**：`schemas.ts`（会话类型 codex/copilot→claude；删 Copilot/LmStream 实体；加 `ClaudeSession`(isLive)/`ClaudeMessage`(blocks)/`ClaudeDriveStatus` + `/claude` REST body + `server:claude_*` WS）、`constants.ts`(`LIVE_WINDOW_MS`)。
- **local-agent**：新增 `claude-store.ts`、`claude-driver.ts`、`util/claude-jsonl.ts`、`util/claude-stream.ts`；改 `bus.ts`/`ws-bridge.ts`/`http-server.ts`/`runtime.ts`/`cli.ts`/`session-manager.ts`；**删** `copilot-store.ts`、`lm-stream-manager.ts`。监听默认 `127.0.0.1`，`MAC_AGENT_BIND` 放行 Tailscale。
- **删插件**：删 `packages/vscode-extension`；加 `scripts/install-daemon.sh`、`uninstall-daemon.sh`；清 `.vscode/launch.json`、`tasks.json`。
- **web**：重写 `lib/api.ts`/`lib/store.ts`，新增 `components/{MessageView,SessionList,Composer,ConnectForm}.tsx`，重写 `app/page.tsx`/`layout.tsx`/`globals.css`/`tailwind.config.ts`；删 copilot/sessions/settings 页与旧组件；加 `public/manifest.webmanifest`。
- **shell**：新增 `apps/shell`（Capacitor：`capacitor.config.ts`/`www`/`README`）+ `scripts/build-apk.sh`。
- **文档**：README、`docs/architecture.md`、`local-agent.md`、`web.md` 重写；新增 `docs/remote-access.md`；`mobile.md`/`vscode-extension.md` 标记移除。

## 影响范围

- 后端：会话来源从 VS Code 工作区存储 → `~/.claude/projects`；驱动从「注入 Copilot」→ `claude -p`。REST `/copilot/*`+`/stream/*` → `/claude/*`。
- 客户端：Flutter iOS 端移除；改 Web + Android APK。
- 部署：不再需要 VS Code；agent 以 launchd 守护进程常驻；公网经服务器反代 + Tailscale。
- 安全：默认仅绑回环；token 经公网时本期明文（TLS 后置）。

## 验证结果

- 单测：shared 15 + local-agent 55 + web 8 = **78 全绿**（`pnpm test`）。
- 构建：shared/local-agent `tsc` 干净；web `next build` 成功；web `tsc --noEmit` 干净。
- 后端端到端（curl，真实 `~/.claude/projects`）：列出真实会话(LIVE)、详情结构化消息、live 续写 409、force 越过。
- 前端端到端（Playwright，真实 agent + web）：
  - 连接页 / 控制台 桌面(1280) + 移动(390) 截图正常、无 hydration 错误。
  - 实时镜像正在跑的会话（结构化 text/thinking/tool_use/tool_result 块）。
  - 从 Web 新开会话并驱动，流式回出 “PONG”，新会话自动入列。
- APK：脚手架 + `build-apk.sh` 语法/配置校验通过；**本机无 JDK/Android SDK，未产出 .apk**（需在装好 Android 工具链的机器上执行）。

## 已知边界 / 后续

- live 检测为 mtime 提示（15s 窗口），最终安全靠 `force` 确认；headless 权限默认 `acceptEdits`（手机审批列后续）。
- 飞书集成、公网 TLS、iOS 端均列入后续。

## 2026-06-12 增量（体验与稳定性）

### 流式与性能
- **真流式**：driver 加 `--include-partial-messages`，解析 `stream_event` 逐字增量（text/thinking）；之前缺该 flag → 整块憋出。
- **暖进程**：每会话一个常驻 `claude --input-format stream-json` 进程，后续轮走 stdin 复用热缓存（实测冷 6.5s → 热 1.8s），空闲 5min 回收；竞态加固（idle-reap 回退冷续）。

### 前端功能
- **Markdown 渲染**（react-markdown + remark-gfm，暗色主题，代码/表格/列表/链接）；流式中用纯文本、落库后渲染 markdown（避免逐 token 重解析）。
- **语音输入**（Web Speech API，安全上下文限定，interim 实时显示）。
- **AskUserQuestion 选择面板**（单选/多选卡片，点击提交回填为下一轮 prompt）。
- **项目切换**：`/claude/projects` 列出 `~/.claude/projects` 全部项目，下拉切换。
- **drivenByAgent 区分**：live 会话区分「本端运行中」vs「终端运行中」；外部 live 会话锁定输入框，需显式「接管它」(force)。
- **紧凑 UI**：仿 Claude Code 左对齐时间线，工具 IN/OUT 块，去大边距大气泡；SVG 麦克风/发送/中断图标。
- **WS 自动重连**（3s 退避）。

### 状态机修复
- 乐观用户气泡（发送即显示，不再「吞消息」）；新会话流以 null sessionId 起步、首个 delta 认领 id；streaming 退出三重兜底（assistant 落库 / drive_done / drive_error），修复「卡启动中」。

### UI 打磨（Playwright 截图驱动）
- 装 Playwright，脚本自动配对 → 加载真实会话 → 截桌面/手机图，**对着截图调**：
  - 正文 15px/leading-7 白字（原 14px 偏灰），层次清晰；
  - 工具调用 = 可扫读 mono 动作日志（折叠 + ✓/✗，展开出 IN/OUT 等宽块）；
  - 用户消息剥离 `/slash` 命令 XML 与 `<system-reminder>`，超长折叠；
  - 真 Claude logo（`icons/claude-logo.svg` → `<ClaudeLogo>`）替换 ✻ 字符；SVG 麦克风/发送/中断。

### 安全
- **鉴权可配置**：`opts.noAuth`（默认 false = 需要 token），公网暴露默认受保护；`MAC_AGENT_NO_AUTH=1` 本地免鉴权，`make dev` 已设。

### 验证（2026-06-12）
- 单测：shared 15 + local-agent 59 + web 14 = **88 全绿**（file-change-tracker 在高负载下偶发 chokidar 超时，隔离重跑稳过）；web `tsc --noEmit` 干净；`next build` 成功（First Load 142 kB）。
- e2e（真实 agent + WS）：新建会话流式回出、drivenByAgent 标记、项目列表（7 个真实项目）均验证；UI 桌面+手机截图确认。
