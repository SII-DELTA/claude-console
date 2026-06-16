/**
 * Generic OpenAI-compatible LLM client (zero deps, global fetch).
 *
 * Configured entirely from env so anyone can point it at any `/v1/chat/completions`
 * service. A small registry of the SII self-hosted open models (from the 2026 接口
 * 文档) lets users just set a model alias and have base_url + thinking conventions
 * filled in. API keys are read ONLY from env — never embedded in source.
 *
 * Env contract:
 *   LLM_API_KEY=...            # required to enable; empty → resolveLLMFromEnv() = null
 *   LLM_API_MODEL=ds-v4-flash  # registry alias, or any model id
 *   LLM_API_BASE_URL=          # optional for registry aliases (auto-filled)
 *   LLM_API_THINKING=false     # optional override of the model's thinking default
 *   LLM_API_TIMEOUT_MS=20000   # optional
 */

export type ThinkingMode = "off" | "on_et" | "on_tk" | "none";

export interface ModelSpec {
  modelId: string;
  baseUrl: string;
  /** off: add {thinking:true} to enable · on_et: add {enable_thinking:false} to disable
   *  · on_tk: add {thinking:false} to disable · none: no thinking switch */
  thinkingMode: ThinkingMode;
}

/** SII self-hosted open models (endpoints/model_id/thinking from the 接口文档). */
const REGISTRY: Record<string, ModelSpec> = {
  "ds-v4-pro": {
    modelId: "ds-v4-pro",
    baseUrl: "https://o8kjqm58o8ogcm5ek8aggddkb5ggk8dp.openapi-sj.sii.edu.cn",
    thinkingMode: "off",
  },
  "ds-v4-flash": {
    modelId: "ds-v4-flash",
    baseUrl: "https://ds-v4-flash-w8a8-vllm-ascend.openapi-sj.sii.edu.cn",
    thinkingMode: "off",
  },
  "glm5.1": {
    modelId: "glm5.1-w4a8-4maas",
    baseUrl: "https://cbpecq8oomh5cpbbk9gm5ck85cbpoaoe.openapi-sj.sii.edu.cn",
    thinkingMode: "on_et",
  },
  "qwen3.6-27b": {
    modelId: "Qwen3.6-27B",
    baseUrl: "https://qh8cg5bjqq8jcbdckhqmbek8oh8ehba9.openapi-sj.sii.edu.cn",
    thinkingMode: "on_et",
  },
  "kimi-k2.6": {
    modelId: "kimi-k2.6-w4a8",
    baseUrl: "https://jqdmppbopbaacp9ajcaqem88gqobcd9m.openapi-sj.sii.edu.cn",
    thinkingMode: "on_tk",
  },
  "minimax-m2.7": {
    modelId: "MiniMax-M2.7-w8a8",
    baseUrl: "https://hqdaoabjb89cc5gkkp59me9h9e5dpkhm.openapi-sj.sii.edu.cn",
    thinkingMode: "none",
  },
};

const ALIASES: Record<string, string> = {
  deepseek: "ds-v4-flash",
  "deepseek-flash": "ds-v4-flash",
  "ds-flash": "ds-v4-flash",
  "deepseek-pro": "ds-v4-pro",
  "ds-pro": "ds-v4-pro",
  glm: "glm5.1",
  "glm-5.1": "glm5.1",
  qwen: "qwen3.6-27b",
  "qwen3.6": "qwen3.6-27b",
  kimi: "kimi-k2.6",
  minimax: "minimax-m2.7",
};

export function specFor(name: string): ModelSpec | undefined {
  return REGISTRY[ALIASES[name] ?? name];
}

export function listModels(): string[] {
  return Object.keys(REGISTRY);
}

/** chat_template_kwargs for the model's thinking convention, or null. */
export function thinkingKwargs(
  mode: ThinkingMode,
  thinking: boolean | undefined,
): Record<string, boolean> | null {
  if (thinking === undefined) return null;
  switch (mode) {
    case "off":
      return thinking ? { thinking: true } : null;
    case "on_et":
      return thinking ? null : { enable_thinking: false };
    case "on_tk":
      return thinking ? null : { thinking: false };
    default:
      return null;
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** override the model's thinking default (undefined → leave to the model) */
  thinking?: boolean;
  timeoutMs?: number;
}

type FetchImpl = typeof fetch;

export class LLMClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly modelId: string,
    private readonly thinkingMode: ThinkingMode,
    private readonly defaultTimeoutMs: number,
    private readonly fetchImpl: FetchImpl,
  ) {}

  ready(): boolean {
    return !!(this.baseUrl && this.apiKey && this.modelId);
  }

  /** Human-readable config for logs — never includes the key. */
  describe(): string {
    return `${this.modelId} @ ${this.baseUrl}`;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.modelId,
      messages,
      temperature: opts.temperature ?? 0.2,
    };
    if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
    const ctk = thinkingKwargs(this.thinkingMode, opts.thinking);
    if (ctk) body.chat_template_kwargs = ctk;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? this.defaultTimeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`LLM ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      if (!content.trim()) throw new Error("LLM empty response");
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build an LLMClient from env, or null when not configured (no key, or no base_url
 * for a non-registry model). `fetchImpl` is injectable for tests.
 */
export function resolveLLMFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchImpl = fetch,
): LLMClient | null {
  const key = (env.LLM_API_KEY ?? "").trim();
  const model = (env.LLM_API_MODEL ?? "").trim();
  if (!key || !model) return null;

  const spec = specFor(model);
  const baseUrl = (env.LLM_API_BASE_URL ?? "").trim() || spec?.baseUrl || "";
  if (!baseUrl) return null; // unknown model + no explicit base_url → can't call

  const modelId = spec?.modelId ?? model;
  const thinkingMode: ThinkingMode = spec?.thinkingMode ?? "none";
  const timeoutMs = Number(env.LLM_API_TIMEOUT_MS) || 20_000;

  return new LLMClient(baseUrl, key, modelId, thinkingMode, timeoutMs, fetchImpl);
}
