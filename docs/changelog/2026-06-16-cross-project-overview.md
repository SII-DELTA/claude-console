# 监控台跨项目总览 + 聚焦 + 顶部切换栏 Change Log

- 日期: 2026-06-16
- spec: `docs/specs/2026-06-16-monitor-dashboard-ux-spec.md`
- plan: `docs/plans/2026-06-16-monitor-dashboard-ux-plan.md`（阶段二）

## 背景

监控台原为「单活动项目」作用域，且无明确聚焦语义。用户期望：**默认看全部项目，
选择/切换项目才算聚焦过滤**；并优化项目切换交互。

## 核心变更

- **默认跨项目总览**：新增后端 `listAllSessions()`（扫描所有项目目录，meta-only）与
  `GET /claude/sessions/all`；前端 `allSessions` + `loadAllSessions()`，监控台默认展示
  全部项目的「需处理/运行中/最近完成」。
- **聚焦过滤**：`dashboardFocus`（null=全部）。点顶部项目 pill 进入聚焦（本地按 cwd 过滤），
  「全部」一键返回。打开他项目会话时，`openFromDashboard` 先 `switchProject` 再打开，
  保证 detail/driver 路径正确解析。
- **顶部切换栏（三者结合）**：sticky 横向 pill 栏 + 每项目 `运行N/待处理M` 活动徽章；
  项目 >6 时出现搜索框；监控台主体左右 swipe 在 [全部, …项目] 间切换聚焦。
- **watcher 扩到 projectsRoot**：会话文件监控由「仅活动项目目录」改为整个
  `~/.claude/projects`（depth 1），使跨项目总览实时更新；切项目不再重启 watcher
  （消除重启窗口丢行风险）。

## 改动文件

- `packages/local-agent/src/claude-store.ts`：`listAllSessions()`/`allSessionFiles()`；
  `start()` 监控 projectsRoot；移除 `restart()` 及切项目时的重启调用。
- `packages/local-agent/src/http-server.ts`：`GET /claude/sessions/all`。
- `apps/web/lib/api.ts`：`claudeAllSessions()`。
- `apps/web/lib/store.ts`：`allSessions`/`dashboardFocus`/`loadAllSessions`/`setDashboardFocus`；
  WS `session_updated`/`driving` 同步 upsert `allSessions`；连接重置/初始化加载。
- `apps/web/app/page.tsx`：轮询追加 `loadAllSessions`；Dashboard 传 `allSessions`/`focus`；
  `openFromDashboard` 跨项目切换。
- `apps/web/components/Dashboard.tsx`：`ProjectBar`（pill+徽章+搜索）替换底部 chip；
  聚焦过滤 `view`；主体 swipe 切聚焦。

## 影响范围

- 监控台默认显示全部项目；Sessions/Settings 页与桌面端布局不变。
- watcher 覆盖面变大（用户本机，可接受）。
- 新端点/字段向后兼容。

## 验证

- `pnpm typecheck` 全绿。
- `@mac/local-agent` 113 测试 + `@mac/web` 22 测试通过。
- 待手测：默认见全部项目；点 pill 聚焦/「全部」返回；徽章计数正确；他项目会话点开能正确加载；左右滑切聚焦。
