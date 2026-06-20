# Spec — "加载更早" 字节偏移索引(方案 B / P2)

日期: 2026-06-20
状态: 待确认
承接: [getsession-tail-pagination](2026-06-20-getsession-tail-pagination-spec.md) 暂缓的方案 B

## 1. 背景与问题

`getSession(id, { before, limit })`(向上翻页 / 加载更早)目前走全量路径
([claude-store.ts:368-379](../../packages/local-agent/src/claude-store.ts)):`foldFile(file, true)`
读+解析整份 JSONL、驻留全部消息,再 `slice(start, end)`。大会话每次"加载更早"都是 O(file)、
驻留全量、阻塞事件循环 —— 与尾页快路径已优化的"首次打开"形成对比。

## 2. 关键事实(设计依据)

- 前端"加载更早":`before = 当前页首条绝对索引`、`limit = HISTORY_PAGE`,返回的页 **prepend** 到
  已加载消息之前;`offset` = 新页首条绝对索引。返回的 `cursor` 在该路径**未被前端使用**
  (cursor 仅用于尾/初始加载的增量 tail)。
- "消息索引"口径 = `parseLine().message` 为真的行数(meta 行不计),与 `acc.messageCount` 同一集合
  (accumulate 与 tail 都以 `parsed.message` 判定)。
- **prepend 下 tool 配对安全**:加载的更早页 [start,end) 接在已加载的 [end,…) 之前。页内某个
  `tool_use` 的 `tool_result` 若在 index ≥ end(更晚),则**已在已加载消息里**,buildTimeline 对合并
  集正确配对;页首出现的"孤儿 tool_result"(其 tool_use < start 未加载)前端本就容忍。与尾页同理。

## 3. 目标 / 非目标

目标:
- `before` 分页只读该页对应的**字节区间**、只解析该页的行;元信息走缓存。返回 `{session, messages,
  total, offset, cursor}` 与现有全量 `slice` **逐字段等价**(cursor 除外,见下)。
- 首次对某文件做 before 分页时构建一次索引并缓存;后续翻页 O(页)。

非目标:
- 不改尾页快路径、不改 HTTP 接口 / 前端 / schema。
- 不改 driver 等"取整段历史"(无 limit)调用 —— 仍走全量。

## 4. 设计

### 4.1 消息偏移索引

每文件一个 `number[]`:`index[i]` = 第 i 条**消息行**的起始字节偏移。
- 构建 `buildMessageIndex(file)`:从头扫一遍,按 `\n` 定位每行,记录每行起始字节;对每行 `parseLine`,
  若 `parsed.message` 为真则把该行起始偏移 push 进 index。**不驻留消息对象**(比 foldFile(true) 省内存)。
- 缓存:`msgIndexCache: Map<file, { mtimeMs; size; index; scannedBytes }>`,按 mtime+size 命中;
  LRU 上限(如 200)。`scannedBytes` = 已索引到的字节末尾。
- 失效/增量:
  - `size < scannedBytes`(截断/重写)→ 丢弃重建。
  - `size > scannedBytes`(追加)→ 从 `scannedBytes` 起**增量扫描**新增字节,续 push 偏移(行边界对齐,
    最后不完整行不计,留待下次)。
  - 命中(mtime+size 不变)→ 直接用。

### 4.2 按索引读页 `readMessagesByIndex(file, index, start, end)`

- `byteStart = index[start]`;`byteEnd = end < index.length ? index[end] : size`。
- 读字节 `[byteStart, byteEnd)`(复用现有 `readRange` 思路,UTF-8 安全:区间端点都是行边界 `\n` 后,
  整行解码安全),按 `\n` 切行,`parseLine` 过滤出 message → 恰好是消息 start..end-1。
  (区间内夹杂的 meta 行被 parseLine 过滤掉,无害。)

### 4.3 getSession 的 before 分支改写

```
if (before != null) {                       // 加载更早 / 显式区间
  const session = await readSessionMeta(file)      // 缓存元信息, total = messageCount
  if (!session) return null
  const index = await getMessageIndex(file)        // 缓存偏移索引
  const total = session.messageCount               // == index.length(断言校验)
  const end = clamp(before, 0, total)
  const start = max(0, end - (limit ?? total))
  const messages = await readMessagesByIndex(file, index, start, end)
  return { session, messages, total, offset: start, cursor: <见 4.4> }
}
// 无 limit 且无 before(driver 取整段)→ 维持全量 foldFile
```

### 4.4 cursor

该路径前端不使用 cursor。为保持返回结构与正确性,返回文件最后一个 `\n` 之后的偏移(= foldFile 的
`consumedOffset`,可由 size + 末尾少量字节廉价求得),或直接复用尾路径的 cursor。不影响前端。

## 5. 正确性与边界

- **逐字段等价**:对同一文件,`getSession(before=B, limit=N)` 的 `messages/total/offset` 必须等于全量
  `foldFile` 再 `slice(max(0,B-N), B)`。用测试钉死。
- `end >= total`(before 超界):`byteEnd = size`,读到 EOF;`min(before,total)` 已 clamp。
- `start == end`(空页):返回 `[]`。
- 索引与 messageCount 不一致(理论不应发生):以 `index.length` 为准切片并记一条告警。
- 多字节:区间端点为行边界,整行解码,不截断。
- 增量扫描与并发追加:读 size 一次为界;微秒级追加下次命中再补,既有全量路径同样有此瞬时窗口。

## 6. 测试

扩展 `claude-store.test.ts`(复用上次的大 fixture,含 meta 噪声 + tool_use/result + 多字节):
- `before/limit` 各档(B=total、B=中段、N> / < 可用、空页)结果 == 全量 slice;
- 尾页 + 多次"加载更早" 拼接连续、无重叠/缺失;
- 文件追加后(增量索引)翻页仍正确;
- 索引构建一次后,后续翻页不再整份 fold(可用计数/打点间接验证,或仅断言结果正确)。

## 7. 风险 / 回滚

- 风险:索引边界/增量扫描 off-by-one 致丢/多一条。等价性测试钉死;无 before/无 limit 路径与尾页不变,
  driver 零影响。
- 回滚:before 分支改回 `foldFile + slice` 即可(单点)。

## 8. 影响文件

- `packages/local-agent/src/claude-store.ts`:`getMessageIndex`/`buildMessageIndex`(增量)/
  `readMessagesByIndex`;`getSession` before 分支改写;`msgIndexCache` 字段。
- `packages/local-agent/src/__tests__/claude-store.test.ts`:等价 + 增量 + 边界测试。
- 无前端 / 接口 / schema 改动。

## 9. 备注:首次构建成本

首次对某大文件 before 分页仍需一次 O(file) 扫描建索引(但不驻留消息,比全量 fold 省内存),之后翻页
O(页)。对"反复向上翻"的大会话收益最大;只翻一次的场景与现状成本相当但结果已缓存。
