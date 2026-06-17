# 设置页内置「通知诊断 + 调试控制台」

- 日期: 2026-06-17
- 关联: docs/specs/2026-06-17-in-app-diagnostics-and-debug-console-spec.md, docs/plans/2026-06-17-in-app-diagnostics-and-debug-console-plan.md

## 背景

用户在 HTTPS 环境下「通知全开却收不到」,且为手机/PWA 环境无法打开浏览器 DevTools 自助排查。需要在 App 内查看通知链路状态与日志/网络。

## 改动文件

- 新增 `apps/web/lib/debug-log.ts`:零依赖调试日志采集(拦截 console.*/全局错误/fetch,内存环形缓冲 500 条,订阅 + localStorage 开关 `mac.debugConsole` + 变更事件广播)。
- 新增 `apps/web/lib/notify-diagnostics.ts`:`collectNotifyDiagnostics()` 采集通知链路全部状态;`sendTestNotification()` 触发本地通知 + 标题闪烁验证。
- 新增 `apps/web/components/DebugConsolePanel.tsx`:浮动调试面板(日志/网络 Tab、清空、关闭、浮动入口)。
- 改 `apps/web/components/SettingsPage.tsx`:新增「通知诊断」面板(状态行 + 请求授权/重新订阅/发送测试通知/刷新),GeneralSection 加「调试控制台」开关。
- 改 `apps/web/app/page.tsx`:全局挂载 `DebugConsolePanel`,按开关与变更事件实时显隐。

## 核心变更

- 通知诊断:安全上下文 / 通知 API / 通知权限 / SW 支持 / SW 已注册 / 推送已订阅 / 后端推送 / 前台开关 / 推送本地标记 / 页面隐藏,逐项 ok 配色;内置 3 个修复动作按钮。
- 调试控制台:不引入 eruda/vConsole(局域网/离线 PWA 下 CDN 不可靠),改自带轻量实现,console 与 fetch 全部透传不改变原行为。

## 影响范围

- 仅 web 端;新增设置项与浮层,默认调试控制台关闭,不影响既有通知/推送逻辑。

## 验证结果

- `pnpm --filter @mac/web typecheck` 通过。
- 待用户在手机端实测:诊断面板字段、三个操作按钮、调试控制台日志/网络捕获。
