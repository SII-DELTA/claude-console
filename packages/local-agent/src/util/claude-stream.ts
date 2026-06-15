/**
 * Pure parser for `claude -p --output-format stream-json --include-partial-messages`.
 *
 * Real token-by-token streaming arrives as `stream_event` envelopes carrying
 * Anthropic streaming events (content_block_start / content_block_delta / …).
 * We map those to fine-grained deltas. The assembled (non-partial) `assistant`
 * message snapshots that also appear are intentionally ignored here to avoid
 * double-emitting — the authoritative final messages come from the session JSONL
 * (ClaudeStore → claude:message).
 */
export interface StreamUsage {
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export type StreamEvent =
  | { kind: "init"; sessionId: string }
  | { kind: "delta"; blockKind: "text" | "thinking" | "tool_use"; text: string }
  | { kind: "done"; isError: boolean; result?: string; usage?: StreamUsage }
  | { kind: "rate_limit"; resetsAt?: number; limitType?: string; status?: string }
  | { kind: "error"; message: string };

interface RawInner {
  type?: string;
  index?: number;
  content_block?: { type?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string };
}

interface RawStream {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  error?: string | { message?: string };
  event?: RawInner;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  rate_limit_info?: { resetsAt?: number; rateLimitType?: string; status?: string };
}

/** Parse one stream-json line. Returns [] for lines with nothing actionable. */
export function parseStreamLine(line: string): StreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let e: RawStream;
  try {
    e = JSON.parse(trimmed) as RawStream;
  } catch {
    return [];
  }

  if (e.type === "system" && e.subtype === "init" && e.session_id) {
    return [{ kind: "init", sessionId: e.session_id }];
  }

  if (e.type === "result") {
    const usage: StreamUsage = {
      costUsd: e.total_cost_usd,
      durationMs: e.duration_ms,
      inputTokens: e.usage?.input_tokens,
      outputTokens: e.usage?.output_tokens,
    };
    return [{ kind: "done", isError: !!e.is_error, result: e.result, usage }];
  }

  if (e.type === "rate_limit_event" && e.rate_limit_info) {
    return [
      {
        kind: "rate_limit",
        resetsAt: e.rate_limit_info.resetsAt,
        limitType: e.rate_limit_info.rateLimitType,
        status: e.rate_limit_info.status,
      },
    ];
  }

  if (e.type === "error") {
    const msg = typeof e.error === "string" ? e.error : (e.error?.message ?? "claude error");
    return [{ kind: "error", message: msg }];
  }

  // Token-level streaming events.
  if (e.type === "stream_event" && e.event) {
    const ev = e.event;
    if (ev.type === "content_block_delta" && ev.delta) {
      if (ev.delta.type === "text_delta" && ev.delta.text) {
        return [{ kind: "delta", blockKind: "text", text: ev.delta.text }];
      }
      if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
        return [{ kind: "delta", blockKind: "thinking", text: ev.delta.thinking }];
      }
      return [];
    }
    // Surface a tool the moment its block opens (its name is known immediately).
    if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      return [{ kind: "delta", blockKind: "tool_use", text: ev.content_block.name ?? "tool" }];
    }
    return [];
  }

  // Assembled snapshots (`assistant` / `user`) are ignored — see file header.
  return [];
}
