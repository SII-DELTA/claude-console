# 通用 LLM 客户端（第三方 API 优先，Haiku 回退）Change Log

- 日期: 2026-06-16
- spec: `docs/specs/2026-06-16-pluggable-llm-client-spec.md`
- plan: `docs/plans/2026-06-16-pluggable-llm-client-plan.md`

## 核心变更

- 新增**通用 OpenAI 兼容 LLM 客户端** `packages/local-agent/src/llm-client.ts`：
  - 内置 SII 开源模型注册表（`ds-v4-flash`/`ds-v4-pro`/`glm5.1`/`qwen3.6-27b`/`kimi-k2.6`/`minimax-m2.7` + 常用别名），别名自动带出 base_url + model_id + thinking 约定。
  - `resolveLLMFromEnv()` 从 `LLM_API_KEY` / `LLM_API_MODEL` / `LLM_API_BASE_URL` / `LLM_API_TIMEOUT_MS` 解析；通用三元组可接任意 OpenAI 兼容服务。
  - `LLMClient.chat()`：全局 fetch + AbortController 超时，按 thinkingMode 注入 `chat_template_kwargs`；**key 只读 env、不入源码、不进日志**。
- **current-task 摘要改为：第三方 API 优先 → 失败/超时/空结果回退 `claude -p` Haiku**，不留白。
- runtime 启动时解析并注入 LLM；配置存在则打印一行（不含 key）。

## 配置（运行时变量，读仓库根 `.env`）

```
LLM_API_KEY=...            # 启用 API；空 → 仅 Haiku
LLM_API_MODEL=ds-v4-flash  # 注册表别名或任意 model id
LLM_API_BASE_URL=          # 别名可省；自定义服务必填
LLM_API_TIMEOUT_MS=20000
```

作者本机 `.env`（gitignore）已配 DeepSeek-V4-Flash。

## 改动文件

- 新增 `packages/local-agent/src/llm-client.ts`、`__tests__/llm-client.test.ts`。
- `packages/local-agent/src/current-task.ts`：`runSummary` 优先 LLM、回退 spawn。
- `packages/local-agent/src/runtime.ts`：`resolveLLMFromEnv()` 注入。
- `.env.example`：新增 current-task 摘要 + LLM 配置块。
- `.env`（gitignore）：DeepSeek-V4-Flash。

## 验证

- `pnpm typecheck` 全绿；`@mac/local-agent` 126 测试通过（含 llm-client 10 + current-task 3）。
- 真网冒烟：DeepSeek-V4-Flash 观察员摘要正确（"重构监控台过滤逻辑并移除工具调用数"），~5.9s（快于 Haiku ~11s）。
- 回退路径：错 key / 断网 / 超时 → `console.warn` 后走 Haiku，仍出摘要。

## 备注

- 改动在 local-agent 运行时；**需 `make restart` 重启 agent 生效**。
