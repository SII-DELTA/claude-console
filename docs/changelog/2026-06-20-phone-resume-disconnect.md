# Change Log — 修复手机接管会话"整会话断开、没回复、不自恢复"

日期: 2026-06-20

## 症状

手机接管(phone-driven resume)一个会话后,跑一会儿"整个会话都断开了、没有回复了",且不自动恢复。

## 根因(经 driver 实测 + 前端审计确认)

后端 driver 健康(进程持久、turn 写入 JSONL、不会中途回收)。问题在前端**双投递路径在后台同时失效**:

1. **回归(S1)**:之前给 slow/fast 两个轮询都加了 `if (document.hidden) return`。手机切后台时:
   - 客户端 JS 定时器被 OS 冻结(心跳/轮询停);
   - 服务端 30s 心跳照常,~30-60s 后单方面 `terminate` 这条后台 zombie socket;
   - 我加的 hidden 守卫又主动停掉 HTTP 兜底。
   → WS 死 + 轮询停,driven turn 在后台结束时 `drive_done` 广播无接收者而丢失 → driveStatus 卡 `streaming`、不补回复。
2. **确定性 bug(S3)**:fast 轮询只在**当前项目** `sessions` 里查 `selectedId`。跨项目接管的会话不在该列表 → `sel===undefined` → fast 轮询对它**永不触发**(新加跨项目支持后尤其明显)。

## 修复

`apps/web/app/page.tsx` 的 fast(4s)轮询:
- **去掉无条件 hidden 守卫**:改为只要会话"正在驱动/streaming"就继续同步,**即便 hidden** —— 这是后台唯一能把"后台结束的 turn"补回来的投递路径;idle 会话不触发,零电量代价。
- **跨项目查找**:`sessions` 查不到时回退 `allSessions`。
- **信任本地流式态**:`active` 额外纳入 `driveStatus === "streaming"`,避免 `driving` 因快照时序短暂误判 false 导致停摆。
- slow(20s)轮询保留 hidden 守卫(只是 dashboard 列表,后台省掉无妨,resume 补拉)。

配合既有 `syncTail` 收尾逻辑:当快速轮询拉到 `driving===false` 时,会把卡住的 `streaming` 收尾、补出回复、恢复输入框。

## 影响 / 验证

- 仅前端 `page.tsx`;web typecheck 干净、build 成功。
- 之前已加 driver 生命周期日志(`.logs/local-agent.log`),便于进一步定位。
- 遗留(本轮未做,低危健壮性):S2(handleVisible 800ms 合并窗)、S5(客户端心跳后台冻结必被服务端 terminate)、重连指数退避 —— 可后续再加。

## 备注

deep-background 下 iOS 会冻结所有定时器,届时仍只能靠 resume 恢复;本修复确保 resume 后(定时器恢复)active 会话持续 resync 直到收尾,且覆盖"hidden 但未冻结"(桌面隐藏标签/短暂后台)这一最常见档。
