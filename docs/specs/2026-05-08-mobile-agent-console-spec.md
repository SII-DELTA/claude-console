# Mobile Agent Console — Spec

- 日期: 2026-05-08
- 状态: Draft v1
- 作者: Engineering
- 代号: `mobile-agent-console`

## 1. 项目目标

构建一个面向开发者的「移动端 AI 编程控制台」，让用户在 **iOS / Android / Web** 上远程连接到运行在本机的 VS Code，控制本机的 **Codex CLI / Copilot CLI / Shell / 自定义命令** 形成的 Agent Session。

第一版（v1）的核心定位：

- 不接管 GitHub Copilot 官方 Chat UI 的内部状态（API 未公开，不做未知契约的逆向）。
- 通过 **PTY 接管 CLI session** 作为唯一受控 Agent Runtime。
- VS Code 插件提供 UI、配置、会话管理、并内嵌（或独立启动）一个 Local Agent 服务作为 Bridge。
- 移动端 / Web 端通过 WebSocket + REST 连接 Local Agent。

## 2. 三端 + 一服务 拓扑

```
┌──────────────┐   WebSocket/HTTPS   ┌─────────────────────┐   spawn/PTY   ┌──────────────────┐
│  Mobile App  │ ──────────────────▶ │   Local Agent       │ ───────────▶  │ codex/copilot CLI │
│  (Flutter)   │                     │   (Node + ws + http)│               │  shell / custom   │
└──────────────┘                     │                     │               └──────────────────┘
┌──────────────┐                     │  Session Manager    │
│   Web App    │ ──────────────────▶ │  PTY Manager        │
│  (Next.js)   │                     │  Auth/Pairing       │
└──────────────┘                     │  History (SQLite)   │
                                     │  File Watcher       │
                                     └──────────▲──────────┘
                                                │ in-process / spawn
                                     ┌──────────┴──────────┐
                                     │ VS Code Extension   │
                                     │  Sidebar / Webview  │
                                     │  Settings / QR Pair │
                                     └─────────────────────┘
```

## 3. 仓库结构（pnpm + monorepo）

```
mobile-agent-console/
├── apps/
│   ├── web/                   # Next.js 14 App Router + TS + Tailwind + Zustand
│   └── mobile/                # Flutter 3.x，Riverpod + go_router
├── packages/
│   ├── vscode-extension/      # VS Code Extension (TS)
│   ├── local-agent/           # Node 服务（既能内嵌也能独立 CLI 启动）
│   └── shared/                # 共享 TS 类型 + Zod schema + 协议常量
├── docs/
│   ├── specs/
│   ├── plans/
│   ├── architecture.md
│   ├── vscode-extension.md
│   ├── local-agent.md
│   ├── web.md
│   ├── mobile.md
│   ├── install.md
│   ├── publish.md
│   ├── testing.md
│   └── security.md
├── tests/                     # 跨包 e2e（可选，v1 内主要在各包内）
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

## 4. 核心实体

### 4.1 AgentSession

```ts
type AgentSessionType = "codex" | "copilot" | "shell" | "custom";
type AgentSessionStatus = "idle" | "running" | "waiting" | "error" | "completed";

interface AgentSession {
  id: string;                 // uuid v4
  workspaceId: string;        // 哈希(workspace 绝对路径)
  title: string;
  type: AgentSessionType;
  command: string;            // 真正 spawn 的命令行
  cwd: string;
  env?: Record<string, string>;
  status: AgentSessionStatus;
  createdAt: string;          // ISO
  updatedAt: string;          // ISO
  lastMessage?: string;
  exitCode?: number | null;
}
```

### 4.2 AgentLog

```ts
type AgentLogLevel = "info" | "action" | "test" | "error" | "warn";

interface AgentLog {
  id: string;                 // ulid
  sessionId: string;
  timestamp: string;          // ISO
  level: AgentLogLevel;
  content: string;            // 纯文本（已剥离 ANSI 给 UI 用，原始流另存）
  raw?: string;               // 含 ANSI 的原始数据，可选
}
```

### 4.3 FileChange

```ts
type FileChangeKind = "added" | "modified" | "deleted";

interface FileChange {
  id: string;
  sessionId: string;
  path: string;               // workspace 相对路径
  kind: FileChangeKind;
  addedLines: number;
  removedLines: number;
  timestamp: string;
  diff?: string;              // 统一 diff (unified diff)，按需懒加载
}
```

### 4.4 Workspace / Device

```ts
interface Workspace {
  id: string;
  name: string;
  rootPath: string;
}

interface PairedDevice {
  id: string;
  name: string;
  platform: "ios" | "android" | "web" | "unknown";
  pairedAt: string;
  lastSeenAt: string;
  revoked?: boolean;
}
```

## 5. 协议

### 5.1 REST API（Local Agent）

| Method | Path | 说明 |
|---|---|---|
| GET    | `/health` | `{ok:true,version}` |
| POST   | `/auth/pair` | 用一次性 pairing code 换长 token |
| GET    | `/workspaces` | 当前 host 公开的 workspace |
| GET    | `/sessions` | 列出所有 session |
| POST   | `/sessions` | 创建 session（body: type, command?, cwd?, title?） |
| GET    | `/sessions/:id` | 详情 |
| DELETE | `/sessions/:id` | 删除 + kill PTY |
| POST   | `/sessions/:id/input` | body: `{data:string}`，写入 PTY |
| POST   | `/sessions/:id/interrupt` | 发送 SIGINT |
| POST   | `/sessions/:id/restart` | kill 后按原配置重启 |
| GET    | `/sessions/:id/logs?since=&limit=&level=` | 历史日志分页 |
| GET    | `/sessions/:id/files` | 关联的 file changes |

所有 `/sessions/*` 与 `/workspaces` 需要 `Authorization: Bearer <token>`。

### 5.2 WebSocket

URL: `ws://host:port/ws?token=<token>`

Client → Server:

```ts
| { type: "client:input"; sessionId: string; data: string }
| { type: "client:interrupt"; sessionId: string }
| { type: "client:create_session"; payload: CreateSessionInput }
| { type: "client:delete_session"; sessionId: string }
| { type: "client:subscribe"; sessionId: string }
| { type: "client:ping" }
```

Server → Client:

```ts
| { type: "server:hello"; serverVersion: string; workspaceId: string }
| { type: "server:session_created"; session: AgentSession }
| { type: "server:session_updated"; session: AgentSession }
| { type: "server:session_deleted"; sessionId: string }
| { type: "server:log"; log: AgentLog }
| { type: "server:file_changed"; change: FileChange }
| { type: "server:command_started"; sessionId: string; command: string }
| { type: "server:command_finished"; sessionId: string; exitCode: number | null }
| { type: "server:error"; message: string; code?: string }
| { type: "server:pong" }
```

所有协议消息使用 Zod schema 定义于 `packages/shared`，编译期 TS 类型 + 运行期校验。

### 5.3 Pairing 与二维码

二维码 payload（JSON，base64url）：

```json
{
  "v": 1,
  "host": "192.168.1.10",
  "port": 7345,
  "wsPath": "/ws",
  "pairCode": "6位数字",
  "workspaceId": "wsxxxx",
  "name": "Mac-Studio / project-foo"
}
```

流程：
1. 用户在 VS Code 侧栏点「生成二维码」，插件生成 6 位 pair code（5 分钟过期，单次使用）。
2. 客户端扫码 → `POST /auth/pair { pairCode, deviceName, platform }` → 返回长 token + deviceId。
3. VS Code 弹窗「设备 X 想要连接，是否允许？」，用户确认后才下发 token（可选 v1 直接 trust on first use，但 UI 上展示请求）。
4. 长 token 存于客户端安全存储（iOS Keychain / `localStorage` + `subtle.crypto` 包裹的设备指纹）。

## 6. VS Code Extension 需求

### Sidebar View: `mobileAgentConsole`

- Workspace 信息（名称、路径、workspaceId）
- Local Server 状态（端口、运行中/未运行、外网开关）
- 活跃 sessions 列表（点击聚焦 / 中断 / 删除）
- 操作按钮：
  - Start / Stop server
  - Generate QR Code（webview）
  - New Session（QuickPick 选择 type → 输入 title/command）
  - Open Web UI（在浏览器打开 `http://localhost:<port>`）
- Pairing 请求弹窗（`window.showInformationMessage`）

### Commands

| Command | 说明 |
|---|---|
| `mac.startServer` | 启动 Local Agent |
| `mac.stopServer` | 停止 |
| `mac.createSession` | 新建 |
| `mac.stopSession` | 中断 |
| `mac.deleteSession` | 删除 |
| `mac.showQrCode` | 二维码 |
| `mac.openWebUi` | 浏览器打开 web |
| `mac.revokeAllDevices` | 撤销全部 token |

### 配置项 (`contributes.configuration`)

```jsonc
{
  "mobileAgentConsole.serverPort": 7345,
  "mobileAgentConsole.authToken": "",        // 留空时自动生成
  "mobileAgentConsole.allowedOrigins": ["http://localhost:3000"],
  "mobileAgentConsole.defaultAgentCommand": {
    "codex": "codex",
    "copilot": "gh copilot",
    "shell": "/bin/zsh -i",
    "custom": ""
  },
  "mobileAgentConsole.sessionHistoryPath": "",   // 默认 globalStorage
  "mobileAgentConsole.enableExternalNetworkAccess": false,
  "mobileAgentConsole.maxLogLinesPerSession": 5000,
  "mobileAgentConsole.logRetentionDays": 14
}
```

## 7. Local Agent 内部模块

| 模块 | 职责 |
|---|---|
| `HttpServer` | Fastify 路由 + Zod 校验 |
| `WsServer` | `ws`，鉴权 → 订阅 → 广播 |
| `AuthManager` | pair code 生成/校验、token 管理、设备列表 |
| `SessionManager` | CRUD + 状态机；将事件广播到 WsServer |
| `PtyManager` | `node-pty` 包装；onData / onExit；ANSI 解析 → AgentLog |
| `HistoryStore` | SQLite (`better-sqlite3`)；表 `sessions / logs / file_changes / devices` |
| `WorkspaceReader` | 解析 workspace path → workspaceId（sha1 + 短码） |
| `FileChangeTracker` | `chokidar` 监听 workspace；与最近 active session 关联；产出 unified diff（按 `git diff` 兜底） |
| `Bus` | 内部 event emitter，解耦各模块 |

绑定关系：VS Code Extension 通过 `import { startAgent }` 内嵌启动；亦可作为 `node packages/local-agent/dist/cli.js` 独立运行。

## 8. Web 端需求 (Next.js 14 App Router)

路由：

```
/                       连接页（Hero + 4 能力卡 + 流程 + CTA）
/connect/qr            扫码 / 手动输入
/sessions              会话列表
/sessions/[id]         会话详情（聊天 + 步骤 + 实时日志）
/sessions/[id]/logs    日志全屏 + 过滤
/sessions/[id]/files   文件变更（react-diff-viewer）
/settings              设置
```

技术：

- Tailwind + 自研 design tokens（紫色主色 + 深蓝黑渐变）
- Zustand 管全局连接 / sessions / logs（带 LRU + 缓存）
- 原生 `WebSocket` + 自动重连（指数退避，max 30s）
- Monaco Editor（settings 中编辑 default command 时）
- `react-diff-viewer-continued` 做 diff
- 单元测试: Vitest + React Testing Library + MSW + ws mock
- 鉴权信息保存在 `localStorage`（v1）

## 9. Mobile 端需求 (Flutter)

页面（按 spec 列出）：
1. 启动 / 连接页
2. 会话列表
3. 会话详情
4. 执行日志
5. 文件变更（横屏优先）
6. 语音输入
7. 设置

技术：

- Flutter 3.22+，`riverpod` 2.x，`go_router`
- `web_socket_channel`，`dio`
- `mobile_scanner` 扫码
- `speech_to_text`（mock 优先），`flutter_secure_storage`
- 主题：自研 `AppTheme`，颜色 token 来自 shared design tokens（手抄一份 dart 版本）
- 测试：`flutter_test` + golden test（关键页）+ `mocktail`

## 10. UI Design Tokens

```ts
const colors = {
  bg: { from: "#0B0B1A", to: "#10142A" },
  surface: "rgba(255,255,255,0.04)",
  surfaceStrong: "rgba(255,255,255,0.08)",
  primary: "#8B5CF6",       // violet-500
  primaryDeep: "#6D28D9",
  accent: { teal: "#14B8A6", green: "#22C55E", orange: "#F59E0B", red: "#EF4444", blue: "#3B82F6" },
  status: { running: "#22C55E", completed: "#14B8A6", error: "#EF4444", waiting: "#F59E0B", idle: "#94A3B8" },
  text: { primary: "#F8FAFC", secondary: "#94A3B8", muted: "#64748B" },
  border: "rgba(255,255,255,0.08)"
};
const radius = { sm: 8, md: 12, lg: 16, xl: 24 };
const blur = { card: 14 };
```

## 11. 安全要求

- token：`Bearer`，32 字节随机 base64url；存储时 SHA256，不存明文。
- pair code：6 位数字 + 5 分钟 TTL + 单次使用；带速率限制（每分钟 5 次失败即锁 10 分钟）。
- 默认仅监听 `127.0.0.1`，`enableExternalNetworkAccess=true` 才监听 `0.0.0.0`，并提示风险。
- WebSocket 鉴权：连接后 5s 内未收到合法 `client:hello` 或 query token → 关闭。
- CORS allowlist 强制（默认仅 localhost:3000 + Capacitor / Flutter 默认 origin）。
- 日志写入前进行 token 脱敏（正则擦除 `Authorization: Bearer ...`）。
- 配置文件中 token 字段在落盘时使用 OS keychain（macOS Keychain / Windows DPAPI），失败回退到本地加密文件（用机器 ID 派生密钥）。
- README 明确"暴露公网风险"。

## 12. 测试要求（必须通过）

- `packages/local-agent`: Vitest，覆盖 SessionManager / PtyManager(mock pty) / Auth / WS / REST / HistoryStore / FileChangeTracker。
- `packages/vscode-extension`: `@vscode/test-electron` + Mocha（最小化），覆盖 activation / commands / 配置读取 / server 启动 mock。
- `apps/web`: Vitest + RTL，连接页 / 列表 / 详情 / 日志 / diff / 设置 / WS mock。
- `apps/mobile`: `flutter test`，widget test 覆盖 7 个页面 + provider + ws mock。
- 单仓 `pnpm test` 一键跑通；mobile 由 `melos`-free 的 `flutter test` 单独入口。

## 13. 验收标准

见用户需求第十一章；本 spec 全部接受。

## 14. 受限 / 不做项 (v1)

- 不接管 Copilot Chat / Cursor Chat 等闭源 UI 状态。
- 不实现真正的 OpenAI Whisper 接入；语音 mock。
- 不做团队协作 / 多用户。
- 不做云端中继；仅 LAN / 本机直连（外网由用户自行 reverse-proxy + TLS）。
- iOS 不做 Push 通知；仅前台体验。

## 15. 待确认问题（不阻塞，先按推荐项实现）

| # | 问题 | 推荐 | 备注 |
|---|---|---|---|
| Q1 | 默认是否监听 `0.0.0.0` | 否，仅 127.0.0.1 | 用户显式开启 |
| Q2 | History 存储位置 | VS Code globalStorage | 可在 settings 改 |
| Q3 | Pairing UX | 二维码 + 6 位 code 双通道 | code 用于手动输入 |
| Q4 | Web 是否打包进 extension | v1 不打包，独立 dev/prod | 减少体积 |
| Q5 | iOS 语音 | mock，预留 `SpeechService` 接口 | v2 接 iOS Speech |
| Q6 | Diff 数据来源 | `git diff` 优先，fallback chokidar 内存 diff | 需 workspace 是 git 仓库时最佳 |

如以上推荐项与你预期不符，请在 review 时指出，否则按此实现。
