# Plan — "加载更早" 字节偏移索引(P2)

对应 spec: [2026-06-20-load-earlier-offset-index-spec.md](../specs/2026-06-20-load-earlier-offset-index-spec.md)

## 步骤

### 1. claude-store.ts
- 字段 `msgIndexCache = new Map<file, { mtimeMs; size; index: number[]; scannedBytes: number }>()`(LRU 上限 200)。
- `readRangeBytes(file, start, end): Promise<Buffer>`(模块级,字节级读,返回 Buffer;readRange 的姊妹)。
- `private async getMessageIndex(file): Promise<number[]>`:
  - 读 mtime+size;命中(mtime+size 全等)→ 返回 cached.index;
  - size > cached.size → 从 cached.scannedBytes 增量扫;否则从 0 重建。
  - 扫描:`readRangeBytes(file, from, size)` → 按 0x0A 切行,`parseLine` 行文本,`parsed.message` 为真则
    push 该行**全局起始字节**(from + searchStart);scannedBytes = 最后一个 \n 之后的偏移(尾部不完整行不计)。
  - 写回缓存(超上限删最旧)。
- `private async readMessagesByIndex(file, index, start, end): Promise<ClaudeMessage[]>`:
  - `start>=end` → []；`byteStart=index[start]`,`byteEnd = end<index.length ? index[end] : size`;
  - `readRange(file, byteStart, byteEnd)`(区间端点对齐行边界 → 整行,字符串解码安全)→ split("\n") →
    parseLine 过滤 message;`.slice(0, end-start)` 兜底。
- `getSession` before 分支改写:`before != null` → readSessionMeta + getMessageIndex,`total=messageCount`
  (与 index.length 不一致则以 index.length 为准并 console.warn),`end=clamp(before,0,total)`,
  `start=max(0,end-(limit??total))`,`readMessagesByIndex`;cursor 复用尾路径口径(前端不使用)。
  无 before 且无 limit(driver 取整段)→ 维持全量 foldFile。

### 2. 测试 (claude-store.test.ts)
- 复用大 fixture:`before` 各档结果 == 全量 `getSession` 再 slice;空页;before 超界 clamp;
- 尾页 + 多次 before 翻页拼接 == 全量;
- 追加新行后(增量索引)再 before 翻页仍等价。

### 3. 收尾
- agent typecheck + test;运行时:对大会话 `?before=..&limit=..` 验证内容正确、与全量一致;change log → commit。

## 验收
- before 分页只读该页字节区间;与全量 slice 逐字段等价;全部测试通过;无前端/接口改动。
