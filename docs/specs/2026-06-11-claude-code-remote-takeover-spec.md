# Claude Code 远程接管 Spec

- 日期: 2026-06-11
- 状态: 待确认
- 关联: 取代早期基于 Copilot/VS Code 状态逆向的探索方案，改为直接驱动 `claude` CLI

## 1. 背景与目标

当前系统通过 `CopilotStore` 读取 VS Code Copilot 的磁盘聊天记录并「续话」，并有一套 `lm-stream`（VS Code LM API 流式）。

目标：**把 iOS App 从「远程看 Copilot」改为「远程接管本机的 Claude Code 会话」**，并通过 Tailscale 让手机在任意网络下安全连接。

### 已确认的产品决策

| 项 | 决策 |
| --- | --- |
| Copilot 现有功能 | **彻底替换**为 Claude Code（删除 copilot-store / `/copilot/*` / lm-stream / `/stream/*` 及 mobile 对应页） |
| 驱动方式 | **混合模式**：实时镜像所有会话 + resume 接管历史会话 + 新开会话全控 |
| 部署位置 | local-agent + Claude Code 都跑在**这台 Mac**，读 Mac 的 `~/.claude/projects` |
| 远程连接 | **服务器作公网入口 + Tailscale 内联**：见 §6 拓扑。Mac↔服务器走 Tailscale；手机连服务器公网 IP；**本期边缘不加密(明文 http)，TLS 后置** |

## 2. Claude Code 会话的磁盘事实（已实测）

- 路径：`~/.claude/projects/<编码后的cwd>/<session-id>.jsonl`
  - 目录名是把工程绝对路径的 `/` 替换为 `-`（如 `-Users-Admin-Documents-project-agent-console`）
- 文件**实时追加写入**（当前活跃会话边跑边写）
- 每行一个 JSON 事件，关键 `type`：
  - `user` — `message.role=user`，`message.content[]`（`text` / `tool_result`）
  - `assistant` — 带 `model`、`message.content[]`（`thinking` / `text` / `tool_use`）
  - `system` / `queue-operation` / `ai-title` / `last-prompt` / `file-history-snapshot` 等元数据
  - 公共字段：`uuid` / `parentUuid` / `timestamp` / `sessionId`
- 「续话」：`claude --resume <session-id> -p "<prompt>" --output-format stream-json`，会继续向**同一个** jsonl 追加。
- 约束（OS 限制，非偷懒）：同一 `session-id` **不能同时**有「终端交互进程」与「手机 resume 进程」都活跃；其余场景（历史会话 resume、只读镜像活跃会话）均无冲突。

## 3. 范围

### In scope
1. local-agent 新增 `ClaudeStore`：扫描 / 解析 / 监听 `~/.claude/projects`，对外提供会话列表、会话详情（结构化消息）、实时增量推送。
2. local-agent 新增「驱动」能力：对指定 session resume 续写、新开会话，均以 stream-json 解析为结构化增量推流。
3. shared schemas 新增 Claude 实体与 WS 消息；移除 Copilot / lm-stream 实体。
4. http-server 用 `/claude/*` 路由替换 `/copilot/*` 与 `/stream/*`。
5. **客户端 UI = Web**：`apps/web`（Next.js）改读 Claude 数据——会话列表 / 详情（结构化 blocks）/ 输入接管（新开 + resume）。部署在服务器（公网）。
6. **新增 `apps/shell`（Capacitor）→ Android APK**：薄 WebView 壳，**远程加载**服务器上的 `apps/web` URL；`android:usesCleartextTraffic="true"` 放行明文 http（不依赖域名/TLS）；自签 debug APK 侧载安装，无商店、永久有效。改 web 无需重打 APK。
7. **删除 `apps/mobile`（Flutter）**：转向 Web+APK 壳，不再做 iOS / Flutter 原生（躲开签名/7 天重签）。
8. **删除 `packages/vscode-extension`**：新架构不依赖 VS Code。local-agent 改为**独立 launchd 守护进程**（开机自启、不依赖 VS Code），顺带消除 Electron ABI 冲突与 `child_process.fork` 机制。
9. 鉴权加固：见 §6。
10. 文档：`docs/remote-access.md`（Tailscale 组网 + 服务器反代）+ launchd 安装说明 + APK 打包/侧载说明。

> 说明：Claude Code 官方的 VS Code 扩展与终端 CLI 共用同一引擎，会话同样落 `~/.claude/projects`。无论用户用终端还是用 Claude Code IDE 扩展，本系统读文件即可覆盖，无需为其单独集成。

> 后续（非本期）：飞书集成——网页应用包壳 + 机器人推送/聊天驱动。飞书强制 HTTPS + 域名，届时服务器边缘加 Caddy 自动证书即可，**协议与后端不改**。

### Out of scope（本期不做）
- **飞书集成**（网页应用 + 机器人）——以后做；需 HTTPS + 域名时再上 Caddy 证书。
- **iOS 原生 App / Flutter**（apps/mobile 删除）。
- Cloudflare Tunnel / 公网域名（改用「服务器反代 + Tailscale」，见 §6）。
- 公网 TLS（本期明文 http，后置；飞书阶段再上）。
- VS Code 插件（直接删除，不再维护）。
- 多机切换（仅 Mac 单机；服务器仅作反代，不部署 agent/claude）。
- 语音/Whisper 流水线（web 暂不做）。
- 手机审批工具权限（headless 先用 `acceptEdits` 兜底，v0.2 再做）。

## 4. 数据模型（@mac/shared，新增 / 替换）

> 命名沿用 Copilot 实体风格，便于 mobile 复用现有列表/详情组件。

```
ClaudeSession {
  id: string                 // session-id
  title: string              // 取 ai-title 或首条 user prompt 摘要
  workspaceId: string
  cwd: string                // 解码自目录名
  sessionFilePath: string
  createdAt?: string
  updatedAt: string
  messageCount, userMessageCount, assistantMessageCount, toolUseCount: int
  modelId?: string
  isLive: boolean            // 文件近 N 秒内是否仍在写（活跃会话标识，用于接管前提示）
  preview?: string
}

ClaudeMessageBlock =
  | { kind: "text", text }
  | { kind: "thinking", text }
  | { kind: "tool_use", toolName, input }
  | { kind: "tool_result", toolUseId, content, isError? }

ClaudeMessage {
  id: string                 // uuid
  sessionId, parentUuid?, role: user|assistant|system
  blocks: ClaudeMessageBlock[]
  timestamp
}

ClaudeDriveStatus = pending | streaming | completed | failed
```

会话类型枚举 `AgentSessionType`：`["codex","copilot","shell","custom"]` → **改为** `["claude","shell","custom"]`（去掉 codex/copilot，新增 claude；`shell/custom` 保留给 PTY 模式）。

## 5. 协议（REST + WS）

### REST（`/claude/*` 替换 `/copilot/*` + `/stream/*`）
- `GET  /claude/sessions` — 列出所有会话（含 `isLive`）
- `GET  /claude/sessions/:id` — 会话详情 + 结构化 messages
- `POST /claude/sessions` — 新开会话（body: `{ prompt, cwd? }`）→ 返回新 session
- `POST /claude/sessions/:id/continue` — resume 续写（body: `{ prompt }`）；若 `isLive` 则返回 409 + 提示（产品层让用户确认）
- `POST /claude/sessions/:id/interrupt` — 中断当前 resume 进程

### WS（替换 `server:copilot_continue` / `server:lm_stream_*`）
- `server:claude_session_updated` — 会话元数据变化（含 isLive 切换）
- `server:claude_message` — 新整条消息（镜像监听到的新行）
- `server:claude_delta` — 驱动进程的流式增量（resume/新开时的 stream-json 增量）
- `server:claude_drive_done` / `server:claude_drive_error`

WS `client:*` 复用现有 `client:subscribe`（按 sessionId 订阅）。

## 6. 网络拓扑与鉴权

### 拓扑（最终）
```
手机 ──公网 http(本期不加密)──▶ 服务器(公网IP, 反代) ──Tailscale──▶ Mac(agent@7345 + claude)
```
- **Mac**：跑 agent + claude，读 Mac 的 `~/.claude/projects`。agent 监听绑定 **Tailscale 接口 IP + 127.0.0.1**（不裸 `0.0.0.0`）。
- **Mac ↔ 服务器**：走 Tailscale（加密、Mac 不暴露公网）。
- **服务器**：仅作反向代理（nginx/caddy/`socat`），公网端口 → 转发到 Mac 的 `tailscale-ip:7345`。**服务器上不装 agent、不装 claude。**
- **手机**：连 `http://<服务器公网IP>:<port>`，配对后用 Bearer token。

### 传输加密
- **本期不加密**（明文 http），仅限调试期。
- 风险：手机↔服务器这段公网明文，配对码/token 暴露在该跳；Mac↔服务器段有 Tailscale 加密。
- 后置：服务器边缘加 caddy/自签 TLS 即可升级为 https/wss，**协议与代码不改**。

### 鉴权（应用层）
- 现有 8 位配对码 + Bearer token 保留；token 增加**过期时间**与**设备级吊销**（`/devices` 已有吊销，确认链路生效）。
- 新增可选 `MAC_AGENT_BIND`（环境变量）控制监听地址，默认仅回环 + tailscale 接口。
- WS 首帧 `client:hello` token 校验沿用。

## 7. 验收标准

1. 手机连 `http://<服务器公网IP>:<port>`（服务器反代 → Mac tailscale:7345），配对成功。
2. 列表能看到 Mac 上 `~/.claude/projects` 里的真实历史会话，按更新时间排序，正在跑的标 `isLive`。
3. 打开一个**正在终端里跑**的会话 → 手机能看到其输出**实时流式**追加（只读镜像）。
4. 打开一个**历史**会话 → 手机发指令 → agent resume 续写 → 手机看到流式回复，且 Mac 的 jsonl 被正确追加。
5. 对 `isLive` 会话发指令 → 收到 409/提示，确认后才续写。
6. 手机新开一个会话 → 全程双向流畅。
7. 旧的 `/copilot/*`、`/stream/*` 路由与 mobile copilot 页全部移除，`pnpm test` / `flutter test` 通过。

## 8. 已确认决策（原开放问题）

1. **驱动解析** → ✅ **stream-json 驱动 + tail 镜像** 并存（resume/新开用 `--output-format stream-json`，镜像活跃会话用 tail jsonl）。
2. **传输加密** → ✅ **本期不加密（明文 http）**，TLS 后置（见 §6）。
3. **voice 占位页** → ✅ **保留占位**，不阻塞本期。
4. **`claude` 凭据** → ✅ **用本机已登录凭据**，零配置，不单独配 API key。
