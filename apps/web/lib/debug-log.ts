"use client";

/**
 * Self-contained in-app debug console capture. No third-party deps so it works
 * offline / over LAN where a CDN-loaded console (eruda/vConsole) would not.
 * Patches console.* + global errors + fetch into a bounded in-memory ring buffer.
 */

export type DebugKind = "log" | "info" | "warn" | "error" | "network";

export type DebugEntry = {
  id: number;
  ts: number;
  kind: DebugKind;
  text: string;
  /** network-only extras */
  net?: { method: string; url: string; status?: number; ms?: number; ok?: boolean };
};

const MAX = 500;
const DEBUG_KEY = "mac.debugConsole";

let entries: DebugEntry[] = [];
let seq = 0;
let installed = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function push(kind: DebugKind, text: string, net?: DebugEntry["net"]) {
  seq += 1;
  entries.push({ id: seq, ts: Date.now(), kind, text, net });
  if (entries.length > MAX) entries = entries.slice(entries.length - MAX);
  emit();
}

export function getEntries(): DebugEntry[] {
  return entries;
}

export function clearEntries(): void {
  entries = [];
  emit();
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getDebugConsole(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

const DEBUG_EVENT = "mac-debug-console";

export function setDebugConsole(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DEBUG_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new CustomEvent(DEBUG_EVENT, { detail: on }));
}

/** React to the debug-console toggle across components. Returns an unsubscribe fn. */
export function subscribeDebugConsole(cb: (on: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => cb(!!(e as CustomEvent).detail);
  window.addEventListener(DEBUG_EVENT, handler);
  return () => window.removeEventListener(DEBUG_EVENT, handler);
}

function stringifyArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/** Idempotently patch console / errors / fetch. Originals are preserved and still run. */
export function installDebugCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const c = window.console;
  (["log", "info", "warn", "error"] as const).forEach((m) => {
    const orig = c[m].bind(c);
    c[m] = (...args: unknown[]) => {
      try {
        push(m, args.map(stringifyArg).join(" "));
      } catch {
        /* never break the app for logging */
      }
      orig(...args);
    };
  });

  window.addEventListener("error", (e) => {
    push("error", `[onerror] ${e.message}${e.filename ? ` @ ${e.filename}:${e.lineno}` : ""}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    push("error", `[unhandledrejection] ${stringifyArg(e.reason)}`);
  });

  if (typeof window.fetch === "function") {
    const origFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? (typeof input !== "string" && "method" in (input as Request) ? (input as Request).method : "GET")) || "GET";
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const start = Date.now();
      try {
        const res = await origFetch(input as RequestInfo, init);
        push("network", `${method} ${url} → ${res.status}`, {
          method,
          url,
          status: res.status,
          ms: Date.now() - start,
          ok: res.ok,
        });
        return res;
      } catch (err) {
        push("network", `${method} ${url} → ERROR ${stringifyArg(err)}`, {
          method,
          url,
          ms: Date.now() - start,
          ok: false,
        });
        throw err;
      }
    };
  }
}
