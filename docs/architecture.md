# 架构

## 角色

* **本地 Agent (local-agent)**：跑在 Mac 上的 HTTP + WebSocket 服务。读 `~/.claude/projects` 的 Claude Code 会话、用 `claude` CLI headless 驱动；SQLite 持久化鉴权/历史。**不依赖 VS Code**（已移除插件）。
* **Web**：浏览器端 UI（apps/web，PWA，电脑/手机双适配），与 agent 同机起，`:3005`。
* **Tailscale**：手机/电脑与 Mac 同一 tailnet，浏览器经 WireGuard 加密直连 Mac，无需公网服务器/反代。

## 拓扑

```
浏览器(PWA, 手机/电脑) ──Tailscale(WireGuard 加密)──▶ Mac
                                                     ├─ web (Next.js :3005)
                                                     ├─ local-agent (Fastify :7345 + ws)
                                                     │   ├─ ClaudeStore  (chokidar 镜像 jsonl)
                                                     │   ├─ ClaudeDriver (claude -p stream-json)
                                                     │   └─ SQLite (~/.mac-agent)
                                                     └─ N × Claude Code 会话 (~/.claude/projects/*.jsonl)
```

## Claude Code 会话的磁盘事实

* 路径：`~/.claude/projects/<encodeProjectDir(cwd)>/<session-id>.jsonl`，`encodeProjectDir` = 把 cwd 里非字母数字字符替换为 `-`。
* 文件实时追加；每行一个 JSON 事件：`user`/`assistant`（`message.content[]`：text/thinking/tool_use/tool_result）、`ai-title`、`queue-operation` 等。
* 续写：`claude -p --resume <id> --output-format stream-json`，继续向同一 jsonl 追加。
* 约束：同一 session-id 不能同时有「终端交互进程」和「手机 resume 进程」活跃；其余无冲突。

## 鉴权

* 启动生成 8 位配对码（5 分钟、单次）。
* 端 POST `/auth/pair` 兑换长期 Bearer token；REST 用 `Authorization: Bearer`，WS 用 `?token=` 首帧校验。
* 设备可在 `/devices` 吊销。
* 监听地址默认 `127.0.0.1`，`MAC_AGENT_BIND` 显式放行到 Tailscale 接口。

## 数据模型（`@mac/shared`）

* `ClaudeSession{ id, title, workspaceId, cwd, sessionFilePath, updatedAt, messageCount, userMessageCount, assistantMessageCount, toolUseCount, modelId?, isLive, preview? }`
* `ClaudeMessage{ id, sessionId, parentUuid?, role, blocks[], timestamp }`，`block` = text | thinking | tool_use | tool_result。
* WS（discriminated union）：
  * client → server：`client:hello` / `client:subscribe` / `client:ping`
  * server → client：`server:hello` / `server:claude_session_updated` / `server:claude_message` / `server:claude_delta` / `server:claude_drive_done` / `server:claude_drive_error`

## 时序：从手机新开会话到看见流

```
Web(浏览器)          local-agent                 claude CLI
  │ POST /claude/sessions {prompt}                   │
  │ ───────────────────────▶ newSession(uuid)        │
  │   { sessionId }          ─ spawn claude -p ──────▶│
  │ ◀───────────────────────                          │ 写 ~/.claude/projects/.../uuid.jsonl
  │                          ClaudeStore(chokidar) tail│
  │ WS server:claude_message ◀───────────────────────┘
  │ ◀───────────────────────  (+ server:claude_delta 流)
  │ WS server:claude_drive_done ◀── result 事件
```

## 失败模式

| 场景 | 行为 |
| --- | --- |
| 配对码错误/过期 | `/auth/pair` 401 |
| token 失效 | REST 401；WS 升级 401 |
| 对 live 会话续写 | `/claude/sessions/:id/continue` 409；前端确认后带 `force` 重试 |
| claude 进程非零退出 | `server:claude_drive_error` |
| jsonl 格式跨版本变动 | 解析隔离在 `util/claude-jsonl.ts` / `util/claude-stream.ts` 集中适配 |
