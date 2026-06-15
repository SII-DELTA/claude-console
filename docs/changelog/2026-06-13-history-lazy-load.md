# Change Log — 历史会话懒加载 + 最近会话内存缓存

日期: 2026-06-13
对应: docs/specs/2026-06-13-history-lazy-load-spec.md / docs/plans/2026-06-13-history-lazy-load-plan.md

## 改动文件

- `packages/local-agent/src/claude-store.ts`：`getSession(id, { limit?, before? })` 支持分页，返回 `{ session, messages, total, offset }`；不传 opts 时返回全部（driver 等内部调用兼容）。
- `packages/local-agent/src/http-server.ts`：`GET /claude/sessions/:id` 解析 `limit`/`before` 查询参数透传。
- `apps/web/lib/api.ts`：`claudeSession(id, { limit?, before? })` 拼 query，返回类型加 `total`/`offset`。
- `apps/web/lib/store.ts`：
  - 新增 `historyOffset`、`loadingEarlier` state 与 `loadEarlier()` action。
  - **内存缓存**：`sessionCache`（LRU，最多 5 个会话）。`selectSession` 命中缓存即时还原（不重新拉/不重渲染），仅对 live/被驱动会话后台 revalidate。
  - `selectSession` 初次只取尾页 `limit=HISTORY_PAGE(40)`；`endTurn` 改取尾页并写回缓存；ws 增量追加同步写缓存。
  - `setConnection`/`switchProject` 清空缓存并重置分页。
- `apps/web/app/page.tsx`：Timeline 上方「加载更早的消息」按钮 + 滚到顶部自动加载；前插时记录/补偿 `scrollTop` 防跳动，并用 `skipAutoScrollRef` 屏蔽跳到底 effect。
- `packages/local-agent/src/__tests__/claude-store.test.ts`：新增分页单测（尾页/`before`/越界 clamp）。

## 核心变更

- 长会话首屏只传/渲染最近 40 条，上滑逐页补齐；切回最近会话从内存秒回，不再每次重拉重渲染。

## 影响范围

- 仅历史读取与前端渲染；写入/驱动/流式不变。driver 内部 `getSession` 无参调用仍取全量。

## 验证结果

- `apps/web` typecheck 通过；web 14 测试、local-agent 68+ 测试全绿（新增分页用例通过）。
- 直连真实数据实测：3640 条消息的会话 `limit=5` 仅返回 5 条、`offset=3635`；`listProjects` 正常 7 个项目。
- 注：local-agent 对**测试文件**的 `noUncheckedIndexedAccess` 严格度报错为既有/并行改动噪音，不影响运行与本功能。
