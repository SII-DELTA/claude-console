# 通用 LLM 客户端 实施 Plan

- 对应 spec: `docs/specs/2026-06-16-pluggable-llm-client-spec.md`

## 步骤

1. **`packages/local-agent/src/llm-client.ts`（新增）**
   - `ModelSpec` + `_REGISTRY`（6 个 SII 模型）+ `_ALIASES`。
   - `thinkingKwargs(mode, thinking)` 对齐 Python（off/on_et/on_tk/none）。
   - `resolveLLMFromEnv(env, fetchImpl?)`：解析三元组 + 注册表 → `LLMClient | null`。
   - `class LLMClient { ready(); describe(); chat(messages, opts) }`，fetch + AbortController 超时，OpenAI body，注入 chat_template_kwargs。
   - 可注入 `fetchImpl` 便于测试。

2. **`current-task.ts`**
   - opts 加 `llm?: LLMClient | null`。
   - `runSummary`：summarizeFn → llm.chat（try/catch）→ spawnSummary 回退；回退打 warn。

3. **`runtime.ts`**
   - `const llm = resolveLLMFromEnv();` 传入 `new CurrentTaskSummarizer({ store, bus, llm })`；启动时 log `describe()`（无 key）。

4. **配置文件**
   - `.env.example`：LLM 配置块（占位符 + 别名清单 + 说明）。
   - `.env`：DeepSeek-V4-Flash（base 自动、key 来自文档）。

5. **测试 `__tests__/llm-client.test.ts`**
   - resolve：别名带出 base_url/model_id；显式 base_url 覆盖；缺 key → null。
   - thinkingKwargs 各模式。
   - chat：注入 fake fetch 校验 URL/headers/body 与返回解析；非 2xx 抛错。

6. **验证**：`pnpm typecheck` + local-agent 测试；手测见 spec §7。

7. **提交**：写 change log → commit。
