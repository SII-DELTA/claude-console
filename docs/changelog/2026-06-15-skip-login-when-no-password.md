# 2026-06-15 无密码时跳过登录

## 改动概述

未配置 `MAC_AGENT_PASSWORD` 时，agent 以开放模式运行，web 端探测到后**直接连接、不再显示登录环节**；配了密码才走密码登录。

## 改动文件

- `packages/local-agent/src/runtime.ts`：`noAuth` 改为「无密码即开放」（`noAuth = !password`），不再依赖 `MAC_AGENT_NO_AUTH`；新增 `config.password`（默认取 `MAC_AGENT_PASSWORD`）。
- `packages/local-agent/src/http-server.ts`：`/health` 返回 `{ ok, version, auth: "none" | "password" }`，供客户端判断是否需要登录。
- `apps/web/lib/api.ts`：`health()` 返回类型补 `version` / `auth`。
- `apps/web/components/ConnectForm.tsx`：挂载时探测 `/health`，`auth === "none"` 则隐藏密码框并自动直连；地址变更时（onBlur）重新探测；探测失败回退完整表单。
- `.env.example`：`MAC_AGENT_PASSWORD` 说明更新为「不设即开放」，移除失效的 `MAC_AGENT_NO_AUTH`。
- 测试：`http-server.test.ts` / `ws-bridge.test.ts` 的鉴权用例显式传 `password: "test-pw"` 以开启鉴权。
- 文档：`README` 安全提示、`docs/security.md`、`docs/web.md` 同步开放/密码两种模式。

## 影响范围

- 行为变化：默认（无密码）从「auth on / 无法登录」变为「开放直连」。`MAC_AGENT_NO_AUTH` 不再生效。
- 安全：暴露到回环以外仍**必须**设 `MAC_AGENT_PASSWORD`。

## 验证结果

- `pnpm typecheck` 全绿（shared / local-agent / web）。
- `pnpm test` 107 全绿（shared 15 + local-agent 74 + web 18）。
