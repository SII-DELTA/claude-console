# Spec — getSession 尾页反向读分页(方案 A)

日期: 2026-06-20
状态: 待确认

## 1. 背景与问题

打开会话时前端请求 `GET /claude/sessions/<id>?limit=N`(取最后 N 条)。当前实现
[claude-store.ts `getSession`](../../packages/local-agent/src/claude-store.ts) 走
`foldFile(file, true)`:

1. 把整份 `.jsonl` 读入内存(大会话 ~12MB);
2. 对**每一行** `JSON.parse`,解析出**全部**消息(如 2439 条);
3. 全部驻留数组;
4. 最后才 `slice` 出末尾 N 条返回。

结果:要 N 条却解析+驻留全部。**内存峰值高**(大消息对象全驻留,极端可 OOM)、
**CPU 同步阻塞事件循环**(JSON.parse 12MB),是 `/claude/sessions` 偶发 timeout 的根因之一。

> 仅"打开那一下"的开销;打开后的实时增量走廉价的 `tail(id, fromByte)`(只读新增字节),不受影响。

## 2. 关键事实(设计依据)

- 会话**元信息**(总条数 `messageCount`、标题、cwd、updatedAt、attention、光标)已可经
  `readSessionMeta(file)` → `metaCache`(按 mtime+size 指纹缓存的 `acc`,不驻留消息)廉价取得。
  未变文件零重解析。**getSession 当前绕过了它**。
- 前端分页按**消息绝对索引**:初次 `limit=N`;加载更早 `before=当前页首索引 & limit=PAGE`;
  返回的 `offset` = 本页首条的绝对索引,`total` = 总条数。
- 反向取尾页对工具配对**安全**:`tool_result` 总在其 `tool_use` 之后;连续尾窗口内,窗口里的
  `tool_use` 其 `result` 必也在窗口内;窗口起始处可能出现"result 的 use 在窗口外"的孤儿 result —
  前端 `buildTimeline` 以 use 为主查 result map,孤儿 result 只是 map 中未被引用,**不影响渲染**。

## 3. 目标 / 非目标

目标:
- `getSession(id, {limit:N})`(无 `before`)只反向读出最后 N 条消息正文,只解析这 N 条;
  元信息走缓存路径。返回的 `{session, messages, total, offset, cursor}` 与现有全量切片**逐字段等价**。
- 不改 HTTP 接口、不改前端、不改 `tail` 端点、不改 `before`(加载更早)语义。

非目标:
- 不优化"加载更早"(`before` 路径)——低频,维持现有全量 fold。
- 不引入行偏移索引(方案 B)、不做整份消息记忆(方案 C)。
- 不改 driver 等内部"取整段历史"调用(无 limit 时仍走全量)。

## 4. 设计

### 4.1 路径选择(getSession 内分流)

```
if (before == null && limit != null && limit > 0):
    走【尾页反向读】
else:
    走【现有全量 foldFile(true) + slice】   // before(加载更早)/无 limit(内部全量)
```

### 4.2 尾页反向读算法 `readTailMessages(file, n)`

在 **Buffer 字节层**操作,避免 UTF-8 跨块截断:

1. `size = stat(file).size`;`pos = size`;`pending: Buffer[] = []`;`messages: ClaudeMessage[] = []`。
2. 循环,每次从 `[max(0,pos-CHUNK), pos)` 读一块(`CHUNK=64KB`),`pos` 左移,块**前插**进缓冲。
3. 在合并缓冲里**从尾向头**按 `0x0A`(`\n`)定位完整行:
   - 末尾若无换行(文件正被追加的半行)→ 丢弃该半行(与 `tail()` 一致)。
   - 每条**完整行**(两 `\n` 之间)按 utf8 解码 → `parseLine`;`parsed?.message` 为真则计入
     (前插保持正序),直到收集到 `n` 条或 `pos==0`(到文件头)。
   - 非消息行(meta:queue-operation/ai-title/summary 等)跳过、不计数。
   - 缓冲最前面的"不完整行"(其起点还在更左、尚未读到)保留,待下一块读入后再判定;到文件头时它才算完整行。
4. `cursor` = 文件中最后一个 `\n` 的字节偏移 +1(无则 0)——即"最后完整行之后"的字节位置,
   与 `foldFile` 的 `consumedOffset` 等价;从尾块即可廉价算出。

### 4.3 组装返回

```
const session = await readSessionMeta(file)      // 缓存路径, 含 messageCount=total
if (!session) return null
const total = session.messageCount
const { messages, cursor } = await readTailMessages(file, limit)
const offset = Math.max(0, total - messages.length)
return { session, messages, total, offset, cursor }
```

- `limit >= total`:反向读自然读到文件头、返回全部,与全量切片一致。
- 文件不存在 / 空 / 仅 meta 行:`readSessionMeta` 返回 null(messageCount==0)→ getSession 返回 null(与现状一致)。
- 仍先经 `resolveSessionFile(id)`(跨项目解析,见上一修复),再走上述逻辑。

## 5. 正确性与边界

- **逐字段等价**:对同一文件,尾页反向读得到的 `messages` 必须等于
  `foldFile(true).messages.slice(total-N, total)`;`offset/total/cursor` 与全量路径一致。用测试钉死。
- **UTF-8 安全**:只解码完整行的字节切片(行边界处必是 ASCII `\n`),不会截断多字节字符。
- **半行/截断**:末尾无换行的在写半行被丢弃;文件被改小(rewrite)对尾读无影响(从当前 EOF 读)。
- **并发追加**:读 size 与读 meta 间若有微秒级追加,`total` 可能比本页视图多几条 → `offset` 偏移几条,
  下次轮询自愈;现有全量路径同样有此瞬时窗口,可接受。
- **消息计数一致性**:`acc.messageCount` 与"`parseLine().message` 为真的行数"是同一集合(accumulate 与
  tail 都以 `parsed.message` 判定),故 `total` 与反向计数一致。实现时断言校验。

## 6. 测试

新增/扩展 `claude-store.test.ts`:
- 构造含 meta 行 + 多条消息(含 tool_use/tool_result)的会话:
  - `getSession(id,{limit:k})` 的 `messages/total/offset/cursor` 等于全量 `getSession(id)` 再 `slice`;
  - 覆盖 `limit < total`、`limit == total`、`limit > total`、`limit == 1`;
  - 末尾无换行(在写半行)时尾页正确丢弃半行;
  - 含中文/多字节内容验证 UTF-8 不截断;
  - 与 `before`(加载更早)路径结果拼接连续、无重叠/缺失。

## 7. 风险 / 回滚

- 风险:反向读边界处理 bug 致丢/多一条。用"与全量切片逐字段等价"测试钉死;`before`/无 limit 路径不变,
  driver 等内部调用零影响。
- 回滚:分流是单点判断,去掉即回退到全量路径。

## 8. 影响文件

- `packages/local-agent/src/claude-store.ts`:新增 `readTailMessages`;`getSession` 加分流。
- `packages/local-agent/src/__tests__/claude-store.test.ts`:新增等价性/边界测试。
- 无前端、无接口、无 schema 改动。
