# 本地开发启停与前端错误修复 Plan

## 实施步骤

1. 新增 `scripts/dev-control.sh`
   - 支持 `start|stop|restart|status`。
   - 服务包含 `web`、`agent`、`all`。
   - stop 同时按端口和命令行模式查杀进程。
   - web restart 清理 `apps/web/.next`。
   - 启动日志写入 `.logs/`。

2. 新增 `Makefile`
   - `make web`、`make agent`、`make dev` 默认执行 restart。
   - `make stop`、`make status` 提供管理入口。
   - 增加 `make web-stop`、`make agent-stop`、`make web-status`、`make agent-status`。

3. 修复与验证
   - 停掉旧 Next dev 进程。
   - 用 Makefile 重启前端。
   - 浏览器打开 3005 验证首屏无错误。

## Change Log

### 2026-05-28

改动文件：

- `Makefile`
- `scripts/dev-control.sh`
- `packages/shared/src/schemas.ts`
- `packages/local-agent/src/workspace-reader.ts`
- `packages/local-agent/src/copilot-store.ts`
- `packages/local-agent/src/lm-stream-manager.ts`
- `packages/local-agent/src/session-manager.ts`
- `packages/local-agent/src/http-server.ts`
- `packages/local-agent/src/runtime.ts`
- `apps/web/lib/api.ts`
- `apps/web/lib/store.ts`
- `apps/web/app/page.tsx`
- `apps/web/app/copilot/[id]/page.tsx`
- `apps/web/next.config.mjs`
- `apps/web/package.json`
- `docs/specs/2026-05-28-dev-control-spec.md`
- `docs/plans/2026-05-28-dev-control-plan.md`

核心变更点：

- 新增 Makefile 启停入口：`make dev`、`make web`、`make agent`、`make stop`、`make status`。
- 新增 `scripts/dev-control.sh`，通过端口与进程匹配停止服务，启动使用 `screen` 后台会话，Web restart 会清理 `.next`。
- 修复旧 token 导致的 401：前端识别 401 后自动清除连接并提示重新配对，避免持续用坏 token 请求接口。
- 新增 workspace 列表与切换 API：`GET /workspaces`、`POST /workspaces/switch`。
- local-agent 可从 VS Code `workspaceStorage` 发现项目，并在切换后同步更新 CopilotStore、LmStreamManager、SessionManager 的当前 workspace。
- Web 首页新增 workspace 下拉切换，切换后刷新 Copilot 会话与 Stream 会话。
- Next dev 输出目录改为 `.next-dev`，生产构建仍使用 `.next`，避免 dev server 与 `next build` 同时读写同一个缓存目录导致 `Cannot find module './240.js'`。

影响范围：

- 重启 local-agent 后旧浏览器 token 仍会失效，但 Web 会自动退回配对流程。
- workspace 切换主要影响后续 Copilot 历史读取、继续对话、新建本地 session 的默认工作目录。

验证结果：

- `pnpm typecheck` 通过。
- `pnpm --filter @mac/local-agent test` 通过，43 个测试全部通过。
- `pnpm --filter @mac/web build` 通过。
- `make dev` 可启动 local-agent `:7345` 与 Web `:3005`。
- 已用带 token 的 API smoke 验证：`GET /workspaces` 返回 16 个 workspace，`GET /copilot/sessions` 返回 200。
- `curl --noproxy '*' http://127.0.0.1:3005/` 返回 200，未再出现 `Cannot find module './240.js'`。
- 验证了 Web dev 运行时执行 `pnpm --filter @mac/web build`，随后继续访问 `http://127.0.0.1:3005/copilot/test-id` 成功，不再触发缺失 chunk。

提交状态：

- 当前目录不是 Git 仓库，无法执行 commit。
