# Change Log — 优化批次(R1 / F2 / P1 / F1)

日期: 2026-06-20

用户征询"还有什么值得优化",选定四项,逐个实现:

## R1 · driving 竞态加固 + 连接文案(commit da95b0e)
- `driving` 防闪窗在每个 streaming delta 刷新(turn 期间连续保护,延迟/乱序 `session_updated`
  快照不能把 driving revert false);`claude_driving=false` 清窗让真实下线及时落地。
- `ConnDot` 断开时显示脉冲黄点 + "重连中…",用户知道为何暂停更新。

## F2 · 草稿按会话持久化(commit e78fe84)
- Composer 新增 `persistKey`:进入会话载入草稿,离开/卸载/pagehide 保存,发送成功清除、失败保留。
  按 `mac.draft.<sessionId>` 存 localStorage;在"离开时保存"避免每次按键写盘与跨 key 串写。

## P1 · Timeline content-visibility 离屏跳过(commit 569b6e1)
- 每个时间线分组加 `content-visibility:auto` + `contain-intrinsic-size:auto 120px`,浏览器跳过
  离屏分组布局/绘制并记住真实高度。所有节点仍在 DOM,不影响 load-earlier/滚到底的 scrollHeight,
  零回归;长会话滚动明显变顺。Safari 18+/Chrome 支持。

## F1 · turn 运行时排队输入(本次)
- 先实测确认:Claude Code stream-json 模式下,turn 进行中写入第二条 user 消息会被**排队**、当前回合
  完整跑完后再处理(实测:TCP 长文未被打断 → 随后回答"蓝色")。官方未文档化,故以实测为准。
- 但为不动刚加固的流式状态机,采用**客户端排队**:运行中输入的后续消息本地暂存,当前回合结束后经
  **正常 sendPrompt 路径**自动发出(干净的乐观气泡 + 流式,不与 stream 机冲突)。
- UI:运行中 textarea 仍可输入,发送按钮变为幽灵"排队"按钮(中断按钮保留);composer 上方显示
  "⏳ 已排队:<text>"可取消;切会话自动清空排队。
- 改动:`apps/web/components/Composer.tsx`(排队发送按钮)、`apps/web/app/page.tsx`(queued 状态/
  handleSend 排队分支/turn 结束自动发/排队 chip)。

## 验证
- 全部 web typecheck 干净、build 成功;F1 的后端排队行为有实测佐证。
