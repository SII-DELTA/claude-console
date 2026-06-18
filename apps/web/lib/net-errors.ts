"use client";

/**
 * In-memory log of failed API requests (timeouts / unreachable / non-2xx), surfaced in
 * Settings so a flaky connection can be inspected, copied to an AI, or screenshotted.
 * Recorded from the single ApiClient.request choke point.
 */
export type NetErrorKind = "timeout" | "network" | "http";

export type NetError = {
  id: number;
  ts: number;
  method: string;
  path: string;
  /** HTTP status; 0 for timeout/unreachable */
  status: number;
  kind: NetErrorKind;
  message: string;
  /** trimmed server payload / extra detail */
  detail?: string;
};

const MAX = 50;
let entries: NetError[] = [];
let seq = 0;
const listeners = new Set<() => void>();

export function recordNetError(e: Omit<NetError, "id" | "ts">): void {
  seq += 1;
  entries.push({ ...e, id: seq, ts: Date.now() });
  if (entries.length > MAX) entries.shift();
  for (const l of listeners) l();
}

export function getNetErrors(): NetError[] {
  return entries;
}

export function clearNetErrors(): void {
  entries = [];
  for (const l of listeners) l();
}

export function subscribeNetErrors(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** A short, human-readable cause for the error (the "basic diagnosis"). */
export function diagnoseNetError(e: NetError): string {
  if (e.kind === "timeout") return "请求超时：网络慢，或 agent 繁忙/未在运行（重的会话操作可能需要更久）。";
  if (e.kind === "network") return "连不上 agent：检查 agent 是否在跑、服务器地址是否正确、Tailscale/网络是否正常。";
  switch (e.status) {
    case 401:
      return "登录失效：token 过期或无效 → 重新登录。";
    case 403:
      return "无权限：被服务器拒绝。";
    case 404:
      return "资源不存在：会话/接口路径可能已失效。";
    case 409:
      return "会话冲突：该会话在别处活跃，需「接管」后才能续写（多数情况可忽略）。";
    case 413:
      return "内容过大：如图片/音频超出上限。";
    case 429:
      return "频率限制：请求过于频繁，稍后重试。";
    default:
      if (e.status >= 500) return "agent 内部错误：查看本机 agent 日志（.logs/local-agent.log）。";
      if (e.status >= 400) return "请求被拒绝（4xx）：参数或状态不符合预期。";
      return "未知错误。";
  }
}

/** A structured text block to paste into an AI for analysis. */
export function formatNetErrorsForCopy(ctx?: { serverUrl?: string; appUrl?: string; ua?: string }): string {
  const lines: string[] = ["# 接口错误日志"];
  if (ctx?.serverUrl) lines.push(`服务器: ${ctx.serverUrl}`);
  if (ctx?.appUrl) lines.push(`页面: ${ctx.appUrl}`);
  if (ctx?.ua) lines.push(`UA: ${ctx.ua}`);
  lines.push(`安全上下文: ${typeof window !== "undefined" ? window.isSecureContext : "?"}`);
  lines.push(`在线: ${typeof navigator !== "undefined" ? navigator.onLine : "?"}`);
  lines.push(`共 ${entries.length} 条`, "");
  for (const e of entries) {
    const t = new Date(e.ts).toISOString();
    lines.push(
      `- [${t}] ${e.method} ${e.path} → ${e.status === 0 ? e.kind : e.status} | ${e.message}` +
        (e.detail ? ` | ${e.detail}` : ""),
    );
    lines.push(`  诊断: ${diagnoseNetError(e)}`);
  }
  return lines.join("\n");
}
