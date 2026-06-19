# Change Log — 合并发送按钮(去掉 `<>`,纸飞机智能路由)

日期: 2026-06-20

## 背景

输入框右侧曾有两个发送相关按钮:纸飞机(原生发送=手机 agent 接管/续写)与 `<>`
(发到桌面 VSCode 会话=注入到已打开的桌面窗口)。用户反馈两个按钮易混淆,期望"一个
发送按钮就够了"。

二者本质不同:原生发送对"正开在桌面 VSCode 的活跃会话"只会触发**接管**(409→弹框),
无法直发桌面;`<>` 才是把文字注入到那个桌面窗口继续。故不是简单删除,而是**合并为一个
智能发送**。

## 改动文件

- `apps/web/components/Composer.tsx`:删除 `VscodeBtn` 及 `onSendToVscode` prop 与两处渲染。
- `apps/web/app/page.tsx`:`handleSend` 智能路由;`composerLocked`/placeholder 调整。

## 核心变更

- **一个发送按钮**(纸飞机)。当前会话满足"桌面可控"时,发送自动**注入到桌面 VSCode
  会话**(继续在桌面窗口跑,响应经 tail 同步回手机);否则走原生 agent 发送/接管。
- "桌面可控"判定收紧到**会话级**:`selectedHasVscode`(项目有 VSCode 窗口)**且**
  `ideBadgeFor(ideState, selectedId) !== null`(该会话此刻确在桌面以 tab/终端形式存活)。
  仅项目恰好开着 VSCode、但本会话是手机驱动的,不会被误路由到桌面。
- **解锁**:桌面可控会话不再因 externalLive 锁住输入框(原本要求先接管);因为发送走注入,
  无需接管。显式 takeoverArmed 时仍走接管(保留逃生口)。
- 带图片发送回退到 agent 路径(注入只发文本)。
- placeholder 在桌面可控时提示"发送到桌面 VSCode 会话…"。

## 影响范围

- 仅前端;复用既有 store `sendToVscode`;Composer 失败返回 false 时由其既有逻辑恢复草稿。

## 追加:桌面会话带图片的明示接管

桌面注入是**纯文字**(模拟键盘),无法把图片递进桌面 Claude Code 会话;图片只能走手机
agent 路径。原先"带图片静默回退 agent"易被误以为发送失败。改为:

- 桌面可控会话 + 带图片发送时,弹**明确确认框**(`🖼 图片需经手机发送` / "将通过手机接管该
  会话来发送图片"),确认后才走 `force` 接管发送。
- 用基于 Promise 的确认:`handleSend` await 弹框结果。取消 → 返回 false → composer 既有逻辑
  **恢复文字 + 图片**(不丢输入);确认 → 接管发送并清空。
- `ConfirmTakeover` 参数化(可选 title/detail/confirmLabel,默认值不变),复用于此场景。

## 验证

- web typecheck 干净、build 成功。
- 逻辑:新建会话/手机驱动会话 → 纸飞机走 agent;会话在桌面 VSCode 存活(纯文字)→ 纸飞机
  注入桌面;桌面会话带图片 → 明示确认后接管发送;显式接管 → 走 resume。
