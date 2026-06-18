# WS/会话可靠性 + 文件预览 + Tab 卡片 总 Plan

- 日期: 2026-06-18
- 对应 spec:
  - 2026-06-18-ws-hint-http-cursor-sync-spec.md(方案 A + ③ + ④/4a-4c + §5 光标 + §6 加固)
  - 2026-06-18-askuserquestion-tab-card-picker-spec.md
  - 2026-06-18-chat-file-link-preview-spec.md

## 待定点处置(本次实现采用推荐默认)

- 待定 1(loading 来源):用权威 `session.driving`(syncTail 刷新),去掉盲超时;streaming 仅本地解锁用,syncTail 发现 `driving=false` 且本地仍 streaming 则 endTurn 收尾。
- 待定 2(频率):打开会话在 20s 轮询里 syncTail(字节游标,O(新增字节),便宜);另由 WS 提示/重连/前台/网络事件触发。

## 提交划分

- **C1 后端高危修复(④ 4a/4b/4c)**:claude-driver `reapIfIdle` + delta touch;session-liveness 启动即 reap、删死文件、间隔 20s、busy 卡死兜底。
- **C2 后端增量接口(方案 A)**:claude-store 加 `tail(id, fromByte)`(复用 readRange 残行/截断)+ getSession 返回起始 `cursor`;http-server 加 `/claude/sessions/:id/tail`。
- **C3 前端同步(方案 A + ③ + §6)**:api `claudeSessionTail`;store `tailCursor`/`syncTail`/触发点/driving 同步/streaming 收尾;ws 心跳 12s;page online/pageshow;handleVisible 不信 readyState。
- **C4 Tab 卡片**:QuestionPanel 重写(tab+折叠+布局);ToolApprovalPanel 头部加固。
- **C5 文件预览**:http-server `/files/preview`;api `previewFile`;Markdown 路径识别+cwd;FilePreview 组件。

每步 `pnpm --filter @mac/web typecheck` + 后端构建/测试,逐个 commit。
