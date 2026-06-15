# 2026-06-15 移动端导航重构（监控台 + 底部 Tab + 栈式会话页）+ 可配置初始消息数

Spec/Plan: [spec](../specs/2026-06-15-mobile-nav-dashboard-spec.md) · [plan](../plans/2026-06-15-mobile-nav-dashboard-plan.md)

## 核心变更

### 后端：会话 attention 元数据
- `packages/shared/src/schemas.ts`：`ClaudeSession` 加 `attention: "question"|"error"|"done"`（可选）。
- `packages/local-agent/src/util/claude-jsonl.ts`：accumulator 追踪未应答 `AskUserQuestion`（`openQuestionIds`）与 `lastRole`；新增 `deriveAttention(acc, isLive)`。
- `packages/local-agent/src/claude-store.ts`：`buildSession` 填充 `attention`。
- `error` 由 driver 运行时产生，本期未从 jsonl 推断（schema 已预留）。

### 前端：移动端导航
- 新增 `components/BottomTabs.tsx`（监控台/Sessions/Settings）、`Dashboard.tsx`（待你处理=question/error · 运行中=isLive · 最近 5）、`SettingsPage.tsx`（连接/断开 + 默认权限）。
- `app/page.tsx`：移动端 `<md` 改为栈式——无会话显示底部 Tab 主页；选中/新建会话进入全屏详情（顶栏 `☰`→`<` 返回 + `...` 菜单：复制 id/刷新/断开），详情态隐藏底部 Tab。移除废弃移动抽屉。
- `lib/store.ts`：新增 `mobileTab` 状态。
- 桌面端 `md+` 侧栏主从布局**不变**。

### 可配置初始消息数
- `lib/store.ts`：`INITIAL_MESSAGES = NEXT_PUBLIC_INITIAL_MESSAGES || 10`，仅首屏；「加载更早」每页仍 40。
- `scripts/dev-control.sh`：从根 `.env` 读 `INITIAL_MESSAGES`，构建/启动 web 时注入 `NEXT_PUBLIC_INITIAL_MESSAGES`。
- `.env.example` / `README` 配置表补 `INITIAL_MESSAGES`。

## 影响范围

- 移动端交互大改（导航模型从抽屉改为 Tab + 栈）；桌面端无变化。
- 会话列表 API 多返回 `attention` 字段（向后兼容，可选）。
- `make start` 起的 agent 不再硬编码 `NO_AUTH/0.0.0.0`（上一提交），与本次配套。

## 验证结果

- `pnpm typecheck` 全绿（shared / local-agent / web）。
- `pnpm test` **110** 全绿（shared 15 + local-agent 77 + web 18），含 `deriveAttention` 三用例。
- web `next build` 成功；临时端口 `next start` 返回 200，构建产物含「监控台/Sessions」。
- 临时 agent 实测真实会话：`/claude/sessions` 正确返回 `attention`（`question` / `done` 各一），`/health` 返回 `auth:"none"`。
- 未做：浏览器内移动视口实拍（本机未装 playwright、3005/7345 被现有实例占用）。
