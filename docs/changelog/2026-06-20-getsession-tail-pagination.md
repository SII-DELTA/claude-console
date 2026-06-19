# Change Log — getSession 尾页反向读分页(方案 A)

日期: 2026-06-20
spec/plan: [spec](../specs/2026-06-20-getsession-tail-pagination-spec.md) · [plan](../plans/2026-06-20-getsession-tail-pagination-plan.md)

## 改动文件

- `packages/local-agent/src/claude-store.ts`:新增 `readTailMessages`;`getSession` 加尾页分流。
- `packages/local-agent/src/__tests__/claude-store.test.ts`:新增等价性 + 边界测试。

## 核心变更

- 打开会话(`GET /claude/sessions/:id?limit=N`,无 `before`)不再 `foldFile` 整份 JSONL
  全解析+全驻留再切尾,改为从文件 **EOF 反向按 64KB 字节块**读出最后 N 条消息,**只解析这 N 条**。
- 元信息(`total`/标题/cwd/`cursor`)走已有 `metaCache` 廉价路径;`offset = total - 返回条数`。
- UTF-8 安全(Buffer 层按 `\n` 定位完整行,只解码完整行);末尾在写半行丢弃(与 `tail()` 一致)。
- `before`(加载更早)与无 limit(内部全量)维持原全量 fold 逻辑,零影响。

## 影响范围

- 仅后端 claude-store;不改 HTTP 接口、前端、schema。
- 内部调用(driver 取整段历史)走无 limit 分支,行为不变。

## 验证

- 单测 125 通过。新增测试钉死:尾页 `messages/total/offset/cursor` 与全量 `getSession` 再
  `slice` **逐字段等价**,覆盖 limit < / == / > total、limit==1、含 meta 噪声行、tool_use/result、
  多字节(中文/emoji 跨块边界);尾页 + 加载更早拼接连续无重叠/缺失;在写半行被正确丢弃。
- 运行时(真实 ~12MB / 2535 条会话):`?limit=10` → 返回 10 条、total 2535、offset 2525、
  0.06s;返回的 cursor 喂给 `tail` 得 0 新增且 cursor 不变 → 游标可续、一致。

## 备注

- 方案 B(行偏移索引,使"加载更早"也 O(页))与 C(整份记忆)本次未做;A 已解决"首次打开大会话"
  的内存峰值与事件循环卡顿这一主要痛点。
