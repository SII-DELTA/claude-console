# 2026-06-16 会话运行态统一（Hook 事件驱动 + driver 融合）

## 背景
监控台「正在运行」此前只看 jsonl 文件 mtime（30s 窗口）：长任务静默不落盘就被误判为「停止」；
且 loading 是纯前端乐观态，刷新/换端/断线重连会脱节。实测确认 Claude Code 提供 lifecycle
hook，可在会话进程外、零轮询地感知 busy/idle/起/止（见 spec）。

## 方案（依 spec：session-liveness-detection）
权威运行态 = **Claude lifecycle hooks**（覆盖终端/VSCode/本端所有会话），**∪ 本端 driver.isDriving**（即时兜底），
**∪** 崩溃残留由 `kill -0` reaper 纠正。mtime 降级为最后兜底。

## 改动
**新增**
- `packages/local-agent/hooks/session-hook.mjs`（+ `.d.mts`）：零依赖 node 钩子脚本。读 hook payload → 原子写 `~/.claude/session-state/<sid>.json`。SessionStart→idle、UserPromptSubmit→busy、Stop→idle、SessionEnd→删；Pre/PostToolUse 记录 currentTool。状态迁移抽成纯函数 `computeHookState`（可单测）。
- `src/hooks-installer.ts`：幂等 merge 我们的 hooks 进 user 级 `~/.claude/settings.json`（用 `process.execPath` 锁 node + 脚本绝对路径）；不破坏用户既有键/hooks；写前备份 `.bak`；可重入。
- `src/session-liveness.ts`：`SessionLiveness` chokidar 监听 session-state → busy/idle/alive；45s reaper 用官方 PID 注册表 `~/.claude/sessions/*.json` + `kill -0` 清崩溃残留；busy↔idle 变化 emit `claude:driving`。
- 测试 `__tests__/session-liveness.test.ts`：computeHookState 迁移、安装器幂等/保留既有 hooks、reaper 标 dead/保活。

**改动**
- `shared/schemas.ts`：`ClaudeSession.driving` 字段 + `server:claude_driving` ws 消息（并入 union）。
- `shared/constants.ts`：`LIVE_WINDOW_MS` 30s→90s（mtime 兜底放宽）。
- `local-agent/bus.ts`：`claude:driving` 事件。
- `local-agent/claude-driver.ts`：`setBusy()`（置 busy + 去重 emit `claude:driving`），write→true、done/error/close→false。
- `local-agent/claude-store.ts`：`buildSession` 计算 `driving = liveness.busy ∨ driver.isDriving`；`isLive = liveness.alive ∨ ownsByAgent ∨ driving ∨ mtimeFresh`。
- `local-agent/runtime.ts`：启动 `SessionLiveness` + 幂等装 hooks（`enableSessionLiveness`，默认开；测试关）；接谓词。
- `local-agent/ws-bridge.ts`：`claude:driving` → 广播 `server:claude_driving`。
- 前端 `store.ts`：处理 `server:claude_driving` → `sessions[].driving`。`page.tsx`：driving 时显示 loading（刷新/换端/终端会话可靠）。`Dashboard.tsx`：「正在运行」改用 `driving`（不再用 isLive，避免把空闲但挂着的 VSCode 会话误报为运行中）。

## 边界
- **热加载**：已在运行的会话不会加载新 hook，需重启才纳管（agent 启动日志提示）。
- **方案B「已读回执」本次未做**（delivery-and-driving-state spec 的另一半），后续单列。

## 验证
- local-agent 97 测试全绿（含新 8 例）；web 18 绿；全包 typecheck 通过；web build 成功。
- 测试经 `enableSessionLiveness:false` 不再触碰真实 `~/.claude/settings.json`。
- 安装器端到端验证：真实 settings.json 已正确 merge（保留 theme/effortLevel，6 事件全装，命令含绝对 node+脚本路径）。
