# 设置页内置「通知诊断 + 调试控制台」Plan

- 日期: 2026-06-17
- 对应 spec: docs/specs/2026-06-17-in-app-diagnostics-and-debug-console-spec.md

## 改动清单

### 新增文件

1. `apps/web/lib/notify-diagnostics.ts`
   - `export type NotifyDiagnostics = {...}`
   - `export async function collectNotifyDiagnostics(api): Promise<NotifyDiagnostics>`
   - `export async function sendTestNotification(): Promise<void>`(本地通知 + notify 标题闪烁)

2. `apps/web/lib/debug-log.ts`
   - 类型 `DebugEntry`(kind: log/info/warn/error/network)
   - `installDebugCapture()` 幂等安装拦截
   - `subscribe`/`getEntries`/`clearEntries`
   - localStorage 开关 `getDebugConsole()`/`setDebugConsole()`(key `mac.debugConsole`)

3. `apps/web/components/DebugConsolePanel.tsx`
   - 浮动入口 + 面板(日志/网络 Tab、清空、关闭)
   - 订阅 debug-log,自动刷新

### 修改文件

4. `apps/web/components/SettingsPage.tsx`
   - 新增 `DiagnosticsSection`(诊断面板,放在 PushSection 之后)
   - 在 GeneralSection 或新增 section 中加「调试控制台」Toggle

5. `apps/web/app/page.tsx`
   - 全局挂载 `<DebugConsolePanel />`(根据开关渲染)

## 步骤

1. 写 `lib/debug-log.ts`(纯逻辑,先于 UI)
2. 写 `lib/notify-diagnostics.ts`
3. 写 `components/DebugConsolePanel.tsx`
4. 改 `SettingsPage.tsx` 加诊断面板 + 控制台开关
5. 改 `page.tsx` 挂载面板
6. `pnpm --filter @mac/web typecheck`
7. change log + commit

## 验证

- typecheck 通过
- 手动:设置页诊断面板字段齐全;开调试控制台能看到日志/网络
