# WS 提示 + HTTP 游标权威同步 Spec(方案 A)

- 日期: 2026-06-18
- 状态: 待确认(用户已选 方案 A + ③ + ④;推进方式=先写 spec)
- 取代: docs/specs/2026-06-17-ws-resync-and-liveness-hardening-spec.md 中的 ①②(被本架构吸收);保留其 ③④ 思路并纳入本 spec。

## 核心思想

把"易丢但无所谓的存活/通知"与"绝不能丢的消息内容"分层:

- **消息内容**永远从持久源(JSONL,已按条数分页)经 HTTP 拉取,作为唯一权威。
- **WS** 降级为"有变化,去拉"的轻提示;`claude_message`/`delta` 仅作低延迟优化,丢失无害(下次拉取补齐)。

结果:消息丢失从"靠更快发现断线来规避"变为**结构上不可能**;抗 agent 重启(JSONL 在);僵尸连接最多晚几秒,不丢内容。

## 现状(已核实)

- `GET /claude/sessions/:id?limit=&before=` → `{ session, messages, total, offset }`,`offset/total` 为**消息条数索引**([claude-store.ts:311-331](packages/local-agent/src/claude-store.ts#L311))。
- 前端打开的会话时间线只靠 WS 推送 / 重连 onOpen / 回前台 `revalidateTail`;20s 轮询不带动当前会话。
- WS 为无状态广播,不补发;僵尸连接下后端先 terminate、前端无感([ws-bridge.ts:192](packages/local-agent/src/ws-bridge.ts#L192))。
- `SessionLiveness.start()` 的 `loadAll()` 读入残留 state 文件;reaper 45s 一轮;dead/ended 文件不删。

## 设计

### 1. 后端:增量拉取(消息条数游标)

- 扩展 `GET /claude/sessions/:id`,新增可选 `since=<count>`:
  - 给定 `since` 时,返回 `messages = all.slice(since)`、`total`、`offset = since`;并带回最新 `session`(含 driving/isLive)。
  - 为防"最后一条在途消息内容被改写",前端按 1 条重叠拉取(`since = max(0, have-1)`),按消息索引覆盖式合并。
  - 不传 `since` 时维持原行为(limit/before 分页),向后兼容。
- claude-store 增加对应分支(复用现有解析,几乎零成本)。

### 2. 前端:HTTP 游标作权威,WS 作提示

- store 为打开的会话维护 `serverTotal`(上次同步时服务端消息条数)。
- 新增 `syncTail(id)`:`GET ?since=serverTotal-1` → 覆盖式合并新消息、更新 `serverTotal`、并把返回的 `session.driving/isLive` 同步进 store。节流(同一会话最小间隔,如 1s)。
- 触发 `syncTail` 的时机(全部走它,不再依赖 onOpen 是否触发):
  1. 20s 轮询(若有 selectedId 且 socket 可用)。
  2. 收到 `server:claude_session_updated` / `server:claude_message` 且 `sessionId === selectedId`(去抖)。
  3. 重连 onOpen、回前台 handleVisible、`online`/`pageshow` 事件。
- WS `claude_message`/`delta` 处理保留作即时优化;即便整段丢失,(1)(2)也能补齐。
- 初次进入会话仍用现有全量 `claudeSession`(走 cache),之后增量。

### 3. ③ loading 兜底更鲁棒

- `syncTail`/`revalidateTail` 拉回的 `session.driving/isLive` 同步到 store,使 LoadingBadge 不再仅依赖易丢的 `claude:driving` 事件([page.tsx:451](apps/web/app/page.tsx#L451))。
- `driveStatus==="streaming"` 加超时保护:超过阈值(默认 120s)无任何 delta/done,降级回 idle 并 `syncTail`,避免永久卡 streaming 或永久空白。

### 4. ④ 修复"会话被误杀/运行误判" + 清理残留 hook + reaper 提速

**4a. [关键] driver 空闲回收器误杀正在运行的长轮** — claude-driver.ts
- 现状:`touch()` 在轮开始 arm 5min 定时器,但 `delta` 不 `touch`、长工具执行也无 stdout 活动 → 超 5min 触发 `kill()`,且 `kill()` 无 busy 守卫 → 把正在跑的 web 会话从中途 SIGTERM,emit `drive_error`、driving 翻 false。这是"web 会话老是被关、运行中判断不准"的主因。
- 修复:空闲定时器改调 `reapIfIdle()`:`w.busy` 为真则**重新 arm、绝不杀**;只回收真正闲置进程。`kill()` 保持无条件(供 interrupt/shutdown/mode-switch)。
- 并让 `delta`(及其它活动)`touch()` 续命,双保险。

**4b. hook 状态机过报兜底** — session-liveness.ts
- `Stop` 漏发 → 卡 `busy`,而 reaper 仅在 PID 死时清;进程还活着就一直显示运行中。兜底:`busy` 但 `lastEventAt`/jsonl mtime 超阈值未变且无 currentTool → 视为 idle(本期最小实现,可后续增强)。

**4c. 清理残留 + 提速**
- `SessionLiveness.start()`:`loadAll()` 后立即跑一次 `reap()`,启动即纠正残留死文件。
- reaper 判 `dead`/`ended` 时删除磁盘 state 文件,避免无限累积。
- `REAP_INTERVAL_MS` 45s → 20s。

## 影响范围

- agent: `packages/local-agent/src/claude-store.ts`(since 分支)、`http-server.ts`(query 透传)、`session-liveness.ts`(启动 reap + 删文件 + 间隔)。
- web: `apps/web/lib/api.ts`(since 参数)、`apps/web/lib/store.ts`(syncTail/serverTotal/触发点/streaming 超时)、`apps/web/lib/ws.ts`(网络事件,如顺带)、`apps/web/app/page.tsx`(online/pageshow 监听)。
- 不改 WS 广播模型、不做 session 级订阅过滤(`client:subscribe` 仍留空)。

### 5. 重连后的流式光标(基线 + 可选增强)

现状:实时打字气泡 `StreamingBubble` 的 `stream` 缓冲只在**发起这一轮的本标签页**(`driveStatus==="streaming"`)被填充;其它情况(后台重连、另一设备、刷新后)delta 被丢弃,只剩 LoadingBadge,最终消息靠 `drive_done` 整条补。

- **基线(本期采用)**:重连/恢复后不重放实时打字;显示「处理中…」(权威 `driving`)→ 消息整条落地。内容必然完整(HTTP/JSONL),零额外后端状态。
- **可选增强(单列待办,本期不做)**:driver 内存累积当前轮 partial 文本 → 新增 `GET /claude/sessions/:id/inflight` → 前端把流式渲染与本地 `driveStatus` 解耦,对任意 `driving` 会话用快照种子化 `stream` 再跟 delta,使光标在任意端/重连后无缝续显。纯观感增强,最终内容与基线一致。

### 6. WS 层加固(并入)

1. **回前台不信 `readyState`**:`handleVisible` 中页面隐藏超过心跳窗口就强制重连,不因 `isOpen()===true` 只补 tail(消灭僵尸分支)。
2. **客户端先发现**:客户端心跳 20s → ~10–15s,确保前端先判死主动重连。
3. **服务端 2-tick 宽限**:短暂冻结又回来的客户端不急着 terminate,减少抖动。
4. **网络事件**:`online`/`pageshow` 立即重连。

## 非目标

- 不实现 seq+回放(方案 B)、不换 socket.io/SSE(方案 C)。
- 不改 Claude JSONL 刷盘行为(增量拉取对滞后天然更鲁棒)。
- 本期不做"inflight 实时光标续显"增强(单列待办)。

## 风险

- 增量合并需以消息索引为准、覆盖式写入,避免重复/错位;用 1 条重叠兜底在途改写。
- 多触发点并发 `syncTail` 需节流 + 以 `selectedId` 校验,避免竞态覆盖(切会话后旧结果丢弃)。
- ④ 删文件只删 dead/ended,严禁误删活跃会话文件。

## 验证

- typecheck:`pnpm --filter @mac/web typecheck`;agent 包构建/测试。
- 手动:
  - 断网/锁屏/切后台/切 WiFi 后,当前对话最多 ~20s 内自动补齐新消息,无需手刷。
  - 杀掉 WS(模拟僵尸)后,轮询仍能补消息。
  - Claude 干活时 loading 稳定;异常不卡死。
  - 重启 agent 后无残留死文件误报运行中;state 目录不再无限增长。

## 待定参数(默认值)

- 增量重叠条数:1
- syncTail 节流:1s
- streaming 超时:120s
- REAP_INTERVAL:20s
