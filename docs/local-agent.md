# local-agent

Fastify + `ws` + SQLite 的本地服务，跑在 Mac 上。读取/驱动 Claude Code 会话。

## 启动

```bash
# 开发
pnpm --filter @mac/local-agent dev          # tsx watch，workspace=仓库根
# 生产/常驻
node packages/local-agent/dist/cli.js -w <workspace> [-p 7345]
./scripts/install-daemon.sh                 # launchd 守护进程
```

CLI 选项：`-p/--port`、`-H/--host`、`-w/--workspace`、`-s/--storage`、`--origin`。
默认监听 `MAC_AGENT_BIND` 或 `127.0.0.1`。环境变量：
`MAC_AGENT_BIND`（绑定地址）、`CLAUDE_BIN`（claude 路径，默认 `claude`）、
`CLAUDE_PERMISSION_MODE`（headless 权限，默认 `acceptEdits`）、
`CLAUDE_INTERACTIVE_PERMISSIONS`（默认开启；设为 `0`/`false` 时关闭交互式权限
应答即方案 B，回退到方案 A 的前端兜底）。

## REST

鉴权：除 `/health` `/auth/pair` `/auth/pair/issue` 外都需 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康 + 版本 + workspaceId |
| POST | `/auth/pair` | 配对码兑换 token |
| GET | `/workspaces` · POST `/workspaces/switch` | 工作区 |
| **GET** | **`/claude/sessions`** | 列出 `~/.claude/projects` 会话（含 `isLive`） |
| **GET** | **`/claude/sessions/:id`** | 会话详情 + 结构化 `messages` |
| **POST** | **`/claude/sessions`** | 新开会话 `{prompt, cwd?}` → `{sessionId}` |
| **POST** | **`/claude/sessions/:id/continue`** | resume 续写 `{prompt, force?}`；live 且非 force → **409** |
| **POST** | **`/claude/sessions/:id/interrupt`** | 中断该会话的驱动进程 |
| GET/DELETE | `/devices` · `/devices/:id` | 设备列表 / 吊销 |

## WebSocket（`/ws?token=…`）

server → client：`server:hello`、`server:claude_session_updated`、`server:claude_message`、
`server:claude_delta`（含 `blockKind` text/thinking/tool_use）、`server:claude_drive_done`、`server:claude_drive_error`。

## 内部模块

* `ClaudeStore`（`claude-store.ts`）：`listSessions` / `getSession` / `isLive`，`chokidar` 监听目录增量 tail → `bus.claude:message` / `claude:session_updated`。解析纯函数在 `util/claude-jsonl.ts`。
* `ClaudeDriver`（`claude-driver.ts`）：`newSession`（`--session-id`）/ `continueSession`（`--resume`，可 `force`）/ `interrupt`。stream-json 解析在 `util/claude-stream.ts`，发 `bus.claude:delta` / `drive_done` / `drive_error`。会话 jsonl 才是权威内容（由 Store 镜像）。

## 测试

```bash
pnpm --filter @mac/local-agent test    # 55 测试
```
