# 新建会话 404 刷屏消除 + 接口超时根因 — Spec

- 日期: 2026-06-19
- 范围: `apps/web`(前端,主要改动) + 超时根因记录(`packages/local-agent`,仅诊断)
- 关联: 接口错误日志(commit 2a6658f)首次暴露这些错误

## 背景 / 现象

设置页「接口错误」日志出现两类报错:

1. 同一会话 `GET /claude/sessions/<id>` 连续 3 次 **404**(limit 10/40/10,间隔约 3 秒)。
2. `/usage`、`/claude/sessions`、`/claude/sessions/all` **timeout**,且多条时间戳完全相同。

用户反馈:"报错,但是已完成的会话列表还会存在"——即报错可自愈,会话最终正常出现。

## 根因分析(已核对代码与磁盘)

### A. 新建会话 404(本次要修)

- `sendPrompt` 新建分支拿到 `sessionId` 后**立即** `revalidateTail()` → `GET /claude/sessions/<id>`
  ([store.ts:692](../../apps/web/lib/store.ts#L692))。
- 此刻 Claude 进程冷启动(+ 远程 Tailscale 链路)**尚未写出 JSONL 第一行**;服务端
  `getSession` 在 `existsSync(file)` 失败时返回 null → HTTP 404
  ([claude-store.ts:326](../../packages/local-agent/src/claude-store.ts#L326),
  [http-server.ts:396](../../packages/local-agent/src/http-server.ts#L396))。
- `revalidateTail` / `syncTail` 的 catch 已吞掉 UI 报错,但 404 在 `request()` 里
  **先一步写入了接口错误日志**([api.ts:75](../../apps/web/lib/api.ts#L75))→ 日志刷屏。
- 落盘后(几秒)后续轮询成功 → "会话列表最终还在"。本次长会话 `e9b24c31`(10MB)正是此例。

### B. 接口超时(本次仅查清,不在本次实现范围)

- `/usage` 只读缓存文件却也超时,只能是 **Node 事件循环被阻塞**。
- `foldFile` 把整份 JSONL `readFile` 进内存后**同步** `split("\n")` + 逐行 `JSON.parse`
  ([claude-store.ts:405-412](../../packages/local-agent/src/claude-store.ts#L405-L412))。
- 活动项目里有 10–20MB 的 transcript;`listSessions`/`getSession` 一折叠就同步卡住事件循环
  数秒,期间所有并发请求(连最轻的 `/usage`)一起 abort → 时间戳相同的成组 timeout。
- 推荐后续优化(独立任务):mtime 缓存命中时跳过折叠 / 增量游标读 / 分片让出事件循环。

## 目标(用户已选)

1. **消除新建会话 404 刷屏**:对"刚发起、尚未落盘"的会话,详情/tail 的 404 视为
   「等待落盘」,前端在一个短窗口内**静默重试**,既不弹错误也不写入接口错误日志;
   超过窗口仍 404 才按真实错误处理。
2. **查清超时根因**:见 §B,本 spec 记录,作为后续优化输入。

## 方案(已选:前端静默重试)

- 引入"新鲜会话"概念:新建会话被采纳 id 时打时间戳,窗口内(默认 15s)的 404 = 等待落盘。
- `request()` 增加 `silent404` 开关:命中时**跳过** `recordNetError`,但仍照常抛 `ApiError(404)`,
  调用方据此判定是否静默重试。
- `claudeSession` / `claudeSessionTail` 透传该开关。
- `revalidateTail`(新建会话轮询的唯一汇聚点)对新鲜会话传 `silent404`,捕获 404 后在窗口内
  以 ~700ms 退避**自我调度重试**,成功即清除新鲜标记;窗口过期则放行为常规错误。

## 验收

- 新建会话开头几秒的 404 **不再出现在接口错误日志**,也不弹 UI 错误。
- 落盘后会话正常加载,行为与现状一致。
- 已存在会话的真实 404(路径失效等)仍照常记录与提示。
- 现有单测(ApiClient / store)不回归。

## 非目标

- 不在本次修改服务端 `foldFile` 的事件循环阻塞(§B 仅记录,留作后续)。
- 不改 `/usage`、会话列表的超时阈值或降级策略。
