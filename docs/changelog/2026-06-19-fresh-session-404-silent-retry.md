# 新建会话 404 静默重试 + 超时根因记录

- 日期: 2026-06-19
- Spec: docs/specs/2026-06-19-fresh-session-404-silent-retry-spec.md
- Plan: docs/plans/2026-06-19-fresh-session-404-silent-retry-plan.md

## 背景

设置页「接口错误」日志暴露:新建会话开头几秒,`GET /claude/sessions/<id>` 连续 404,
且会自愈("会话列表最终还在")。根因是新建会话拿到 id 后立即轮询详情,而 Claude 冷启动
(+ 远程 Tailscale)尚未写出 JSONL 第一行 → 服务端 `existsSync` 失败回 404;404 在
`request()` 里被先行写入错误日志,造成刷屏噪声。

## 改动文件

- `apps/web/lib/api.ts`
  - `request()` 新增 `silent404` 开关:命中预期 404 时跳过 `recordNetError`,仍抛 `ApiError(404)`。
  - `claudeSession` / `claudeSessionTail` 透传 `silent404`。
  - 新增 `isNotFound(err)` 助手。
- `apps/web/lib/store.ts`
  - 新增"新鲜会话"跟踪(`freshSessions` Map + `FRESH_WINDOW_MS=15s`、`FRESH_RETRY_MS=700ms`)。
  - `sendPrompt` 新建分支采纳 id 后 `markFresh()`。
  - `revalidateTail` 对新鲜会话传 `silent404`,捕获 404 后在窗口内以 700ms 退避自我调度重试,
    成功即清除标记;窗口过期则放行为常规错误(至多记录一次)。
- `apps/web/__tests__/ApiClient.test.ts`
  - 新增用例:`silent404` 命中时不写错误日志、仍抛 404;默认路径的真 404 仍被记录。

## 核心变更

- 新建会话开头的"等待落盘"404 不再进入接口错误日志,也不弹 UI 错误;落盘后自动加载。
- 已存在会话的真实 404 行为不变,仍记录与提示。

## 影响范围

- 仅前端 `apps/web`;服务端未改。`silent404` 默认 false,不传即旧行为。

## 超时根因(本次仅查清,未改)

- `/usage`(只读缓存)也超时 ⇒ Node 事件循环被阻塞。
- `claude-store.ts` 的 `foldFile` 同步 `split("\n")` + 逐行 `JSON.parse` 整份 JSONL;
  活动项目存在 10–20MB transcript,`listSessions`/`getSession` 折叠时同步卡死事件循环数秒,
  并发请求成组 abort(日志中相同时间戳的 timeout 即此特征)。
- 建议后续独立任务优化:mtime 缓存命中跳过折叠 / 增量游标读 / 分片让出事件循环。

## 验证结果

- `npx tsc --noEmit`:通过(exit 0)。
- `npx vitest run`:3 文件 23 用例全绿(含新增用例)。
