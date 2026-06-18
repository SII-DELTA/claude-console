# 新建会话 404 静默重试 — Plan

- 日期: 2026-06-19
- Spec: [2026-06-19-fresh-session-404-silent-retry-spec.md](../specs/2026-06-19-fresh-session-404-silent-retry-spec.md)

## 改动清单

### 1. `apps/web/lib/api.ts`
- `request()` 的 `opts` 增加 `silent404?: boolean`。当 `res.status === 404 && opts.silent404`
  时,**跳过** `recordNetError`,仍 `throw new ApiError(... 404 ...)`。
- `claudeSession(id, opts, reqOpts?)`:新增第三参 `{ silent404?: boolean }`,透传给 `request`。
- `claudeSessionTail(id, cursor, reqOpts?)`:同样新增透传。
- 导出 `isNotFound(err)` 助手(`err instanceof ApiError && err.status === 404`),与
  `isLiveConflict` 同风格。

### 2. `apps/web/lib/store.ts`
- 模块级:`const freshSessions = new Map<string, number>()`;常量
  `FRESH_WINDOW_MS = 15_000`、`FRESH_RETRY_MS = 700`。
- 助手:`markFresh(id)` / `freshAge(id)`(返回 `Date.now()-ts` 或 null)。
- `sendPrompt` 新建分支采纳 id 后 `markFresh(sessionId)`(在 `revalidateTail` 之前)。
- `revalidateTail(api, id, set, get)`:
  - 计算 `fresh = freshAge(id) != null && freshAge(id) < FRESH_WINDOW_MS`。
  - `api.claudeSession(id, {limit}, { silent404: fresh })`。
  - 成功:`freshSessions.delete(id)` 后照原逻辑。
  - 捕获:若 `fresh && isNotFound(err) && get().selectedId === id` → `setTimeout(重试, FRESH_RETRY_MS)` 并 return;
    否则窗口已过则 `freshSessions.delete(id)`,保持原"吞错保留缓存视图"行为。
- `syncTail`:新鲜会话尚无 cursor → 已委派 `revalidateTail`,重试逻辑复用,无需改。

### 3. 测试
- 复用现有 `ApiClient.test.ts` 风格补一例:`silent404` 命中时不调用 `recordNetError`、仍抛 404。
- 运行 `pnpm -C apps/web test`(vitest)确认不回归。

## 验证步骤
1. `pnpm -C apps/web typecheck`(或 tsc)无误。
2. vitest 全绿。
3. 人工:新建会话开头若干秒,接口错误日志无 404 噪声;落盘后正常加载。

## 风险与回滚
- 风险:窗口内若是"真 404"(罕见),会延迟 ≤15s 才报错。可接受。
- 回滚:三处改动相互独立,`silent404` 默认 false,不传即旧行为;单 commit 可整体 revert。
