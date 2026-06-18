# WS 实时性与会话存活硬化 Spec

- 日期: 2026-06-17
- 状态: 待确认(用户已选 ①②③④,推进方式=先写 spec)
- 背景: web 创建/查看的会话经常"断开却无 loading、有新消息不自动出现需手动刷新"。经排查,根因是打开的会话时间线无轮询兜底、僵尸 WS 检测慢、driving 信号易丢无兜底、hook 残留状态文件误报运行中。

## 现状(已核实)

- 打开的会话时间线**只**靠 WS 推送 / 重连 onOpen / 回前台 `revalidateTail` 更新;20s 轮询([page.tsx:174](apps/web/app/page.tsx#L174))只刷新会话列表,**不带动当前会话**。
- 僵尸连接靠 20s 心跳([ws.ts:15](apps/web/lib/ws.ts#L15)),最长 ~40s 才发现;无 `online`/`offline`/`pageshow` 触发。
- loading 指示依赖 `driveStatus==="streaming"` 或 `selected.driving`([page.tsx:451](apps/web/app/page.tsx#L451));信号丢失即消失。
- `SessionLiveness.start()` 的 `loadAll()` 会读入所有残留 state 文件;reaper 45s 一轮([session-liveness.ts:18](packages/local-agent/src/session-liveness.ts#L18));残留 `busy` 死文件会误报运行中,磁盘文件从不删除。

## 目标与方案

### ① 打开会话轮询兜底(核心)

- 在 20s 轮询里,若有 `selectedId` 且 socket 可用,顺带对当前会话做一次 `revalidateTail`(节流:与列表轮询同频即可)。
- 另外:收到 `server:claude_session_updated` 且 `msg.sessionId === selectedId` 时,触发当前会话 `revalidateTail`(消息真有变化才会改 UI,已有 cache 比较)。
- 验收:WS 不可靠时,最多 20s 内当前对话自动补齐新消息,无需手动刷新。

### ② 更快发现掉线 + 网络事件重连

- 监听 `window` 的 `online` / `pageshow`,触发 `handleVisible()` 同等的"立即重连或补 tail"逻辑;`offline` 时立即置 `wsConnected=false`(UI 反映)。
- 心跳更激进:`PING_INTERVAL_MS` 20s → 10s(僵尸检测窗口 ~40s → ~20s)。保持仍低于服务端 30s。
- 验收:切换网络/锁屏回来后数秒内恢复,不再长时间"看着连着其实死了"。

### ③ loading 兜底更鲁棒

- `revalidateTail` 拉回 session 后,用其 `driving`/`isLive` 字段同步到 store,使 LoadingBadge 不再仅依赖易丢的 `claude:driving` 事件。
- `driveStatus==="streaming"` 增加超时保护:超过 N 秒(如 120s)未收到任何 delta/done 且 socket 异常,降级回 idle 并 `revalidateTail`,避免永久卡 streaming 或永久无 loading。
- 验收:Claude 在干活时 loading 稳定显示;异常时不会永久卡住或永久空白。

### ④ 清理残留 hook 状态 + reaper 提速

- `SessionLiveness.start()`:`loadAll()` 后立即跑一次 reaper(现有 `refreshAndReap` 已具备能力),让启动即纠正残留 `busy`/`idle` 死文件,不等 45s。
- 被标记 `dead`/`ended` 的状态文件:删除磁盘文件(或归档),避免无限累积。
- `REAP_INTERVAL_MS` 45s → 适当缩短(如 20s)以更快纠正崩溃残留。
- 验收:重启 agent 后不再有残留死文件误报运行中;`~/.claude/session-state/` 不再无限增长。

## 影响范围

- web: `apps/web/lib/ws.ts`、`apps/web/lib/store.ts`、`apps/web/app/page.tsx`
- agent: `packages/local-agent/src/session-liveness.ts`(可能含 runtime 启动调用)
- 不改协议、不改 WS 广播模型(session 过滤本次不做)。

## 非目标

- 不实现 WS 按 session 订阅过滤(`client:subscribe` 死代码留待后续)。
- 不改 Claude JSONL 刷盘行为。

## 风险

- ② 心跳加频 + 网络事件重连需防"重连风暴":复用单一 `reconnectTimer`,并对网络事件重连加最小间隔保护。
- ① 轮询带动 tail 需避免与 onOpen/handleVisible 的 tail 重复并发覆盖:统一走 `revalidateTail`(内部已按 `selectedId` 校验 + cache 比较)。
- ④ 删除状态文件需确保只删 dead/ended,避免误删活跃会话文件。

## 验证

- typecheck:`pnpm --filter @mac/web typecheck` + agent 包构建/测试。
- 手动:断网/锁屏/切后台后,会话能在数秒~20s 内自动恢复与补消息;loading 稳定;重启 agent 后无残留误报。
