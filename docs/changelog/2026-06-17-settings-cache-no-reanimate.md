# Settings 状态缓存:重开不再重走动画

- 日期: 2026-06-17

## 背景

Settings 为条件渲染,切走即卸载;每次重开各 Toggle 从默认值异步翻到真实值、诊断面板从「采集中…」闪到数据,视觉上每次都「走一遍动画」。

## 改动文件

- `apps/web/lib/push.ts`:新增 `cachedPushStatus` + `getCachedPushStatus()`,`getPushStatus()` 写缓存。
- `apps/web/lib/notify-diagnostics.ts`:新增 `cachedDiagnostics` + `getCachedDiagnostics()` + `diagnosticsEqual()`,采集结果写缓存。
- `apps/web/components/SettingsPage.tsx`:
  - PushSection:`status` 用缓存惰性初始化,后台刷新仅在值变化时 setState。
  - DiagnosticsSection:`d` 用缓存惰性初始化,refresh 用 `diagnosticsEqual` 比较,数据无变化不 setState。
  - GeneralSection:`inApp`/`dbg` 改为同步惰性初始化(localStorage),去掉 useEffect 翻转。

## 核心变更

- 首次打开仍异步采集;之后重开直接渲染上次缓存值,Toggle 不再从默认值翻转,诊断不再闪「采集中…」。
- 后台刷新只有数据真正变化才更新 UI(值相等时复用旧 state,避免无谓重渲染/动画)。

## 影响范围

- 仅 web 设置页;Settings 子树在 hydration 后才渲染(page.tsx:32),惰性读 localStorage 无 SSR 水合不匹配风险。

## 验证结果

- `pnpm --filter @mac/web typecheck` 通过。
- 待实测:重复打开/关闭 Settings,开关与诊断保持稳定,仅在实际状态变化时更新。
