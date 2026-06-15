# 移动端导航重构（监控台 + 底部 Tab + 栈式会话页）与可配置初始消息数 Spec

- 日期: 2026-06-15
- 状态: 待确认
- 范围: 移动端（`<md`）导航重构 + 监控台主页 + 配套 agent 会话「关注状态」元数据；会话初始渲染消息数可配置
- 设计参考: `claude-console.jpg`（手机三屏：Sessions 列表带底部 tab；会话详情带 `<` 返回 + `...`）

## 1. 背景与目标

当前移动端是**抽屉式**：`☰` 拉出会话列表，聊天页常驻；无主页/详情分层、无底部 tab、无独立 Settings 页，项目切换藏在左上角 `Brand` 下拉（见 `apps/web/app/page.tsx`）。

远程驾驭 Claude Code 的核心痛点不是「看不到」，而是 **「现在需不需要我去管它？」**：会话可能卡在等待提问（AskUserQuestion / 权限）、出错、或跑完待续写，不点进去无从得知；多会话/多项目并行时尤甚。

目标：
1. 移动端改为**栈式导航 + 底部 Tab**，主页做成**监控台**，按「是否需要你」聚合所有会话，一眼可知该管谁。
2. 会话**初始渲染消息数**改为默认 10、可经 env 配置（首屏更快）。

桌面端（`md+`）**保留现有「侧栏会话列表 + 右侧聊天」主从布局**，本次不改。

## 2. 导航模型（仅移动端 `<md`）

三个底部 Tab：**监控台 (Dashboard) / Sessions / Settings**。

- Tab 页（监控台/Sessions/Settings）显示**底部 Tab 栏**。
- 进入某会话（`selectedId` 非空）→ 推入**会话详情页**（全屏聊天）：顶栏左 `<` 返回 + 标题/状态 + 右 `...`；**底部 Tab 栏隐藏**；底部为输入框（+ QuickActions + 权限选择器）。
- `<` 返回 = `selectSession(null)`，回到进入前的 Tab，Tab 栏重新出现。
- 状态：新增 `mobileTab: "dashboard" | "sessions" | "settings"`（默认 `dashboard`）。详情态由 `selectedId` 派生，不新增路由。
- URL：保持现有 `?p=&s=` 同步（`restoreFromUrl`）；带 `s=` 进入即直达详情页。

桌面端逻辑分支不变。

## 3. 各页设计

### 3.1 监控台（主页）
按状态分组卡片，点任意卡片 → 进入该会话详情：

- `🔴 待你处理`：`attention === "question"`（等待 AskUserQuestion/权限）或 `"error"`（出错）；以及 `"done"`（跑完待续写，弱提示）。
- `🟢 运行中`：`isLive`（`drivenByAgent` → 标「本端」，否则「终端」）。
- `🕘 最近`：其余会话按 `updatedAt` 倒序（截断 N 条，可「查看全部」跳 Sessions）。
- 顶部**概览条**：活跃会话数 · 今日 token / 花费（复用 `usage-cache`）。
- 空态：无会话时引导「+ 新会话」。

卡片信息：标题、项目名、状态徽章、相对时间、`preview` 摘要。

### 3.2 Sessions Tab
- 顶部：**项目选择器**（把现 `Brand` 的项目下拉移来）+ `+` 新建。
- 列表：当前项目全部会话（复用 `SessionList`）。

### 3.3 Settings Tab
收拢现散落的设置：
- 连接信息（server 地址、ws 状态）+ **断开**（现仅桌面 header 有）。
- **默认权限模式**（`permissionMode`；会话内仍可临时改）。
- 版本信息、刷新。

### 3.4 会话详情页
- 顶栏：`<` 返回（**替换** `☰`）+ 标题 + 状态徽章（本端/终端运行中）+ `...` 溢出菜单。
- `...` 菜单：会话/项目信息、复制 session id、（后续）删除会话；断开也可放此。
- 主体：消息流（含「加载更早」、流式气泡、用量行）——逻辑不变。
- 底部：QuickActions + 权限选择器 + Composer——不变。
- 接管确认（`ConfirmTakeover`）、QuestionPanel（方案 A/B）——不变。

### 3.5 底部 Tab 栏组件
- 3 个图标 + 文案：监控台 / Sessions / Settings；当前态高亮（珊瑚色）。
- `pb-safe` 安全区内边距；详情页隐藏。

## 4. 后端配合：会话「关注状态」元数据

监控台「待你处理」需**不点进会话**就能跨所有会话判断，须由 agent 在会话列表元数据给出。

### 4.1 `@mac/shared` schema
`ClaudeSessionSchema` 新增可选字段：
```
attention: z.enum(["question", "error", "done"]).optional()
```
- `question`：最近一个 assistant turn 含 `AskUserQuestion` 的 `tool_use`，且其后无非错误 `tool_result`（服务端镜像 `findPendingQuestions` 的判定）。
- `error`：最近一次驱动以错误结束（`server:claude_drive_error` / result 错误）。
- `done`：会话非 live 且最近事件为 turn 完成（assistant result），即跑完待续写。
- 缺省（无字段）：无需关注。

### 4.2 `ClaudeStore`（local-agent）
- 构建/刷新会话元数据时，解析 jsonl **末尾若干事件**（复用 `util/claude-jsonl` / `util/claude-stream`）计算 `attention`，避免整文件重扫。
- `chokidar` 触发更新后，经现有 `server:claude_session_updated` 推送，前端监控台实时更新。

### 4.3 兼容
- 字段可选，旧前端忽略不受影响；新前端无字段时按「无需关注」处理。

## 5. 可配置初始消息数

- 现状：`apps/web/lib/store.ts` `HISTORY_PAGE = 40` **既**用于首次加载（`selectSession` → `claudeSession(id,{limit})`）**又**用于「加载更早」每页。
- 改为：
  - 新增 `INITIAL_MESSAGES`（默认 **10**），仅用于**首次加载**。
  - 「加载更早」每页保持 **40**（`HISTORY_PAGE` 不变）。
- 配置方式（与 `AGENT_HTTPS_PORT` 同套路，构建期注入）：
  - 根 `.env`：`INITIAL_MESSAGES=10`。
  - `scripts/dev-control.sh` 读取并在 `next build/dev` 注入 `NEXT_PUBLIC_INITIAL_MESSAGES`。
  - `store.ts`：`const INITIAL_MESSAGES = Number(process.env.NEXT_PUBLIC_INITIAL_MESSAGES) || 10;`
  - `.env.example` / README 配置表补该项。

## 6. 非目标

- 不改桌面端布局。
- 不引入前端路由库（继续用 `?p=&s=` + 派生态）。
- 删除会话、用量趋势页（方案 C）等本期不做（`...` 留删除入口位）。
- 不改腾讯云/FunASR ASR 链路。

## 7. 验收标准

1. 手机端打开默认进**监控台**，三组（待你处理/运行中/最近）+ 概览条正确呈现。
2. 一个会话出现 AskUserQuestion 时，**不点进**即在「待你处理」出现，点击直达。
3. 点会话进详情页：底部 Tab 消失、顶栏为 `<` 返回；返回回到原 Tab。
4. Sessions 页顶部可切项目；Settings 页可断开、改默认权限。
5. 桌面端外观/交互不变。
6. 会话首屏渲染 10 条；「加载更早」每次 +40；`INITIAL_MESSAGES` 改值并重新 `make start` 后生效。
7. `pnpm test` / `pnpm typecheck` 全绿（含新增 schema 字段的解析测试）。

## 8. 影响文件（预估）

- `packages/shared/src/schemas.ts`：`ClaudeSession.attention`。
- `packages/local-agent/src/claude-store.ts`（+ `util/claude-*`）：计算 `attention`；相关测试。
- `apps/web/app/page.tsx`：移动端导航重构（Tab/详情切换）。
- 新增 `apps/web/components/`：`BottomTabs`、`Dashboard`、`SettingsPage`（及会话详情头部 `<`/`...`）。
- `apps/web/lib/store.ts`：`mobileTab` 状态、`INITIAL_MESSAGES`。
- `scripts/dev-control.sh`、`.env.example`、`README.md`：`INITIAL_MESSAGES` 注入与文档。

## 9. 待确认

- `...` 溢出菜单第一期具体项（建议：会话信息 + 复制 id + 断开；删除留位后续）。
- 「最近」分组在监控台展示条数上限（建议 5–8，超出跳 Sessions）。
- 概览条「今日花费」口径（按 `usage-cache` 当日累计）。
