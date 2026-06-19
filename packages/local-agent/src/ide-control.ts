// Bridge to the desktop IDE: detect which projects have a VSCode window / the inject
// plugin, map sessions to their workspace, and push a prompt into the running Claude Code
// session — via the plugin's local port (preferred) or a code+URI+osascript fallback.
// macOS-only (the agent runs on the user's Mac).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import http from "node:http";

const IDE_LOCK_DIR = join(homedir(), ".claude", "ide");
const INJECT_DIR = join(homedir(), ".claude-console", "inject");
const STATE_DIR = join(homedir(), ".claude", "session-state");

export interface IdeProject {
  cwd: string;
  hasVscode: boolean;
  hasPlugin: boolean;
}
export interface IdeSession {
  sessionId: string;
  cwd: string;
  state: string;
  pid: number | null;
  alive: boolean;
  terminal: boolean;
  /** the claude process is a child of a VSCode window (vs agent `--resume` / external) */
  inVscode: boolean;
}
export interface IdeState {
  projects: IdeProject[];
  sessions: IdeSession[];
}

interface InjectEndpoint {
  port: number;
  token: string;
  workspaceFolders: string[];
  pid?: number;
}

function readJsonDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  const out: T[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") && !f.endsWith(".lock")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as T);
    } catch {
      /* skip bad file */
    }
  }
  return out;
}

/** Workspace dirs that currently have a VSCode window (Claude Code IDE lock). */
export function ideVscodeDirs(): Set<string> {
  const set = new Set<string>();
  for (const l of readJsonDir<{ workspaceFolders?: string[] }>(IDE_LOCK_DIR)) {
    for (const w of l.workspaceFolders ?? []) set.add(w);
  }
  return set;
}

/** Inject-plugin endpoints, indexed for "does this workspace have the plugin". A crashed
 * VSCode window can leave a discovery file behind whose port may get reused by an unrelated
 * process — drop any endpoint whose owning pid is dead so we never POST a prompt to it. */
export function injectEndpoints(): InjectEndpoint[] {
  return readJsonDir<InjectEndpoint>(INJECT_DIR).filter(
    (e) => e && e.port && e.token && (e.pid == null || pidAlive(e.pid)),
  );
}

function endpointForCwd(cwd: string): InjectEndpoint | null {
  for (const e of injectEndpoints()) {
    if ((e.workspaceFolders ?? []).some((w) => cwd === w || cwd.startsWith(w + "/"))) return e;
  }
  return null;
}

function pidAlive(pid: number | null): boolean {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const execFileP = (cmd: string, args: string[]): Promise<string> =>
  new Promise((res) => execFile(cmd, args, { timeout: 8000 }, (err, stdout) => res(err ? "" : stdout)));

/** Run a command, reporting whether it actually succeeded (for honest ok/sent results). */
const runCmd = (cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> =>
  new Promise((res) => execFile(cmd, args, { timeout: 8000 }, (err, stdout) => res({ ok: !err, out: stdout || "" })));

const isMac = process.platform === "darwin";

/** One read of a session's hook state → cwd + pid (avoids re-scanning the whole dir). */
function sessionMeta(sessionId: string): { cwd: string | null; pid: number | null } {
  const f = join(STATE_DIR, `${sessionId}.json`);
  if (!existsSync(f)) return { cwd: null, pid: null };
  try {
    const d = JSON.parse(readFileSync(f, "utf8")) as { cwd?: string; pid?: number };
    return { cwd: d.cwd ?? null, pid: d.pid ?? null };
  } catch {
    return { cwd: null, pid: null };
  }
}

/** True if the pid is attached to a tty (interactive terminal), not a headless/webview proc. */
async function pidHasTty(pid: number | null): Promise<boolean> {
  if (pid == null) return false;
  const out = (await execFileP("ps", ["-o", "tty=", "-p", String(pid)])).trim();
  return out !== "" && out !== "??" && out !== "?";
}

/** One process-table snapshot: pid → { ppid, tty, comm }. Avoids per-session ps calls. */
async function processSnapshot(): Promise<Map<number, { ppid: number; tty: string; comm: string }>> {
  const map = new Map<number, { ppid: number; tty: string; comm: string }>();
  const out = await execFileP("ps", ["-axo", "pid=,ppid=,tty=,comm="]);
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) map.set(Number(m[1]), { ppid: Number(m[2]), tty: m[3] ?? "??", comm: m[4] ?? "" });
  }
  return map;
}

/** Walk a pid's ancestry; true if any ancestor is a VSCode process (Code Helper / Electron). */
function ancestryInVscode(pid: number | null, snap: Map<number, { ppid: number; comm: string }>): boolean {
  let cur = pid;
  for (let i = 0; i < 8 && cur != null && cur > 1; i++) {
    const rec = snap.get(cur);
    if (!rec) return false;
    // Anchor a bare "Code" to a path basename so we don't flag an unrelated process whose
    // name merely contains " Code"; the Helper/Electron markers cover the rest of VSCode.
    if (/Visual Studio Code|Code Helper|Electron|(?:^|\/)Code$/.test(rec.comm)) return true;
    cur = rec.ppid;
  }
  return false;
}

/** Session id → cwd, from the hook state files. */
export function cwdOfSession(sessionId: string): string | null {
  const f = join(STATE_DIR, `${sessionId}.json`);
  if (!existsSync(f)) return null;
  try {
    return (JSON.parse(readFileSync(f, "utf8")) as { cwd?: string }).cwd ?? null;
  } catch {
    return null;
  }
}

let ideCache: { at: number; val: IdeState } | null = null;
let ideInFlight: Promise<IdeState> | null = null;

/** Aggregate detection for the console UI. Cached briefly so a 20s multi-client poll doesn't
 * run a full `ps` snapshot every call; concurrent callers during a miss share one computation. */
export async function readIdeState(): Promise<IdeState> {
  if (ideCache && Date.now() - ideCache.at < 4000) return ideCache.val;
  if (ideInFlight) return ideInFlight;
  ideInFlight = computeIdeState()
    .then((val) => {
      ideCache = { at: Date.now(), val };
      return val;
    })
    .finally(() => {
      ideInFlight = null;
    });
  return ideInFlight;
}

async function computeIdeState(): Promise<IdeState> {
  const vscodeDirs = ideVscodeDirs();
  const plugins = injectEndpoints();
  const pluginDirs = new Set(plugins.flatMap((e) => e.workspaceFolders ?? []));

  const projects: IdeProject[] = [...new Set([...vscodeDirs, ...pluginDirs])].map((cwd) => ({
    cwd,
    hasVscode: vscodeDirs.has(cwd),
    hasPlugin: pluginDirs.has(cwd),
  }));

  const states = readJsonDir<{ sessionId?: string; cwd?: string; state?: string; pid?: number }>(STATE_DIR);
  const snap = await processSnapshot();
  const sessions: IdeSession[] = states
    .filter((s) => s.sessionId)
    .map((s) => {
      const pid = s.pid ?? null;
      const rec = pid != null ? snap.get(pid) : undefined;
      const tty = rec?.tty ?? "??";
      return {
        sessionId: s.sessionId!,
        cwd: s.cwd ?? "",
        state: s.state ?? "idle",
        pid,
        alive: pidAlive(pid),
        terminal: tty !== "??" && tty !== "?" && tty !== "",
        inVscode: ancestryInVscode(pid, snap),
      };
    });
  return { projects, sessions };
}

/** Focus a VSCode window by workspace (handles cross-Space; AppleScript can't). */
async function focusWindow(cwd: string): Promise<boolean> {
  const { ok } = await runCmd("code", [cwd]);
  await new Promise((r) => setTimeout(r, 900));
  return ok;
}

/** Paste the clipboard into the focused input and optionally press Return. Reports success
 * (osascript fails e.g. when Accessibility isn't granted → we must not claim it was sent). */
async function pasteAndMaybeSend(text: string, send: boolean): Promise<boolean> {
  // set clipboard via pbcopy (handles arbitrary unicode safely, never via shell/argv)
  await new Promise<void>((res) => {
    const p = execFile("pbcopy", [], () => res());
    p.stdin?.on("error", () => res());
    p.stdin?.end(text);
  });
  const sendKey = send ? "\n  delay 0.25\n  key code 36" : "";
  // only act if Code is genuinely the frontmost app — avoids pasting/Entering into whatever
  // window the user switched to during the (unavoidable) focus delay.
  const { ok } = await runCmd("osascript", [
    "-e",
    `tell application "System Events"\n  set fp to name of first process whose frontmost is true\n  if fp is not "Code" then error "Code not frontmost"\n  tell process "Code"\n    delay 0.2\n    keystroke "v" using {command down}${sendKey}\n  end tell\nend tell`,
  ]);
  return ok;
}

function postPlugin(ep: InjectEndpoint, body: object): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port: ep.port, path: "/inject", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), "x-inject-token": ep.token }, timeout: 6000 },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json: any = undefined;
          try {
            json = JSON.parse(raw);
          } catch {
            /* keep undefined */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", () => resolve({ status: 0, json: undefined }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, json: undefined });
    });
    req.end(data);
  });
}

export interface InjectResult {
  ok: boolean;
  via: "plugin" | "uri-fallback" | "none";
  sent: boolean;
  detail?: string;
}

/** Inject text into a session's running Claude Code, sending if requested. The cwd is always
 * derived from the (trusted) session id, never from the caller — no arbitrary-path control. */
export async function injectToSession(opts: {
  sessionId: string;
  text: string;
  send: boolean;
  /** cwd resolved server-side by the route (hook state or JSONL location) — never the caller. */
  cwd?: string;
}): Promise<InjectResult> {
  if (!isMac) return { ok: false, via: "none", sent: false, detail: "桌面注入仅支持 macOS" };
  const meta = sessionMeta(opts.sessionId);
  const cwd = opts.cwd ?? meta.cwd;
  const pid = meta.pid;
  if (!cwd) return { ok: false, via: "none", sent: false, detail: "找不到会话的 cwd" };
  const isTerminal = await pidHasTty(pid);

  // 1) Plugin path (preferred): silent for terminals; webview opens a normal tab + prefill.
  const ep = endpointForCwd(cwd);
  if (ep) {
    const r = await postPlugin(ep, {
      sessionId: opts.sessionId,
      text: opts.text,
      send: opts.send,
      mode: isTerminal ? "terminal" : "auto",
    });
    // Any HTTP response (not status 0) means the plugin received the request and ran the
    // command — trust its verdict and NEVER fall back, or we'd double-inject the prefill.
    if (r.status !== 0) {
      const applied = r.json?.applied === true;
      let sent = !!r.json?.sent;
      if (applied && opts.send && r.json?.needsEnter) {
        await new Promise((res) => setTimeout(res, 400));
        sent = (
          await runCmd("osascript", [
            "-e",
            `tell application "System Events"\n  if (name of first process whose frontmost is true) is "Code" then key code 36\nend tell`,
          ])
        ).ok;
      }
      return { ok: applied, via: "plugin", sent, detail: r.json?.via ?? r.json?.error };
    }
    // status 0 = plugin unreachable (didn't act) → safe to fall back to the URI path below.
  }

  // 2) URI fallback: focus window (cross-Space via `code`) → open exact session → paste (+Enter).
  await focusWindow(cwd);
  await execFileP("open", [`vscode://anthropic.claude-code/open?session=${encodeURIComponent(opts.sessionId)}`]);
  await new Promise((r) => setTimeout(r, 1100));
  const ok = await pasteAndMaybeSend(opts.text, opts.send);
  return { ok, via: "uri-fallback", sent: ok && opts.send };
}

/** Open a project folder in VSCode. Caller (route) must validate cwd is a known project. */
export async function openInVscode(cwd: string): Promise<boolean> {
  if (!isMac) return false;
  return (await runCmd("code", [cwd])).ok;
}
