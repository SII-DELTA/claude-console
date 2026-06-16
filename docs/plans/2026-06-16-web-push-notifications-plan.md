# Plan: Web Push 通知（Service Worker + VAPID，跨 iOS/安卓/桌面）

- 日期: 2026-06-16
- 决策: 通知范围 = **Service Worker + Web Push**（agent 主动推，后台/关闭也能收）。
- 平台: 安卓/桌面 Chrome·Firefox 全支持；iOS 16.4+ 需「添加到主屏」PWA（已满足）。`web-push` 统一发送，不分平台。

## 默认取舍（如不合适可改）
- VAPID 密钥：agent 首启生成一对，持久化到 `storagePath/push-vapid.json`（仅本机）。
- 订阅存储：sqlite（history-store 新表 `push_subscriptions`）。
- 触发事件：`claude:drive_done`（完成）、`claude:permission_request`/question attention（需回答）、`claude:drive_error`（出错）。
- 防冗余：SW `push` 事件里 `clients.matchAll` 检查——若有**可见**窗口且正看该会话，则不弹。
- 鉴权：订阅/取消订阅走与现有 API 相同的鉴权（bearer / 开放模式）。

## 组件
1. **shared/schemas**：`PushSubscriptionSchema`（endpoint/keys）。
2. **local-agent**
   - `push-manager.ts`：加载/生成 VAPID；增删订阅；`notify({sessionId,title,body,kind})` → 遍历订阅 `webpush.sendNotification`，410/404 自动清理失效订阅。
   - `history-store`：`push_subscriptions` 表 + CRUD。
   - http 路由：`GET /push/vapid-public-key`、`POST /push/subscribe`、`POST /push/unsubscribe`。
   - runtime：建 PushManager；订阅 bus 事件 → 组装文案 → push（带去重节流：同会话同 kind 短时间只推一次）。
   - 依赖：`web-push`。
3. **web**
   - `public/sw.js`：`push`→showNotification（icon-192、tag=sessionId、data.sessionId、可见窗口看同会话则跳过）；`notificationclick`→focus 或 openWindow 到 `/?s=<id>`。
   - `lib/push.ts`：注册 SW、取 VAPID 公钥、`Notification.requestPermission`（用户手势）、`pushManager.subscribe`、上报订阅；退订。
   - Settings 页：「推送通知」开关（显示权限状态；iOS 提示需先加到主屏）。
   - `lib/notify.ts`：仅在 `document.hidden` 时弹页面级通知（桌面前台兜底），消除会话内冗余；文案/图标统一。
4. **文案/图标**：标题=会话名；正文=「需要你回答」/「已完成一轮」/「执行出错」；icon=`/icon-192.png`。

## 测试
- push-manager：订阅增删、失效(410)清理、节流去重（mock webpush.sendNotification）。
- history-store：push_subscriptions CRUD。
- http：subscribe/unsubscribe/vapid 路由（mock）。

## 边界
- iOS 必须先「添加到主屏」并授予权限；Settings 给出提示。
- 仅 macOS/Linux agent（与 hooks 一致）；web-push 纯 Node，跨平台无碍。
