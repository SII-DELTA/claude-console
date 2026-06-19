# Change Log — 桌面会话发送路由设置(原生/接管/自动)

日期: 2026-06-20
spec/plan: [spec](../specs/2026-06-20-desktop-route-settings-spec.md) · [plan](../plans/2026-06-20-desktop-route-settings-plan.md)

## 背景

发送按钮合并后,"会话开在桌面 VSCode 时注入桌面(原生) vs 手机接管(resume)"是写死的。
本次做成 Settings 可配置,默认尽量走桌面原生。

## 确认的决定

- **2 类**(按 `ideBadgeFor` 可靠判定):活跃会话(已在桌面运行)/ 未活跃旧会话。
- 每类 3 模式:自动 / 原生 / 接管。**自动 = 两类都原生**(用户选定)。
- 新会话恒走手机 agent;图片走接管确认;全局存储。

## 改动文件

- `apps/web/lib/store.ts`:`DesktopRouteMode`/`DesktopRouteCategory` 类型;`getDesktopRoute`/
  `setDesktopRoute`(localStorage `mac.desktopRoute.active|inactive`);纯解析 `desktopModeIsNative`
  + `routeSendNative`。
- `apps/web/app/page.tsx`:`routeNative = routeSendNative(...) && !armed` 取代旧 `desktopControllable`;
  `composerLocked`/placeholder 随之;handleSend 按 routeNative 注入桌面,失败 `setError` 提示且
  返回 false(不静默接管,保留草稿)。
- `apps/web/components/SettingsPage.tsx`:`VscodeSection` 增两个分段控件(活跃/未活跃会话)+ 说明
  文案;更新已失效的 "→VSCode 按钮" 旧描述。
- `packages/local-agent/src/claude-store.ts`:新增 `cwdOfSession(id)`(跨项目从 JSONL 解析 cwd)。
- `packages/local-agent/src/http-server.ts`:`/ide/inject` 服务端解析 cwd(hook state 优先,缺失回退
  JSONL 目录),传给 inject;仍不收调用方 cwd。
- `packages/local-agent/src/ide-control.ts`:`injectToSession` 接受服务端解析的可选 `cwd`。

## 关键边界处理

- **B 类原生取 cwd**:未活跃旧会话的 hook state 可能已被清理 → cwd 回退到会话 JSONL 所在目录
  (`resolveSessionFile` + 缓存 meta),仍服务端自证。
- **不可达回退**:非 mac/远程/无窗口时 ideState 为空 → `routeSendNative` 自然返回 false → 走 agent。
- **native 运行失败**:不静默接管,提示并保留草稿。
- 图片永远接管确认;显式武装接管优先于设置。

## 测试 / 验证

- 新增 web 单测 `routeSendNative`(纯解析 + 守卫);agent 单测 `cwdOfSession`(跨项目/JSONL/不存在)。
- agent 126 测试通过;web 26 测试通过;两端 typecheck 干净;web build 成功。

## 非目标

- 不做"原生新建会话";不做按项目配置(先全局)。
