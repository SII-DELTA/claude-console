# Plan — getSession 尾页反向读分页(方案 A)

日期: 2026-06-20
对应 spec: [2026-06-20-getsession-tail-pagination-spec.md](../specs/2026-06-20-getsession-tail-pagination-spec.md)

## 步骤

### 1. 新增 `readTailMessages(file, n)` (claude-store.ts)
- 私有 async,返回 `{ messages: ClaudeMessage[]; cursor: number }`。
- Buffer 层反向读:`fileHandle` 或 `readRange` 取 `[start,end)` 字节块,`CHUNK=64*1024`。
  - 复用现有 `readRange(file, from, to)`(已用于 `tail`)若其返回 string 会破坏 UTF-8 → 改用按字节读:
    用 `fs.open` + `fileHandle.read(buf, 0, len, pos)` 得到 Buffer,保证字节级。
  - 维护合并 Buffer(前插),按 `0x0A` 从尾定位完整行,解码 utf8 → `parseLine`。
  - `parsed?.message` 计入(前插保正序),够 n 条或到 BOF 停。
  - 末尾在写半行(最后一段无 `\n`)丢弃。
- `cursor`:文件最后一个 `\n` 偏移 +1(无则 0),从尾块算。
- 关闭 fileHandle(try/finally)。

### 2. `getSession` 加分流 (claude-store.ts)
- `resolveSessionFile(id)` 解析路径(保留)。
- `if (before == null && limit != null && limit > 0)`:
  - `session = readSessionMeta(file)`;null → 返回 null。
  - `total = session.messageCount`;`{messages, cursor} = readTailMessages(file, limit)`。
  - `offset = max(0, total - messages.length)`;返回 `{session, messages, total, offset, cursor}`。
- else:保留现有 `foldFile(true)` + slice 逻辑(原样)。
- 注意:现有返回里 `session` 由 `buildSession(...)` 构造;分流后改用 `readSessionMeta`(等价,均经 buildSession),确认字段一致。

### 3. 测试 (claude-store.test.ts)
- 扩展 fixture 或新增更长 fixture(含 meta + 多消息 + tool_use/result + 中文)。
- 断言:尾页 `messages/total/offset/cursor` == 全量 `getSession` 再手动 slice,覆盖
  limit < / == / > total、limit==1、末尾半行、UTF-8。
- 加载更早(before)与尾页拼接连续无重叠。

### 4. 验证 + 收尾
- `pnpm --filter @mac/local-agent typecheck && test`。
- 运行时:重启 agent,curl 大会话 `?limit=10` 对比内容正确、cursor 可续 tail。
- 写 change log → commit(中文,Co-Authored-By 结尾)。

## 验收
- 大会话 `?limit=N` 不再全量解析驻留;返回与旧逻辑逐字段一致;全部测试通过。
