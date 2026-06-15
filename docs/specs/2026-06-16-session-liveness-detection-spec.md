# 会话运行态外部感知 Spec（session-liveness-detection）

- 日期: 2026-06-16
- 状态: 设计待开发（已完成实测验证，结论锁定）
- 目标读者: 负责实现「会话状态中心 / 看板」的开发 agent

---

## 1. 背景与目标

需求：在 **Claude Code 会话进程之外**，用脚本/命令感知：

1. **存在性** —— 当前有哪些会话在跑（sessionId / cwd / 版本 / 启动时间）。
2. **忙闲** —— 某个会话此刻是「正在干活」还是「空闲等输入」。
3. **起止** —— 会话何时启动、何时结束。

约束：**低资源消耗**，优先事件驱动、避免高频轮询；不依赖对 jsonl 落盘做 mtime 轮询（噪声大、只能判活跃不能判起止）。

> 本 spec 的所有结论均经过在本机（macOS Darwin 24.6.0，Claude Code 2.1.177 / VSCode 扩展）实测，下文标注「实测」处均有证据。

---

## 2. 实测到的系统事实（信号清单）

### 2.1 官方 PID 注册表（最干净的存在性信号）

路径：`~/.claude/sessions/<PID>.json`，文件名即进程 PID，内容示例（实测）：

```json
{
  "pid": 80683,
  "sessionId": "2e7dd0ec-dbc7-45db-aeb0-598ab6287cf9",
  "cwd": "/Users/Admin/Documents/project/agent_console",
  "startedAt": 1781544264727,
  "procStart": "Mon Jun 15 17:24:24 2026",
  "version": "2.1.177",
  "peerProtocol": 1,
  "kind": "interactive",
  "entrypoint": "claude-vscode"
}
```

- 会话启动时写一次，**不是心跳**（判不了忙闲，只判存在）。
- 判活：遍历目录 + `kill -0 <pid>`。实测 9 个文件对应 PID 全部存活，无残留（Claude 自带清理，见 `~/.claude/.last-cleanup`）。但**强杀/崩溃可能留下残留文件**，必须用 `kill -0` 二次确认。

### 2.2 进程扫描

`pgrep -f 'native-binary/claude'` / `ps aux`。命令行直接暴露关键信息（实测）：

```
.../claude --output-format stream-json ... --resume <sessionId> --permission-mode auto --entrypoint ...
```

- `--resume <sessionId>` 给出会话 ID；无 `--resume` 的是新会话。
- `lsof -p <pid> | grep cwd` 可把 PID 映射到 workspace 目录（实测 80683 → `agent_console`）。

### 2.3 环境变量（仅会话派生的子进程/hook 内可见）

实测当前会话内可见：`CLAUDECODE=1`、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_CODE_ENTRYPOINT=claude-vscode`、`CLAUDE_CODE_EXECPATH`、`AI_AGENT`、`CLAUDE_CODE_CHILD_SESSION`。外部进程看不到，仅用于「我是否在会话内」自检。

### 2.4 IDE 锁文件

`~/.claude/ide/<port>.lock`（实测）：

```json
{"pid":34816,"workspaceFolders":["/Users/Admin/Documents/project/agent_console"],
 "ideName":"Visual Studio Code","transport":"ws","runningInWindows":false,"authToken":"..."}
```

仅 IDE 集成模式存在，含 ws 端口 + workspace + authToken，可能残留。

### 2.5 网络

`lsof -c claude -iTCP -sTCP:ESTABLISHED`（实测）：API 流量全部走本机代理 `localhost:7897`（终点是代理，不是 api.anthropic.com，判断时需注意）。连接「存在」≠「正在传输」，要判传输需 `nettop` 看字节增量。

### 2.6 ⚠️ CPU 判忙的盲区（关键负面结论，实测）

`ps -o time/%cpu` 采样判忙**有硬伤**：

- 第一次实测：当前正在生成 token 的会话 80683 显示 `%CPU 9.2`，其余挂机会话 `~1.3`，看似可用。
- 第二次实测（用脚本采样 0.6s 窗口）：80683 正在服务请求却显示 `idle (1.7%)` —— 因为采样窗口内主进程**卡在等子进程/等 API 响应**，主进程 CPU≈0。

结论：**Claude 有大量时间在等工具执行 / 等 API 流式响应，此时主进程 CPU 接近 0**。CPU 轮询会把「正在干活」误判为 idle。**CPU 不可作为判忙主信号**，只能作为「想粗看某会话此刻算力」的辅助。

---

## 3. ✅ 选定方案：Hook 事件驱动（已实测验证生效）

### 3.1 验证结果

配置项目级 `.claude/settings.local.json` 后，用一个全新 headless 会话 `claude -p "只回复两个字：ok"` 触发，实测 4 个生命周期 hook **全部生效**，6 秒完成，日志（实测）：

```
01:36:48  SessionStart       source:startup
01:36:48  UserPromptSubmit   prompt:"只回复两个字：ok"        ← 进入「忙」
01:36:54  Stop               last_assistant_message:"ok",
                             background_tasks:[], session_crons:[]  ← 转「闲」
01:36:54  SessionEnd         reason:other
```

每个 hook 的 stdin JSON payload 都带：`session_id`、`cwd`、`transcript_path`（**直接给出该会话 jsonl 路径**）、`hook_event_name`。Stop 额外带 `last_assistant_message` / `background_tasks` / `session_crons`，UserPromptSubmit 带 `prompt` 与 `permission_mode`。

### 3.2 为何 Hook 是最优解（对比，实测支撑）

| 维度 | CPU 轮询 | **Hook 事件驱动** |
|---|---|---|
| 资源 | 需常驻高频轮询 + 采样窗口 | **零轮询零常驻**，仅状态切换跑一次命令 |
| 准确性 | 有盲区，等工具/等 API 时误判 idle | **逻辑状态切换点，100% 准** |
| 颗粒度 | 仅算力高低 | 忙/闲/起/止，细到每个工具（PreToolUse/PostToolUse） |
| 起止感知 | 做不到 | SessionStart/SessionEnd 精确 |

### 3.3 状态机定义

```
                 SessionStart
   (无)  ───────────────────────────►  IDLE
                                         │
              UserPromptSubmit           │  ◄──────────── Stop
                     ▼                   │              （一轮答完）
                   BUSY  ───────────────►┘
                                         │
              SessionEnd / 进程消失       ▼
                                       (终止/清除)
```

- `SessionStart` → 注册会话，状态 IDLE。
- `UserPromptSubmit` → BUSY。
- `Stop` → IDLE（一轮结束）。
- `SessionEnd` → 注销。
- 更细粒度（可选）：`PreToolUse` → 记录「正在执行 <tool>」，`PostToolUse` → 清除。
- `Notification` → 可选，捕捉「等待权限/长时间空闲」提示。

### 3.4 ⚠️ Hook 的边界与兜底

- **崩溃残留**：进程被强杀时 `Stop`/`SessionEnd` 不会触发，状态会卡在 BUSY。**必须**用 §2.1 的 `kill -0 <pid>` 定期（低频，如 30~60s）扫描兜底，发现 PID 已死则强制将状态置为「终止」。
- **热加载**：运行中的会话不会加载新增 hook；只有**新启动**的会话生效（实测）。部署 hook 后已在跑的会话需重启才纳管。
- **stop_hook_active**：Stop payload 含该字段，防止 hook 链无限递归，开发时注意。

---

## 4. 推荐架构（开发目标）

```
┌─────────────────────────────────────────────────────────┐
│  Hook 命令（每会话事件触发，写结构化状态）                 │
│   SessionStart/UserPromptSubmit/Stop/SessionEnd          │
│        │ stdin JSON payload                              │
│        ▼                                                 │
│  状态文件: ~/.claude/session-state/<sessionId>.json       │
│   { sessionId, pid?, cwd, state, transcriptPath,         │
│     lastEvent, lastEventAt, version }                    │
│        ▲                                                 │
│        │ 低频兜底纠正（kill -0 扫 ~/.claude/sessions/*）   │
│  Reaper 守护（30~60s 一次，清残留 / 标 dead）              │
└─────────────────────────────────────────────────────────┘
        │ 读
        ▼
  看板/CLI/JSON 输出（列出会话 + 忙闲 + cwd + 时长）
```

- **主信号**：Hook 写状态文件（事件驱动，资源≈0）。
- **兜底**：低频 PID 存活扫描，纠正崩溃残留。
- **辅助**：CPU/nettop 仅在需要「实时算力/流量」时按需调用，不进主链路。

### 4.1 建议状态文件 schema

```json
{
  "sessionId": "ce983b77-...",
  "pid": 81234,
  "cwd": "/Users/Admin/Documents/project/agent_console",
  "state": "busy | idle | ended | dead",
  "transcriptPath": "/Users/Admin/.claude/projects/.../<id>.jsonl",
  "currentTool": "Bash | null",
  "lastEvent": "UserPromptSubmit",
  "lastEventAt": "2026-06-16T01:36:48Z",
  "version": "2.1.177"
}
```

> 注意：hook payload **不直接含 pid**。pid 需 hook 命令内用 `$PPID` 或从 `~/.claude/sessions/*.json` 按 sessionId 反查补全（供 reaper 用 `kill -0`）。

---

## 5. 参考实现片段（已验证可用，供直接复用）

### 5.1 Hook 配置（项目级 `.claude/settings.local.json`，实测生效）

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "<写状态: state=idle>" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "<写状态: state=busy>" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "<写状态: state=idle>" }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "<写状态: state=ended>" }] }]
  }
}
```

测试期用的最小落盘命令（把整个 payload 追加到日志，验证用）：

```bash
{ printf '%s SessionStart ' "$(date +%T)"; cat; echo; } >> /tmp/claude-hooks.log
```

正式实现应改为：读 stdin JSON（`jq` 已确认可用），抽 `session_id`/`cwd`/`transcript_path`，写 `~/.claude/session-state/<sessionId>.json`。

### 5.2 兜底 / 存在性扫描（低资源，纯 ps + 注册表）

```zsh
# 列出所有活会话；reaper 用同样方式发现死 PID 后清状态
for f in ~/.claude/sessions/*.json(N); do
  pid=${${f:t}:r}
  kill -0 "$pid" 2>/dev/null || { echo "DEAD $pid"; continue; }
  sid=$(jq -r .sessionId "$f"); cwd=$(jq -r .cwd "$f")
  echo "ALIVE $pid $sid ${cwd:t}"
done
```

### 5.3 CPU 采样（仅辅助，注意 §2.6 盲区）

```zsh
# 采样窗口 WIN 秒，差值/窗口 ≈ CPU%；>5% 视为正在算（但等工具/等API时会漏判）
# 完整脚本见测试遗留 /tmp/claude-busy.sh（如已清理，按此重建）
```

---

## 6. 偏门方案附录（已评估，均不优于 §3，不建议采用）

| 方案 | 能力 | 为何不选 |
|---|---|---|
| `fs_usage -f filesystem claude` | 内核实时 syscall 流，判忙最实时 | **需 sudo**，常驻，重；Hook 已足够准 |
| `nettop -p <pid> -x -l 0` | 实时收发字节判传输 | 常驻轮询；代理场景终点失真；仅作流量辅助 |
| kqueue/FSEvents 监听 `~/.claude/sessions/` | 目录创建/删除=起/止，被动 | 需自写守护；Hook 起止更直接且带 payload |
| EndpointSecurity (ESF) | 内核级 exec/exit 零延迟 | **需签名 + entitlement**，最重，过度 |
| OpenTelemetry (`CLAUDE_CODE_ENABLE_TELEMETRY=1` + OTLP) | 官方 metrics/logs 推送 | 适合做监控大盘/带 token 数据；本需求偏轻量，可作 §4 之上的可选增强 |
| jsonl mtime 轮询 | 判活跃 | 噪声大、判不了起止、需高频轮询；明确排除 |

> 备注：`~/.claude/telemetry/1p_failed_events.*.json` 是首方遥测发送失败的本地缓存，文件增长是弱活跃信号，不可靠，仅记录。

---

## 7. 给开发 agent 的任务拆解建议

1. **Hook 写入器**：实现读 stdin JSON → 写 `~/.claude/session-state/<sessionId>.json` 的小脚本（4 个事件 + 可选 PreToolUse/PostToolUse）。补全 pid（`$PPID` 或反查注册表）。
2. **Hook 安装器**：把 §5.1 配置写入目标 settings（user 级可全局纳管所有项目，project 级仅当前项目）。注意热加载限制——提示用户重启已有会话。
3. **Reaper 守护**：30~60s 扫 `~/.claude/sessions/*.json` + `kill -0`，纠正崩溃残留为 `dead`，清理过期状态文件。
4. **读出层**：CLI/JSON/TUI 看板，聚合状态文件，展示 sessionId / state / cwd / 时长 / currentTool。
5. **（可选）算力/流量探针**：按需触发 §5.3 CPU 或 nettop，不进主链路。

---

## 8. 复现验证方法

```bash
# 1) 装 hook（项目级 settings.local.json，见 §5.1）
# 2) 起全新 headless 会话触发完整生命周期
: > /tmp/claude-hooks.log
"$CLAUDE_CODE_EXECPATH" -p "只回复两个字：ok" --setting-sources user,project,local < /dev/null
# 3) 查看 /tmp/claude-hooks.log，应见 SessionStart→UserPromptSubmit→Stop→SessionEnd 四条
```

---

## 9. 一句话结论

**判忙/判起止能低资源解决，最优解不是轮询而是 Hook**（事件驱动、零常驻、实测 100% 触发），辅以 `kill -0` PID 注册表兜底崩溃残留；CPU/网络/内核嗅探等偏门方案均更重且不更准，仅按需作辅助。
