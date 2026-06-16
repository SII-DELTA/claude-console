# 监控台重连/回前台自动重拉会话列表 Change Log

- 日期: 2026-06-16

## 现象
agent 重启（make restart）后，监控台卡片"彻底消失"。

## 根因
WS 重连 / 回到前台时只恢复了「选中会话」的 tail，**没有重新拉取会话列表**。
agent 下线期间若客户端正好轮询或刚打开，`loadAllSessions` 失败被静默吞掉，
`allSessions` 变空；重连后又不刷新列表，加上移动端后台冻结定时器（20s 轮询不触发），
卡片就一直空白。后端/数据其实正常（接口能返回 74 条会话）。

## 修复
- WS `onOpen`：重连即重拉 `loadProjects` + `loadSessions` + `loadAllSessions`。
- `handleVisible`（回前台）：socket 仍在时也刷新会话列表（之前只刷 tail）。

## 改动文件
- apps/web/lib/store.ts：connectWs.onOpen、handleVisible 增加列表重拉。

## 验证
- web typecheck + 22 测试通过。
- 手测：agent 重启后监控台自动恢复卡片，无需手动刷新。
