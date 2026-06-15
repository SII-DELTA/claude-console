# Plan: 会话运行态统一（Hook 事件驱动 + driver 融合）

- 日期: 2026-06-16
- 依据 spec: `docs/specs/2026-06-16-session-liveness-detection-spec.md`（hooks 方案，已实测）
  + `docs/specs/2026-06-16-delivery-and-driving-state-spec.md`（driving 字段/事件/ws）
- 决策: ① Hook 由 agent 启动时**自动幂等写入 user 级** `~/.claude/settings.json`；
  ② 运行态 = **Hook 状态 ∨ 本端 driver.isDriving**（融合）。
- 范围: 仅「运行态/loading」统一。方案B「已读回执」本次**不做**（后续单列）。

## 信号与来源
- **权威 busy/idle/起止**：Claude lifecycle hooks（SessionStart→idle、UserPromptSubmit→busy、Stop→idle、SessionEnd→注销），写 `~/.claude/session-state/<sessionId>.json`。覆盖终端/VSCode/本端**所有**会话。
- **本端即时兜底**：`driver.isDriving(id)`（write→done busy）——本端会话即使 hook 未装/未重启也立即有 loading。
- **崩溃残留兜底**：reaper 低频（45s）扫 `~/.claude/sessions/*.json` + `kill -0`，死 PID 的状态判 `dead`。
- **mtime**：降级为最后兜底（hook+registry 都无信息时）。

## 组件与改动
1. **Hook 脚本** `packages/local-agent/hooks/session-hook.mjs`（零依赖 node）：读 stdin JSON + 事件名参数 → 原子写 `~/.claude/session-state/<sid>.json` `{sessionId,pid(ppid),cwd,state,transcriptPath,currentTool,lastEvent,lastEventAt,version}`。SessionEnd 删文件。状态计算抽成可单测的纯函数 `computeHookState`。
2. **安装器** `packages/local-agent/src/hooks-installer.ts`：定位脚本绝对路径 → 幂等 merge 进 `~/.claude/settings.json` 的 `hooks`（4 事件，命令 `"<node>" "<script>" <Event>`，用 `process.execPath` 锁 node）。已存在则跳过；不破坏用户既有 hooks；写前备份。返回是否新装（用于提示「已运行会话需重启」）。
3. **运行态中心** `packages/local-agent/src/session-liveness.ts`：`SessionLiveness` 监听 `~/.claude/session-state/`（chokidar）→ 内存表 `sid→{state,currentTool,pid,lastEventAt}`；reaper 定时校正；`isBusy(id)/isAlive(id)/getState(id)`；状态变化 emit 供 ws 广播。
4. **driver** `claude-driver.ts`：定义缺失的 `setBusy(id,bool)`——置 `busy` + 去重 emit `claude:driving`（解决当前编译不过）。
5. **store** `claude-store.ts`：`drivingPredicate` 已加；新增 `livenessPredicate`。`buildSession`：`driving = drivingPredicate||liveness.isBusy`；`isLive = liveness.isAlive || drivenByAgent || drivingPredicate || mtimeFresh`。
6. **runtime** `runtime.ts`：装 hooks（异步、失败仅告警）；建 `SessionLiveness`；接 store 谓词；把 `claude:driving` 与 liveness 变化都广播 `server:claude_driving`（融合后的有效值）。
7. **schema** `schemas.ts`：`driving` 字段 + `ServerClaudeDrivingSchema`（已加，保留）。
8. **前端** `store.ts`：处理 `server:claude_driving` → `sessions[].driving`；有效 loading = 本地 `driveStatus==="streaming" || selected?.driving`。`Dashboard`「正在运行」改用 `driving`（无 driving 时回退 isLive）。

## 测试
- `computeHookState`：4 事件 + PreToolUse/PostToolUse 的状态/currentTool 迁移。
- 安装器：空 settings / 已有他人 hooks / 重复安装幂等（merge 不重复、不破坏）。
- `SessionLiveness`：读状态文件、reaper 对死 PID 置 dead。
- 既有 `deriveAttention`/store 测试保持绿。

## 兜底与提示
- 热加载：已运行会话不纳管，启动日志提示「重启已有会话才生效」。
- 自动改全局 settings 前备份 `settings.json.bak`，merge 不覆盖既有键。
