# 2026-06-16 通知大改：Web Push 后台推送 + 铃铛→Tab 徽章 + 卡片右滑忽略

## 背景
旧通知用页面级 `new Notification()`：iOS PWA 根本不支持（内外都不弹），且 store/page 两处都弹（会话内冗余）；文案/图标也粗糙。状态栏铃铛形同虚设。

## 改动
**① 待处理数 → 底部 Tab 徽章；卡片右滑忽略**（commit 4e8953e）
- 去掉表头铃铛；待处理(等待回答/出错)数移到底部「监控台」Tab 图标右上角徽章（`BottomTabs` 支持 per-tab 徽章）。
- 「需要你处理」卡片支持右滑忽略（滑出 + `dismissQuestion`，本地即时隐藏；轻点仍进会话）。

**② Web Push（Service Worker + VAPID，agent 主动推）**
- agent：`push-manager.ts` 首启生成/持久化 VAPID（`storagePath/push-vapid.json`），按需推送，410/404 失效订阅自动清理，同会话同类型 8s 内去重；`history-store` 加 `push_subscriptions` 表；路由 `GET /push/vapid-public-key`、`POST /push/subscribe`、`POST /push/unsubscribe`；runtime 在 `permission_request`(需回答)/`drive_done`(完成)/`drive_error`(出错) 事件推送（标题取会话名缓存）。依赖 `web-push`。
- web：`public/sw.js`（push→showNotification，icon-192/tag=sessionId；可见窗口正看该会话则不弹；点按聚焦并打开会话）；`lib/push.ts`（注册 SW / 取 VAPID / 申请权限 / 订阅 / 上报 / 退订 / iOS standalone 检测）；Settings 加「推送通知」开关（iOS 提示需 Safari 添加到主屏）。
- 覆盖安卓/桌面 Chrome·Firefox + iOS 16.4+ PWA；`web-push` 统一发送，不分平台。

**③ 修冗余 + 文案/图标**
- `lib/notify.ts`：仅在**页面不可见**时弹（消除会话内冗余）；Web Push 激活时让位给 SW（不双弹）；图标改 `icon-192`。
- 推送文案：标题=会话名，正文=「需要你回答 / 已完成一轮 / 执行出错…」。

## 平台说明
- iOS：所有浏览器底层都是 WebKit，**仅「添加到主屏」的 PWA 能推**，且可靠路径是 Safari 添加；浏览器标签页（含 iOS Chrome）不支持。安卓无此限制。

## 验证
- shared 15 + web 21 + local-agent 102 = 138 测试全绿（新增 push-manager/订阅 CRUD 5 例）；全包 typecheck 通过；web build 成功。
- 推送测试用 `:memory:` VAPID，不落盘、不联网；不触碰真实配置。
