# Mobile Agent Console — Plan

- 日期: 2026-05-08
- 关联 spec: [docs/specs/2026-05-08-mobile-agent-console-spec.md](../specs/2026-05-08-mobile-agent-console-spec.md)

> 本 plan 按"先骨架 → shared → local-agent → vscode-extension → web → mobile → 测试 → 文档"的顺序拆解，每个阶段都给出可独立交付的产物 + 验收点。阶段内任务可并行，阶段之间存在依赖。

## P0 — 仓库与工程基线

**目标**: 一个能 `pnpm install` 成功的 monorepo 骨架。

任务:
1. 初始化根 `package.json`、`pnpm-workspace.yaml`，配置 `apps/*` 与 `packages/*`。
2. 根目录加 `tsconfig.base.json`、`.editorconfig`、`.gitignore`、`.nvmrc`(20)、`.prettierrc`、`eslint.config.mjs`(flat config)。
3. 加 `vitest.workspace.ts`（聚合 web + local-agent + shared 的 vitest）。
4. 顶层脚本：`build / dev / lint / typecheck / test / test:mobile`。
5. CI 文件 `.github/workflows/ci.yml`（lint + typecheck + test + flutter test）。可选 v1 不真跑，仅占位。
6. `docs/architecture.md` 大纲。

验收: `pnpm install && pnpm -r typecheck` 通过（即使各包还是 stub）。

## P1 — `packages/shared`

**目标**: 协议契约的唯一真源。

任务:
1. 定义 `AgentSession / AgentLog / FileChange / Workspace / PairedDevice` TS 类型。
2. 用 Zod 写所有 REST 请求 / 响应 schema 与 WS 消息 schema。
3. 导出协议常量（事件名、错误码、版本号）。
4. 设计 token: `colors / radius / blur / spacing` 常量；同时输出一份 `tokens.dart` 由 mobile 消费（构建脚本生成）。
5. 单元测试：Zod schema 正反例。

验收: `pnpm --filter @mac/shared test` 全绿；其他包可 `import { AgentSessionSchema } from "@mac/shared"`.

## P2 — `packages/local-agent`

**目标**: 可独立 `node dist/cli.js` 启动的服务，提供 REST + WS。

任务（分子阶段，建议并行实现可由 PR 合并）:

### P2.1 基础架子
- Fastify app + `ws` 升级 handler；`/health` 通。
- `Bus`（mitt 或自实现 EventEmitter）。
- 配置加载（CLI 参数 + 环境变量 + 文件）。

### P2.2 Auth
- pair code 生成 / 校验、token 表（SHA256 存储）、`AuthManager` 单元测试。
- Fastify `preHandler` 鉴权；WS 升级阶段鉴权。

### P2.3 Session + PTY
- `PtyManager`：使用 `node-pty`，但写一个 `IPty` 接口便于测试 mock；将 `onData` 推到 `Bus`。
- ANSI 剥离用 `strip-ansi`，level 推断（启发：行首 `[error]` 等 → error；含 `pass / ok` → test/info；无匹配 → info）。
- `SessionManager`：CRUD、状态机（idle→running→waiting/error/completed）、interrupt(SIGINT)、restart。
- 与 `HistoryStore` 双写。

### P2.4 HistoryStore (SQLite)
- `better-sqlite3`；migrations 用简单版本表。
- 表：`sessions, logs, file_changes, devices, kv(meta)`。
- 索引：`logs(sessionId, timestamp)`。
- 接口：`appendLog / getLogs(filter) / saveSession / listSessions / saveFileChange ...`。

### P2.5 FileChangeTracker
- `chokidar` 监听 workspace 根；忽略 `.git node_modules dist build`。
- 当存在 `.git` 时，change 触发 → `simple-git` 生成 unified diff；否则缓存"上次内容"做内存 diff（限制文件大小 1MB）。
- 与"最近活跃 session"关联（最简：last-touched session）。

### P2.6 WS 广播
- 按 sessionId 订阅；`server:log / session_updated / file_changed / command_*` 全部从 Bus 转发。
- 心跳：`ping/pong` 30s。

### P2.7 CLI 入口
- `cli.ts`: `mac-agent --port 7345 --token ... --workspace .`，支持 `--daemon`(可选)。

测试覆盖：
- AuthManager: pair / verify / revoke。
- SessionManager: 创建 / 删除 / 写 input / 中断 / 重启 / 状态变化广播。
- PtyManager: 用 mock pty 验证写入与广播。
- HistoryStore: 增删查 + 重启后恢复。
- FileChangeTracker: 模拟 fs 变化 → 输出 FileChange。
- HTTP: supertest 全路由（含 401 / 404）。
- WS: 用 `ws` 客户端建立连接，断言事件序列。

验收: `pnpm --filter @mac/local-agent test` 全绿；`node dist/cli.js` 启动后 `curl /health` 返回 ok。

## P3 — `packages/vscode-extension`

**目标**: 一个可 F5 调试、可 `vsce package` 的 .vsix。

任务:
1. `package.json` 写 `contributes.viewsContainers / views / commands / configuration / menus`。
2. `extension.ts` activate：注册命令、初始化 `AgentService`（包装 `local-agent` 的内嵌启动 API）。
3. `MobileAgentConsoleViewProvider`（TreeDataProvider）：workspace 节点 / server 节点 / sessions 节点。
4. QR Code Webview：把 server 信息 + pair code 编码 → 用 `qrcode` 生成 svg → 嵌入 webview。
5. Pairing 请求 UI：当 `local-agent` 触发 `device:pair_request` 时，`window.showInformationMessage("设备 X 请求连接", "允许", "拒绝")`。
6. 配置读写（`workspace.getConfiguration`），变化时热更新 `local-agent`（端口变更需重启提示）。
7. 命令实现：`mac.startServer / stopServer / createSession / stopSession / deleteSession / showQrCode / openWebUi / revokeAllDevices`。
8. Logging: `OutputChannel("Mobile Agent Console")`。
9. 测试：`@vscode/test-electron` + Mocha；activation、命令注册、配置读取、server 启动用 in-memory mock。

验收: F5 启动调试主机；侧栏可见；可启动服务、生成 QR、用本地浏览器 `curl /health` 通。

## P4 — `apps/web`

**目标**: 可 `pnpm dev` 运行、可连真实 local-agent 的控制台。

任务:
1. Next.js 14 App Router + Tailwind + Zustand + TS strict。
2. 设计系统：基于 shared tokens 生成 Tailwind 配置 + 全局 CSS（深色渐变背景 + 玻璃拟态卡片）。
3. 通用组件：`Card / StatusBadge / IconButton / Input / Modal / EmptyState / LogLine / DiffViewer`。
4. 状态层 `useConnectionStore / useSessionStore / useLogStore`；WS 客户端 `lib/ws.ts`（自动重连 + 订阅管理）。
5. 路由实现：
   - `/`：Hero + 4 能力卡 + 4 步流程 + CTA（扫码 / 手动）。
   - `/connect/qr`：手动表单（host/port/token）；扫码用 `@yudiel/react-qr-scanner`。
   - `/sessions`：卡片网格 + 状态徽标 + 新增按钮。
   - `/sessions/[id]`：聊天气泡 + 步骤卡片 + 实时日志 + 输入栏（含中断 / 语音占位）。
   - `/sessions/[id]/logs`：分级过滤 + 自动滚动开关。
   - `/sessions/[id]/files`：列表 + react-diff-viewer。
   - `/settings`：服务器、token、默认 agent、日志保留、清空、断开。
6. 测试 (Vitest + RTL + MSW + ws mock)：
   - 连接页表单校验 / 提交。
   - 会话列表渲染 + 状态徽标。
   - 详情页 WS 收日志 → 渲染。
   - 日志页过滤逻辑。
   - Diff 页快照。
   - 设置页保存 / 清除。

验收: 启 local-agent + web → 输入 token → 创建一个 shell session → 输入 `ls` → 看到日志。

## P5 — `apps/mobile`（Flutter）

**目标**: 可在 iOS Simulator 跑起来的 App，UI 高度还原设计图。

任务:
1. `flutter create` + 配 `pubspec.yaml`：`flutter_riverpod, go_router, web_socket_channel, dio, mobile_scanner, speech_to_text, flutter_secure_storage, qr_flutter`(展示)、`fl_chart`(可选)。
2. `lib/theme/app_theme.dart`：颜色与 spec 对齐；玻璃拟态使用 `BackdropFilter`。
3. 路由：`/onboarding /connect /connect/qr /sessions /sessions/:id /sessions/:id/logs /sessions/:id/files /voice /settings`。
4. Provider：`connectionProvider, sessionListProvider, sessionDetailProvider, logStreamProvider`。
5. 服务层：`ApiClient(dio)`, `WsClient(web_socket_channel)`，断线重连。
6. 7 个页面按 spec 内容实现，内容可硬编码 demo 文案 + 真实数据切换。
7. 语音页：`speech_to_text` 真集成 + mock fallback；UI 麦克风脉冲动画用 `AnimatedBuilder`。
8. 文件变更页：横屏优先 (`SystemChrome.setPreferredOrientations`)；自实现简易左右分栏 diff（按行 padding，颜色 add/del/normal）。
9. 测试 `flutter test`：
   - widget test：每页基本渲染 + 关键交互。
   - provider 测试：`ProviderContainer` + mock ws。
   - golden test（连接页 + 会话卡片 + 日志行）。

验收: `flutter test` 通过；`flutter run -d <ios sim>` 可见 onboarding；输入 host/token 后能进入 sessions 列表（mock 或真实）。

## P6 — 集成自测脚本

任务:
1. `scripts/dev.sh`：并发启动 local-agent + web。
2. `scripts/e2e-smoke.sh`：起 agent → curl /health → 创建 session → 发送 input → 抓日志 → 删除 session。
3. 在 README 中记录"15 分钟体验链路"。

## P7 — 文档

按 spec 第七章列出全部产出。每篇文档至少包含：背景 / 接口 / 示例 / FAQ。

特别强调：

- `docs/install.md`：四端（vsce / web / flutter / local-agent）。
- `docs/security.md`：token / pairing / 公网风险 / 撤销设备。
- `docs/publish.md`：vsce publish、Web 部署到 Vercel、iOS TestFlight、Android Play Internal。

## P8 — 测试统一收口

1. 根脚本 `pnpm test` 串：shared → local-agent → vscode-extension(headless) → web。
2. `pnpm test:mobile` 调 `cd apps/mobile && flutter test`。
3. 修复所有失败用例。
4. 在 README + `docs/testing.md` 写命令矩阵。

## P9 — 验收 & 交付

输出物:

1. 全部源码 + 测试。
2. README.md（含目录结构、快速开始、命令矩阵、FAQ）。
3. 已完成清单 vs 受限清单（语音真实集成、Copilot Chat 接管等列入"未完成 / 受限"）。
4. 后续迭代建议（云端中继、TLS、团队协作、Whisper、移动端推送、桌面端 Electron 包裹独立 Local Agent）。

## 阶段依赖关系

```
P0 ── P1 ── P2 ──┬── P3 ──┐
               └─ P4 ──┐  ├── P6 ── P8 ── P9
                       │  │
                  P5 ──┘  │
                          │
                  P7 ─────┘
```

P3 / P4 / P5 在 P2 完成（或至少 P2.1+P2.2+P2.3 完成）后可并行。

## 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `node-pty` 在 VS Code Electron 与 Node CLI ABI 不一致 | extension 启动失败 | 内嵌模式优先用 `vscode.window.createTerminal` 的 ext API + `pty-host`；CLI 模式用 `node-pty` 预编译版本 |
| Copilot CLI 命令不存在 | session 创建失败 | 配置默认命令时探测 `which`，缺失时给出提示 + 改用 shell |
| iOS 真机调试证书 | 阻塞演示 | 默认仅 simulator；真机部分写在 publish.md，不阻塞 v1 |
| WS 在弱网下断连 | 日志丢失 | 客户端带 `lastSeq`，重连后 `GET /sessions/:id/logs?since=` 拉齐 |
| token 误存于明文配置 | 安全风险 | extension 优先写 OS keychain（`keytar` 或 vscode `SecretStorage`） |

## 估算粒度（不做时间估计）

按可交付增量切分 PR：

1. PR-01 P0 骨架
2. PR-02 P1 shared + zod + tests
3. PR-03 P2.1 + P2.2（架子 + auth）
4. PR-04 P2.3 + P2.4（session + history）
5. PR-05 P2.5 + P2.6 + P2.7（file watcher + ws + cli）
6. PR-06 P3 vscode-extension
7. PR-07 P4 web (sessions + detail + logs)
8. PR-08 P4 web (files + settings + onboarding)
9. PR-09 P5 mobile (theme + onboarding + sessions)
10. PR-10 P5 mobile (detail + logs + files + voice + settings)
11. PR-11 P6 集成脚本 + e2e smoke
12. PR-12 P7 文档
13. PR-13 P8 测试收口与修复
14. PR-14 P9 交付总结

每个 PR 自带测试，CI 必须通过才合并。
