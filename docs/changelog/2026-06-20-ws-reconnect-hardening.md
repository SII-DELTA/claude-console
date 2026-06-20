# Change Log — WS 重连加固(退避 + 复活探活 + resume 重置)

日期: 2026-06-20
承接: [phone-resume-disconnect](2026-06-20-phone-resume-disconnect.md) 的遗留健壮性项(审计 S2/S5/退避)

## 改动

- `apps/web/lib/ws.ts`:新增 `WsClient.ping()` —— 主动探活,立即发 ping 并武装 pong 监视。
- `apps/web/lib/store.ts`:重连指数退避 + onOpen/resume 重置 + resume 对"看似存活"的 socket 探活。

## 核心变更

1. **指数退避(替代固定 3s)**:连续重连失败时延迟 `3s→6s→12s→20s(封顶)`;`onOpen` 成功
   或前台 resume 时重置为 0。避免 agent 长时间宕机/网络长断时每 3s 猛打重连。
2. **resume 立即重连且重置退避**:用户切回前台触发 `connectWs` 前 `reconnectAttempts=0`,
   保证返回时立刻新鲜重连,不被退避拖延。
3. **resume 探活(S5)**:`handleVisible` 在"socket 看似存活"分支调用 `ws.ping()`。后台期间
   服务端 30s 心跳可能已 terminate 这条 socket,但客户端冻结导致 `close` 未派发 → readyState
   仍是 OPEN(zombie)。主动 ping 让下一个心跳 tick 内即可发现死链并重连;同分支的 HTTP
   `syncTail` 立即兜底拉取,双保险。

## 关于 S2(800ms 合并窗)

复核认为低危、现状正确:`handleVisible` 的 `document.hidden` 提前返回分支**不更新**
`lastResumeAt`,因此一簇 resume 事件(visibilitychange/online/pageshow)中**第一个可见态调用
必然 proceed**,后续同 tick 重复被正确去重,不会吞掉真正的重连。未改动。

## 影响 / 验证

- 仅前端;web typecheck 干净、build 成功。
- 与上一修复(fast 轮询保活 + 跨项目查找)叠加:
  - 前台/短后台:fast 轮询保活 + WS,正常实时。
  - 长后台返回:resume 立即重连(退避已重置)+ 探活旧 zombie + HTTP tail 兜底收尾。
  - agent 宕机:重连退避到 20s,恢复时下一次尝试即连上(或 resume 立即连)。
