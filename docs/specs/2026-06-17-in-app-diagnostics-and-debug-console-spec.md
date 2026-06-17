# 设置页内置「通知诊断 + 调试控制台」Spec

- 日期: 2026-06-17
- 状态: 已确认方案 C(诊断面板 + 可选调试控制台)
- 背景: 用户在 HTTPS 环境下「通知全开却收不到」,且为手机/PWA 环境无法打开浏览器 DevTools,需要在 App 内自助排查。

## 目标

1. 在设置页提供「通知诊断」面板:一键采集并展示通知链路的全部关键状态,并内置修复操作按钮。
2. 在设置页提供「调试控制台」开关:开启后页面浮出可查看 `console.*` 日志、网络请求、全局错误的面板。

## 非目标

- 不接入第三方调试库(eruda/vConsole):本应用常在局域网/离线 PWA 环境运行,CDN 不可靠;npm 引入体积偏大。改为自带零依赖轻量实现。
- 不做日志持久化/上传。仅内存环形缓冲(进程内)。

## 方案 A:通知诊断面板

新增 `DiagnosticsSection`(置于设置页「推送通知」之后),展示如下状态行(带 ok/警告 配色):

| 字段 | 来源 | 期望 |
|---|---|---|
| 安全上下文 | `window.isSecureContext` | true |
| 通知 API | `"Notification" in window` | true |
| 通知权限 | `Notification.permission` | granted |
| SW 支持 | `"serviceWorker" in navigator` | true |
| SW 已注册 | `navigator.serviceWorker.getRegistration()` | 是 |
| 推送已订阅 | `reg.pushManager.getSubscription()` | 是 |
| 后端推送 | `api.pushVapidPublicKey()` → `enabled` | true |
| 前台通知开关 | localStorage `mac.inAppNotify` | 开 |
| 推送本地标记 | localStorage `mac.pushActive` | 1 |
| 页面是否隐藏 | `document.hidden` | — |

操作按钮:
- **请求通知授权**:`Notification.requestPermission()`,完成后刷新诊断。
- **重新注册并订阅推送**:复用 `enablePush(api)`,失败显示原因。
- **发送测试通知**:直接 `new Notification(...)`(若已授权),并调用前台 `notify()` 触发标题闪烁,验证本地链路。
- **刷新**:重新采集全部状态。

诊断采集逻辑抽到 `lib/notify-diagnostics.ts`,返回结构化对象,便于复用与测试。

## 方案 B:调试控制台

- `lib/debug-log.ts`:
  - `installDebugCapture()` 幂等;拦截 `console.log/info/warn/error`、`window.onerror`/`unhandledrejection`、`fetch`(记录 method/url/status/耗时/错误)。
  - 内存环形缓冲(上限 500 条),`subscribe(cb)` / `getEntries()` / `clear()`。
  - 拦截保持原始行为透传(仍调用原 `console`/`fetch`)。
- `components/DebugConsolePanel.tsx`:浮层面板,Tab 切「日志 / 网络」,支持清空、关闭;底部浮动入口按钮。
- 开关存 localStorage `mac.debugConsole`;在 `app/page.tsx` 全局挂载(开启时渲染面板并安装拦截)。设置页加 Toggle 控制。

## 验收

- 诊断面板能在手机上看到全部字段,值随实际状态变化;三个操作按钮可用。
- 开启调试控制台后,能看到应用产生的 console 日志与网络请求;关闭后浮层消失。
- typecheck 通过。

## 风险

- `fetch` 拦截需谨慎避免影响既有请求行为(只读记录,保持透传与异常冒泡)。
- 自带控制台为简化实现,功能弱于 DevTools,仅覆盖 console/network/error。
