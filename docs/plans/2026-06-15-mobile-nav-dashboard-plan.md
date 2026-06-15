# 移动端导航重构 + 监控台 + 可配置初始消息数 Plan

- 日期: 2026-06-15
- Spec: [2026-06-15-mobile-nav-dashboard-spec.md](../specs/2026-06-15-mobile-nav-dashboard-spec.md)
- 原则: 自底向上、每步可独立提交、随做随测。桌面端不变。

## 步骤

### 1. shared：会话 `attention` 字段
- `packages/shared/src/schemas.ts`：`ClaudeSessionSchema` 加 `attention: z.enum(["question","error","done"]).optional()`。
- 验证：`pnpm --filter @mac/shared test` / typecheck。

### 2. agent：ClaudeStore 计算 `attention`
- `claude-store.ts`：构建会话元数据时，从已解析消息（或 jsonl 末尾）计算：
  - `question`：最后一个 assistant turn 含 `AskUserQuestion` 的 `tool_use` 且其后无非错误 `tool_result`。
  - `error`：最近驱动以错误结束（结合 driver 状态 / 末尾 result.is_error）。
  - `done`：非 live 且最后事件为 assistant turn 完成。
  - 否则不设。
- 复用现有 jsonl 解析（`util/claude-jsonl`）。已 `ClaudeStore` 在 listSessions 时有完整消息计数逻辑，可在同处计算。
- 测试：`claude-store.test.ts` 加用例（含 AskUserQuestion 末尾 → question；普通结束 → done）。

### 3. 前端 store：`mobileTab` + `INITIAL_MESSAGES`
- `lib/store.ts`：
  - `INITIAL_MESSAGES = Number(process.env.NEXT_PUBLIC_INITIAL_MESSAGES) || 10`；`selectSession` 首次加载用它；`loadEarlier` 仍用 `HISTORY_PAGE=40`。
  - 加 `mobileTab: "dashboard"|"sessions"|"settings"`（默认 dashboard）+ `setMobileTab`。

### 4. 前端组件
- `components/BottomTabs.tsx`：3 个 tab（监控台/Sessions/Settings），当前态高亮，`pb-safe`，详情页隐藏。
- `components/Dashboard.tsx`：三组（待你处理/运行中/最近 5）+ 空态；点卡片 `onOpen(id)`。
- `components/SettingsPage.tsx`：连接信息、断开、默认权限选择、版本。
- `components/SessionList.tsx`：Sessions tab 复用；顶部项目选择器（抽离 `page.tsx` 的 `Brand` 项目下拉为可复用 `ProjectPicker`）。

### 5. page.tsx：移动端导航接线
- `<md`：根据 `selectedId`：有 → 会话详情（顶栏 `<` 返回 + 标题 + `...`，隐藏 BottomTabs）；无 → 按 `mobileTab` 渲染 Dashboard/Sessions/Settings + BottomTabs。
- `<` = `selectSession(null)`。`...` 菜单：会话信息/复制 id/断开。
- `md+`：保持现有 sidebar + chat 完全不变。

### 6. INITIAL_MESSAGES 注入与文档
- `scripts/dev-control.sh`：读根 `.env` 的 `INITIAL_MESSAGES`，`next dev/build` 注入 `NEXT_PUBLIC_INITIAL_MESSAGES`。
- `.env.example` + `README` 配置表补 `INITIAL_MESSAGES`。

### 7. 测试 + 验证
- `pnpm typecheck` 全绿；`pnpm test`（shared/local-agent/web）全绿，必要时补 web 测试。
- 验证：起 dev，移动视口下检查 tab 切换 / 监控台分组 / 详情返回 / 首屏 10 条；桌面端回归不变。
- change log + commit（分步提交）。

## 风险
- ClaudeStore 计算 attention 不要拖慢 listSessions（基于已解析数据，不额外重扫整文件）。
- 移动端重构集中在 page.tsx，注意不影响桌面分支与既有 WS/滚动逻辑。
