# Change Log — "加载更早" 字节偏移索引(P2)

日期: 2026-06-20
spec/plan: [spec](../specs/2026-06-20-load-earlier-offset-index-spec.md) · [plan](../plans/2026-06-20-load-earlier-offset-index-plan.md)

## 改动
- `packages/local-agent/src/claude-store.ts`:`msgIndexCache` 字段;`readRangeBytes`(字节级读);
  `getMessageIndex`(每文件消息行字节偏移索引,按 mtime+size 缓存、追加时增量扫描、截断重建);
  `readMessagesByIndex`(只读该页字节区间并解析);`getSession` 的 `before` 分支改用索引。
- `packages/local-agent/src/__tests__/claude-store.test.ts`:before 分页等价 + 多页拼接 + 增量追加测试。

## 核心变更
- "加载更早"(`before` 分页)不再 `foldFile` 整份 JSONL 再 slice,改为经偏移索引只读该页对应字节区间、
  只解析该页;元信息走 metaCache。首次对某文件翻页建一次索引(不驻留消息),之后翻页 O(页)。

## 验证
- 128 测试通过:before 各档/空页/超界 clamp 与全量 slice 逐字段等价;尾页+多页向上翻拼接 == 全量;
  追加后增量索引仍等价。
- 运行时(真实 ~3381 条会话):尾页 offset 3371 与更早页 offset 3361 完美衔接;首次 before 建索引
  0.038s,之后翻页 0.0014–0.006s(含深处 before=100 仅 0.0014s,证明只读该页区间)。

## 影响 / 回滚
- 仅后端 claude-store;不改前端/接口/schema。回滚 = before 分支改回 foldFile+slice。
