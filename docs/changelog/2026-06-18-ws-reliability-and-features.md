# WS/会话可靠性重构 + Tab 卡片 + 文件预览

- 日期: 2026-06-18
- 关联 spec: 2026-06-18-ws-hint-http-cursor-sync / askuserquestion-tab-card-picker / chat-file-link-preview
- 关联 plan: 2026-06-18-ws-and-session-reliability-plan

## 提交划分与核心变更

### C1 后端高危修复(会话被误杀 / 运行误判)
- `claude-driver.ts`:空闲定时器改走 `reapIfIdle()`,busy 进程绝不杀、重新 arm;`delta` 也 `touch()` 续命。修复"长轮(>5min)被空闲回收器从中途 SIGTERM"。
- `session-liveness.ts`:启动即 `reap()`;判 dead 删磁盘 state 文件;间隔 45s→20s;busy 卡死(无 currentTool 且 10min 无新事件)兜底降级。

### C2 后端字节游标增量接口(方案 A)
- `claude-store.ts`:新增 `tail(id, fromByte)`(复用 readRange 残行/截断),`getSession` 返回 end-of-file `cursor`。
- `http-server.ts`:`GET /claude/sessions/:id/tail?cursor=`。
- `shared/schemas.ts`:detail 加可选 `cursor`,新增 `ClaudeSessionTailResponseSchema`。

### C3 前端 WS 提示 + HTTP 游标权威同步
- `api.ts`:`claudeSessionTail`。
- `store.ts`:`syncTail`(增量 upsert + 刷新权威 driving/isLive + 漏收 drive_done 时收尾)、`tailCursor`、`syncOpenSession`;触发点=20s 轮询 / 当前会话 session_updated / 重连 / 回前台;`handleVisible` 后台超 15s 不信 readyState 强制重连。
- `ws.ts`:客户端心跳 20s→12s。
- `page.tsx`:`online`/`pageshow` 触发重连兜底;轮询带 syncOpenSession。

### C4 AskUserQuestion Tab 卡片 + 折叠 + 布局加固
- `QuestionPanel.tsx`:单题视图 + 顶部 tab(已答✓/点击切换/单选自动前进/单题退化)+ 折叠;✕ 与折叠按钮结构化进头部行(不再 absolute),标题 min-w-0+break-words、tab truncate。
- `ToolApprovalPanel.tsx`:头部同样加固。

### C5 聊天文件链接预览(1A 代码块识别 + 2A 限 cwd 子树)
- `http-server.ts`:`GET /files/preview?cwd=&path=`,严格 cwd 子树校验、大小上限、二进制/图片识别。
- `Markdown.tsx`:行内代码路径识别 → 可点击;`OpenFileContext` 由 Timeline 提供。
- `FilePreview.tsx`:全屏预览(md/文本/图片/二进制),`:line` 显示。
- `api.ts`:`previewFile`;`page.tsx`:点击 → 覆盖层(按 selected.cwd 解析)。

## 影响范围
- agent: claude-driver / session-liveness / claude-store / http-server。
- shared: schemas。
- web: api / store / ws / page / Timeline / Markdown / QuestionPanel / ToolApprovalPanel + 新增 FilePreview。

## 验证结果
- `pnpm --filter @mac/shared build` 通过。
- `pnpm --filter @mac/local-agent typecheck` 通过;119 测试全过。
- `pnpm --filter @mac/web typecheck` 通过;22 测试全过。
- 待真机手测:断网/锁屏/切后台后自动补消息、长轮不再被关、Tab 卡片折叠、点击文件预览。

## 未完成(单列待办)
- 方案 A §5 可选增强:inflight 实时光标续显(driver 累积 partial + /inflight 接口 + 前端 follow 模式)。
