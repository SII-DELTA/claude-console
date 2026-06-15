# Claude Code 远程接管 Plan

- 日期: 2026-06-11
- 关联 spec: [2026-06-11-claude-code-remote-takeover-spec.md](../specs/2026-06-11-claude-code-remote-takeover-spec.md)
- 状态: 待实现

## 总览

把「Copilot 磁盘镜像 + 续话」整套替换为「Claude Code 磁盘镜像 + resume/新开驱动」。
分 6 个 Phase，每个 Phase 结束跑对应测试。

## claude headless 接口（已实测 v2.1.160）

- 新开：`claude -p --session-id <uuid> --output-format stream-json --permission-mode <mode> "<prompt>"`
- 续写：`claude -p --resume <sessionId> --output-format stream-json --permission-mode <mode> "<prompt>"`
- 输出：stream-json，逐行 JSON 事件（system/assistant/user/result），含 content blocks 与 tool_use。
- 凭据：复用本机已登录 Claude Code（零配置）。
- **权限**：headless 下工具权限。v1 用可配置 `--permission-mode`，默认 `default`（遇敏感操作会在 stream 里产生 permission 事件 → 暂以 `acceptEdits` 兜底避免卡死；真正的「手机审批权限」列为 v0.2）。

---

## Phase 0 — shared schemas（@mac/shared）

文件：`packages/shared/src/schemas.ts`、`src/index.ts`

1. `AgentSessionTypeSchema`：`["codex","copilot","shell","custom"]` → `["claude","shell","custom"]`。
2. **删除** Copilot/lm-stream 实体：`CopilotNativeSession*`、`CopilotMessage*`、`CopilotContinue*`、`AiSessionTag`、`LmStream*`、`ServerCopilotContinue`、`ServerLmStream*`、相关 Response/Body schemas。
3. **新增** Claude 实体（见 spec §4）：
   - `ClaudeSessionSchema`（含 `isLive`）
   - `ClaudeMessageBlockSchema`（text/thinking/tool_use/tool_result 判别联合）
   - `ClaudeMessageSchema`
   - `ClaudeDriveStatusSchema`
   - REST：`ListClaudeSessionsResponse`、`ClaudeSessionDetailResponse`、`ClaudeContinueBody`、`ClaudeCreateBody`
4. **新增** WS server 消息并入 `ServerMessageSchema`：
   - `server:claude_session_updated` / `server:claude_message` / `server:claude_delta` / `server:claude_drive_done` / `server:claude_drive_error`
   - 从 union 移除 copilot/lm-stream 项。
5. 更新 `packages/shared/src/schemas.test.ts`。

验证：`pnpm --filter @mac/shared test`、`tsc -b` 通过。

---

## Phase 1 — ClaudeStore 镜像 + 解析（local-agent）

新增文件：`packages/local-agent/src/claude-store.ts`（替代 `copilot-store.ts`）

1. `projectsRoot = ~/.claude/projects`，按 `encodeCwd(workspaceRoot)`（`/`→`-`）定位当前工程目录。
2. `listSessions()`：扫描目录下 `*.jsonl`，解析头/尾若干行得到 title/计数/updatedAt/modelId；`isLive`= 文件 mtime 在近 `LIVE_WINDOW_MS`（如 10s）内。按 updatedAt 倒序。
3. `getSession(id)`：流式逐行解析整个 jsonl → `ClaudeMessage[]`：
   - `type=user` → role=user，content blocks（text / tool_result）
   - `type=assistant` → role=assistant，blocks（thinking / text / tool_use）
   - 跳过 queue-operation/ai-title/last-prompt/file-history-snapshot 等元数据（仅用于提取 title）。
4. **实时镜像**：用 `chokidar` watch projects 目录；文件增量变化时增量读取新行（记录每文件已读 offset），解析为 `ClaudeMessage` → `bus.emit` → WS `server:claude_message`；元数据变化 → `server:claude_session_updated`。
5. `setWorkspace()` 跟随工作区切换（沿用 copilot-store 接口形态）。

新增：`packages/local-agent/src/util/claude-jsonl.ts`（行解析纯函数，便于单测）。

验证：新增 `claude-store.test.ts`（用 fixture jsonl），覆盖解析与增量。

---

## Phase 2 — Claude 驱动（resume / 新开）

新增文件：`packages/local-agent/src/claude-driver.ts`

1. `createSession({ prompt, cwd })`：生成 uuid，spawn `claude -p --session-id <uuid> --output-format stream-json ...`，解析 stream-json → `server:claude_delta`，结束 → `server:claude_drive_done`/`error`。
2. `continueSession(id, prompt)`：先查 `isLive`；若 live 抛 `SESSION_LIVE`（http 层转 409）。否则 spawn `claude -p --resume <id> --output-format stream-json ...`，同样推 delta。
3. `interrupt(id)`：kill 对应子进程。
4. stream-json 解析器：`util/claude-stream.ts`（纯函数，单测）。把官方事件映射为 `ClaudeMessageBlock` 增量 + 状态。
5. 进程注册表：`Map<sessionId, ChildProcess>`，防止并发重复驱动。

验证：`claude-driver.test.ts` 用 mock 子进程 / 喂样例 stream-json 行。

---

## Phase 3 — REST + WS

文件：`packages/local-agent/src/http-server.ts`、`src/ws-bridge.ts`、`src/runtime.ts`、`src/bus.ts`

1. http-server：删 `/copilot/*`、`/stream/*`；加：
   - `GET /claude/sessions`、`GET /claude/sessions/:id`
   - `POST /claude/sessions`（新开）、`POST /claude/sessions/:id/continue`（409 if live）、`POST /claude/sessions/:id/interrupt`
2. bus：删 copilot/lm-stream 事件类型，加 claude 事件类型。
3. ws-bridge：转发新 `server:claude_*`，删旧消息。
4. runtime：去掉 `CopilotStore`/`lm-stream-manager` 注入，换 `ClaudeStore` + `ClaudeDriver`；`DEFAULT_COMMANDS` 去掉 codex/copilot，加 `claude`。
5. **监听绑定**：`cli.ts`/server 启动支持 `MAC_AGENT_BIND` 环境变量（默认 `127.0.0.1`；可设为 tailscale IP）。

删除文件：`copilot-store.ts`、`lm-stream-manager.ts` 及其测试。

验证：`pnpm --filter @mac/local-agent test`。

---

## Phase 3.5 — 删 VS Code 插件 + launchd 守护进程

1. **删除** `packages/vscode-extension` 整个包；从 `pnpm-workspace.yaml`、根 `package.json` scripts、`tsconfig` 引用、`.vscode/launch.json` 中移除相关项。
2. local-agent 改为独立常驻：
   - 确认 `cli.ts` 可独立启动（不依赖被 fork）；保留打印配对码。
   - 新增 `scripts/install-daemon.sh` 生成 launchd plist：`~/Library/LaunchAgents/com.nexra.local-agent.plist`，`KeepAlive=true`、`RunAtLoad=true`、`EnvironmentVariables` 含 `MAC_AGENT_BIND`。
   - 新增 `scripts/uninstall-daemon.sh`。
3. 清理 `docs/vscode-extension.md`（删或改为「已移除」说明）、`architecture.md` 进程拓扑图（去掉 Electron fork 链路）。

验证：`launchctl load` 后 `curl /health` 通过；重启/`kickstart` 后自动拉起。

---

## Phase 4 — Web 适配 Claude（apps/web）

文件：`apps/web`（Next.js + Zustand + Tailwind）

1. 类型/客户端：`/copilot/*`、`/stream/*` → `/claude/*`；删 Copilot/LmStream 相关类型与 store。
2. WS：处理 `server:claude_*`（session_updated / message / delta / drive_done / drive_error）。
3. 页面：
   - 会话列表：列出 Claude 会话 + `isLive` 标记。
   - 会话详情：渲染结构化 blocks（text / thinking / tool_use / tool_result）；输入栏 → 新开 / resume 续写；对 live 会话发指令前弹确认（409 处理）。
   - 删除 copilot 专属页/组件。
4. PWA 基础：`manifest.json` + 图标（供后续 Capacitor 复用资源）。

验证：`pnpm --filter @mac/web test`（更新 vitest）。

---

## Phase 4.5 — Android APK 壳（apps/shell, Capacitor）

新增：`apps/shell`（Capacitor 工程，独立于 pnpm 测试链，由 capacitor/gradle 管理）

1. `npx @capacitor/cli create` 初始化；`capacitor.config.ts`：`server.url = http://<服务器公网IP>:<port>`（远程加载 apps/web），`server.cleartext = true`。
2. `android/app/src/main/AndroidManifest.xml`：`android:usesCleartextTraffic="true"`，必要权限（INTERNET）。
3. 图标/名称（Nexra），复用 web manifest 图标。
4. 构建脚本 `scripts/build-apk.sh`：`npx cap sync android && ./gradlew assembleDebug` → 产出 `app-debug.apk`。
5. 文档：侧载步骤（开「未知来源」→ 装 apk）。

验证：`./gradlew assembleDebug` 产出 APK；装到安卓机能打开并连上 agent（联调阶段验证）。

---

## Phase 5 — 文档 + 联调 + change log + commit

1. 文档：
   - `docs/local-agent.md`：`/claude/*` API、驱动、绑定地址。
   - `docs/web.md`：去 copilot、加 claude 详情页与 PWA。
   - 删/改 `docs/mobile.md`、`docs/vscode-extension.md`（已移除说明）。
   - `docs/architecture.md`：拓扑图改为 安卓 APK → 服务器反代 → Tailscale → Mac。
   - 新增 `docs/remote-access.md`：Tailscale 组网 + 服务器反代（nginx/socat）+ launchd + **APK 打包/侧载** + 「本期明文、TLS 后置」提示。
   - `README.md`：会话类型、架构图、客户端形态更新。
2. 联调：launchd/`./scripts/dev.sh` 起 agent，安卓 APK / curl 验证 spec §7 验收。
3. **Change log**（按 CLAUDE.md）：改动文件 / 核心变更 / 影响范围 / 验证结果。
4. **Commit**：`refactor: replace Copilot integration with Claude Code remote takeover`。

---

## 风险与回滚

- 风险1：`claude` stream-json 事件格式跨版本变动 → 解析器隔离在 `util/claude-stream.ts`，集中适配。
- 风险2：headless 权限卡死 → v1 用 `acceptEdits` 兜底；手机审批列 v0.2。
- 风险3：live 会话并发驱动冲突 → 409 + 产品确认拦截。
- 回滚：本仓库非 git（`git status` 显示非仓库）；**Phase 5 commit 前先 `git init`**，否则无法回滚。建议 Phase 0 之前先 `git init` 打基线。

## 执行顺序

Phase 0 → 1 → 2 → 3 → 3.5 → 4 → 4.5 → 5，逐 Phase 跑测试。Phase 0 前先 `git init` + 首个基线 commit。
