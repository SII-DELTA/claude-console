# 监控台 UX 优化 实施 Plan

- 日期: 2026-06-16
- 对应 spec: `docs/specs/2026-06-16-monitor-dashboard-ux-spec.md`
- 决策补充: 层 C `currentTask` 摘要**默认开**（env `CURRENT_TASK_SUMMARY` 可关）。

## 架构关键点（已确认）

- 后端 `claude-driver.ts` 直接 spawn `claude` CLI，无独立 Anthropic SDK。
  → 层 C 复用用户已有 Claude Code 认证：一次性 `claude -p <transcript> --model haiku --output-format json --append-system-prompt <观察员指令>`，cwd 用临时目录（避免加载项目 CLAUDE.md 污染观察员），**只读不写会话**。
- 会话元数据由 `ClaudeStore.buildSession` 合成，经 `claude:session_updated` → `server:claude_session_updated` WS 推送。新字段随其自动到前端。
- dashboard 当前用 `sessions`（单活动项目）。跨项目总览新增只读 `allSessions`（meta-only），不动 driver/detail 的单项目路径。

## 阶段一：动态当前任务（A + B + C）

### 1. `packages/local-agent/src/util/claude-jsonl.ts`
- `SessionAccumulator` 增加：`lastUserText`、`lastAssistantText`、`lastToolName`、`lastToolInput`。
- `accumulate()`：user 文本 → 覆盖 `lastUserText`；assistant 文本块 → `lastAssistantText`；assistant `tool_use` → `lastToolName`/`lastToolInput`。
- 新增纯函数 `deriveActivity(acc)`：由最后一个 `tool_use` 产出友好动作串（编辑/读取/运行/搜索/网页…），无工具则空。
- 新增 `deriveLastUser(acc)`、`deriveResult(acc)`（assistant 末条文本首行，clip）。

### 2. `packages/shared/src/schemas.ts`
`ClaudeSessionSchema` 新增可选字段（向后兼容）：`lastUserText`、`currentTask`、`lastActivity`、`lastResult`。

### 3. `packages/local-agent/src/claude-store.ts`
- `buildSession` 填充 `lastUserText`/`lastActivity`/`lastResult`；`currentTask` 取注入的 `currentTaskPredicate`。
- 新增 `setCurrentTaskPredicate()`。

### 4. 层 C 模块 `packages/local-agent/src/current-task.ts`
- `CurrentTaskSummarizer`：监听 `claude:drive_done` → 取 `store.getSession` 末尾消息拼 transcript → spawn 一次性 `claude -p` (haiku, json, tmpdir cwd, 超时 25s) → 解析 `.result` → clip ≤24 字 → 存 `Map<id,string>` → `store.refreshSession(id)` 广播。
- env `CURRENT_TASK_SUMMARY`（默认开，`0/false` 关）；按 `messageCount` 去重；in-flight Set 防并发；失败静默回退层 A。

### 5. `packages/local-agent/src/runtime.ts`
- new `CurrentTaskSummarizer`，`claude.setCurrentTaskPredicate(id => summarizer.get(id))`，启动其 drive_done 订阅。

### 6. `apps/web/components/Dashboard.tsx`
- 标题优先级：`currentTask → lastUserText → title`。
- 活动行：running → `lastActivity`（前缀「正在」）；done → `lastResult`；其余维持标签。

## 阶段二：跨项目总览 + 聚焦 + 切换交互

### 7. 后端
- `ClaudeStore.listAllSessions()`：扫描所有项目目录 meta-only 列表（带 cwd/项目名）。
- 监控 watcher 由「仅活动项目目录」扩展为 `projectsRoot`（depth 1），使所有项目会话变更都 emit `session_updated`（`onFileChanged` 已按文件路径读 meta，跨项目天然正确）。`start()` 对全 root 下 jsonl 播种 offset。
- `http-server.ts`：`GET /claude/sessions/all` → `listAllSessions()`。

### 8. 前端 store `apps/web/lib/store.ts`
- 新增 `allSessions`、`dashboardFocus: string|null`（null=全部）、`loadAllSessions()`、`setDashboardFocus()`。
- `claude:session_updated` / `claude:driving` 同步 upsert `allSessions`。
- `api.ts`：`claudeAllSessions()`。

### 9. 前端 `apps/web/app/page.tsx`
- 初始 + 20s 轮询追加 `loadAllSessions()`。
- Dashboard 传 `allSessions`（按 `dashboardFocus` 过滤）、`projects`、`focus`、`onFocus`。
- `onOpen`：据会话 cwd 找项目 dir，若 ≠ 活动项目先 `switchProject` 再 `selectSession`。

### 10. Dashboard 顶部项目栏
- sticky 横向 pill：「全部」+ 各项目 chip，带 `运行N/待处理M` 徽章（M>0 珊瑚色）。
- 项目多时末尾「更多」可搜索下拉。
- 主体区左右 swipe 在 [全部, …项目] 间切 focus。

## 测试与验证
- 新增 `claude-jsonl` 纯函数测试：`lastUserText`/`deriveActivity`/`deriveResult`。
- `pnpm typecheck` + `pnpm test` 全绿。
- 手测：多任务会话标题随最近指令变化；运行中显示工具动作；摘要开启后会话 jsonl 行数不因摘要增长。

## 提交节奏
- 阶段一完成 → commit。
- 阶段二完成 → commit。
- 每次提交前写 change log。
</content>
</invoke>
