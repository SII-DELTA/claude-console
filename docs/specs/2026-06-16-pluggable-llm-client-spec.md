# 通用 LLM 客户端（第三方 API 优先，Haiku 回退）Spec

- 日期: 2026-06-16
- 状态: 待确认
- 范围: `local-agent` 新增通用 OpenAI 兼容 LLM 客户端 + 模型注册表；接入 current-task 观察员（API 优先，失败回退 `claude -p` Haiku）
- 参考: `~/Downloads/开源模型接口文档_副本.md`（SII 自部署端点）、`nexra_learn .../llm_client.py`

## 1. 背景与目标

当前 current-task 摘要只走 `claude -p` Haiku（约 11s、$0.005/次）。希望：
- 可配置**第三方 OpenAI 兼容 API**（如 SII 的 DeepSeek-V4-Flash），更快/更省/可控。
- **API 优先，失败/超时/空结果回退 Haiku**，不留白。
- 抽成**通用可复用 LLM 客户端**，方便其他人按 `.env` 接任意 OpenAI 兼容服务。
- 作者自己的 `.env` 用 **DeepSeek-V4-Flash**。

## 2. 配置契约（.env，运行时变量；key 只放 .env 不入源码）

```
# 通用三元组（接任意 OpenAI 兼容 /v1/chat/completions）
LLM_API_KEY=...                  # 必填以启用；空 → 不启用 API，仅走 Haiku
LLM_API_MODEL=ds-v4-flash        # 注册表别名，或任意 model id
LLM_API_BASE_URL=                # 注册表别名可省略（自动带出）；自定义服务需填
LLM_API_THINKING=false           # 可选；覆盖该模型 thinking 默认
LLM_API_TIMEOUT_MS=20000         # 可选
```

- **注册表别名**（来自接口文档，内置 base_url + model_id + thinking 约定）：
  `ds-v4-pro` / `ds-v4-flash` / `glm5.1` / `qwen3.6-27b` / `kimi-k2.6` / `minimax-m2.7`（含 `deepseek`/`glm`/`qwen`/`kimi`/`minimax` 等别名）。
- 解析规则：`base_url` 显式优先；否则若 `model` 命中注册表用其 base_url；`model_id` 同理（注册表 → 其 model_id，否则原样）。
- 启用条件：`base_url`（显式或注册表）且 `key` 且 `model` 齐全。

## 3. 通用客户端 `packages/local-agent/src/llm-client.ts`

- 模型注册表 `ModelSpec { modelId, baseUrl, thinkingMode }`，thinkingMode ∈ off/on_et/on_tk/none（对齐 Python 各模型约定）。
- `resolveLLMFromEnv(env=process.env): LLMClient | null`：按 §2 解析；不满足启用条件返回 null。
- `class LLMClient`：
  - `ready(): boolean`、`describe(): string`（日志用，**不含 key**）。
  - `chat(messages, { temperature?, maxTokens?, thinking?, timeoutMs? }): Promise<string>`：
    POST `{baseUrl}/v1/chat/completions`，OpenAI body；按 thinkingMode 注入 `chat_template_kwargs`；
    用全局 `fetch` + `AbortController` 超时；取 `choices[0].message.content`；非 2xx/空抛错。
- 纯 OpenAI 兼容，无新依赖（Node18+ 全局 fetch）。

## 4. 接入 current-task

- `CurrentTaskSummarizer` 新增可选 `llm?: LLMClient | null`（runtime 注入）。
- 摘要顺序：`summarizeFn`(测试) → `llm.ready()` 时先 `llm.chat`（system=观察员指令, user=transcript）→ 失败/超时/空则回退现有 `spawnSummary`（`claude -p` Haiku）。
- 回退时 `console.warn` 一行（便于排查），成功不刷屏。
- 去重/广播/sanitize 逻辑不变。

## 5. 影响文件

- 新增 `packages/local-agent/src/llm-client.ts` + 测试。
- `packages/local-agent/src/current-task.ts`：注入并优先调用 llm。
- `packages/local-agent/src/runtime.ts`：`resolveLLMFromEnv()` 注入。
- `.env.example`：新增 LLM 配置块（占位符 + 别名清单）。
- `.env`（gitignore）：作者实填 DeepSeek-V4-Flash。
- `docs/local-agent.md` 或 README：补配置说明（可选）。

## 6. 非目标

- 不改前端、不做流式（观察员只需一句话）。
- 不内置任何 API key 到源码。
- 不引入 langchain / openai SDK（保持零依赖 fetch）。
- 不改 Haiku 回退路径本身。

## 7. 验收

- 未配置 `LLM_API_*` → 行为同现在（走 Haiku）。
- 配 DeepSeek-V4-Flash → 摘要走 API；断网/错 key/超时 → 自动回退 Haiku，仍出摘要。
- `pnpm typecheck` + `@mac/local-agent` 测试全绿（含 llm-client 解析/thinking 单测，用注入 fetch 不打真实网络）。

## 8. 已确认决策

- 配置方案：通用三元组 + 内置注册表。
- 范围：独立可复用模块。
- API 优先、失败回退 Haiku；key 只放 .env；作者 .env 用 ds-v4-flash。
