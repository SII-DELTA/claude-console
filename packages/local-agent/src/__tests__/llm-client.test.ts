import { describe, expect, it, vi } from "vitest";
import { resolveLLMFromEnv, thinkingKwargs, specFor } from "../llm-client.js";

function okFetch(content: string) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("resolveLLMFromEnv", () => {
  it("returns null without a key", () => {
    expect(resolveLLMFromEnv({ LLM_API_MODEL: "ds-v4-flash" }, okFetch("x"))).toBeNull();
  });

  it("fills base_url + model_id from the registry alias", () => {
    const c = resolveLLMFromEnv({ LLM_API_KEY: "k", LLM_API_MODEL: "deepseek" }, okFetch("x"));
    expect(c).not.toBeNull();
    expect(c!.ready()).toBe(true);
    expect(c!.describe()).toContain("ds-v4-flash");
    expect(c!.describe()).toContain("ds-v4-flash-w8a8");
    expect(c!.describe()).not.toContain("k"); // key never leaks into describe
  });

  it("requires explicit base_url for unknown models", () => {
    expect(resolveLLMFromEnv({ LLM_API_KEY: "k", LLM_API_MODEL: "mystery" }, okFetch("x"))).toBeNull();
    const c = resolveLLMFromEnv(
      { LLM_API_KEY: "k", LLM_API_MODEL: "mystery", LLM_API_BASE_URL: "https://host" },
      okFetch("x"),
    );
    expect(c!.ready()).toBe(true);
    expect(c!.describe()).toBe("mystery @ https://host");
  });
});

describe("thinkingKwargs", () => {
  it("off: only adds when enabling", () => {
    expect(thinkingKwargs("off", true)).toEqual({ thinking: true });
    expect(thinkingKwargs("off", false)).toBeNull();
  });
  it("on_et: only adds when disabling", () => {
    expect(thinkingKwargs("on_et", false)).toEqual({ enable_thinking: false });
    expect(thinkingKwargs("on_et", true)).toBeNull();
  });
  it("on_tk: only adds when disabling", () => {
    expect(thinkingKwargs("on_tk", false)).toEqual({ thinking: false });
  });
  it("undefined leaves it to the model", () => {
    expect(thinkingKwargs("off", undefined)).toBeNull();
  });
});

describe("LLMClient.chat", () => {
  it("posts an OpenAI body to /v1/chat/completions and returns content", async () => {
    const f = okFetch("重构监控台项目过滤");
    const c = resolveLLMFromEnv({ LLM_API_KEY: "secret", LLM_API_MODEL: "ds-v4-flash" }, f)!;
    const out = await c.chat([{ role: "user", content: "hi" }], { maxTokens: 64 });
    expect(out).toBe("重构监控台项目过滤");
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://ds-v4-flash-w8a8-vllm-ascend.openapi-sj.sii.edu.cn/v1/chat/completions");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer secret",
    );
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("ds-v4-flash");
    expect(body.max_tokens).toBe(64);
  });

  it("throws on non-2xx and on empty content", async () => {
    const bad = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const c = resolveLLMFromEnv({ LLM_API_KEY: "k", LLM_API_MODEL: "ds-v4-flash" }, bad)!;
    await expect(c.chat([{ role: "user", content: "x" }])).rejects.toThrow(/500/);

    const empty = okFetch("   ");
    const c2 = resolveLLMFromEnv({ LLM_API_KEY: "k", LLM_API_MODEL: "ds-v4-flash" }, empty)!;
    await expect(c2.chat([{ role: "user", content: "x" }])).rejects.toThrow(/empty/);
  });
});

describe("specFor", () => {
  it("resolves aliases", () => {
    expect(specFor("kimi")?.modelId).toBe("kimi-k2.6-w4a8");
    expect(specFor("ds-v4-pro")?.thinkingMode).toBe("off");
  });
});
