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
}
export interface IdeState {
  projects: IdeProject[];
  sessions: IdeSession[];
}

interface InjectEndpoint {
  port: number;
  token: string;
  workspaceFolders: string[];
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

/** Inject-plugin endpoints, indexed for "does this workspace have the plugin". */
export function injectEndpoints(): InjectEndpoint[] {
  return readJsonDir<InjectEndpoint>(INJECT_DIR).filter((e) => e && e.port && e.token);
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

/** True if the pid is attached to a tty (interactive terminal), not a headless/webview proc. */
async function pidHasTty(pid: number | null): Promise<boolean> {
  if (pid == null) return false;
  const out = (await execFileP("ps", ["-o", "tty=", "-p", String(pid)])).trim();
  return out !== "" && out !== "??" && out !== "?";
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

/** Aggregate detection for the console UI. */
export async function readIdeState(): Promise<IdeState> {
  const vscodeDirs = ideVscodeDirs();
  const plugins = injectEndpoints();
  const pluginDirs = new Set(plugins.flatMap((e) => e.workspaceFolders ?? []));

  const projects: IdeProject[] = [...new Set([...vscodeDirs, ...pluginDirs])].map((cwd) => ({
    cwd,
    hasVscode: vscodeDirs.has(cwd),
    hasPlugin: pluginDirs.has(cwd),
  }));

  const states = readJsonDir<{ sessionId?: string; cwd?: string; state?: string; pid?: number }>(STATE_DIR);
  const sessions: IdeSession[] = await Promise.all(
    states
      .filter((s) => s.sessionId)
      .map(async (s) => ({
        sessionId: s.sessionId!,
        cwd: s.cwd ?? "",
        state: s.state ?? "idle",
        pid: s.pid ?? null,
        alive: pidAlive(s.pid ?? null),
        terminal: await pidHasTty(s.pid ?? null),
      })),
  );
  return { projects, sessions };
}

function osascript(script: string): Promise<string> {
  return execFileP("osascript", ["-e", script]);
}

/** Focus a VSCode window by workspace (handles cross-Space; AppleScript can't). */
async function focusWindow(cwd: string): Promise<void> {
  await execFileP("code", [cwd]);
  await new Promise((r) => setTimeout(r, 900));
}

/** Paste the clipboard into the focused input and optionally press Return. */
async function pasteAndMaybeSend(text: string, send: boolean): Promise<void> {
  // set clipboard via pbcopy (handles arbitrary unicode safely)
  await new Promise<void>((res) => {
    const p = execFile("pbcopy", [], () => res());
    p.stdin?.end(text);
  });
  const sendKey = send ? "\n  delay 0.25\n  key code 36" : "";
  await osascript(
    `tell application "System Events" to tell process "Code"\n  set frontmost to true\n  delay 0.3\n  keystroke "v" using {command down}${sendKey}\nend tell`,
  );
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

/** Inject text into a session's running Claude Code, sending if requested. */
export async function injectToSession(opts: {
  sessionId: string;
  cwd?: string;
  text: string;
  send: boolean;
}): Promise<InjectResult> {
  const cwd = opts.cwd ?? cwdOfSession(opts.sessionId);
  if (!cwd) return { ok: false, via: "none", sent: false, detail: "找不到会话的 cwd" };

  const isTerminal = await pidHasTty(
    (readJsonDir<{ sessionId?: string; pid?: number }>(STATE_DIR).find((s) => s.sessionId === opts.sessionId) || {})
      .pid ?? null,
  );

  // 1) Plugin path (preferred): silent for terminals; webview opens a normal tab + prefill.
  const ep = endpointForCwd(cwd);
  if (ep) {
    const r = await postPlugin(ep, {
      sessionId: opts.sessionId,
      text: opts.text,
      send: opts.send,
      mode: isTerminal ? "terminal" : "auto",
    });
    if (r.status === 200 && r.json?.applied) {
      // webview can't submit programmatically → press Enter via osascript when sending
      let sent = !!r.json.sent;
      if (opts.send && r.json.needsEnter) {
        await new Promise((res) => setTimeout(res, 400));
        await osascript(
          `tell application "System Events" to tell process "Code"\n  set frontmost to true\n  delay 0.2\n  key code 36\nend tell`,
        );
        sent = true;
      }
      return { ok: true, via: "plugin", sent, detail: r.json.via };
    }
    // plugin reachable but failed → fall through to URI
  }

  // 2) URI fallback: focus window (cross-Space via `code`) → open exact session → paste (+Enter).
  await focusWindow(cwd);
  await execFileP("open", [`vscode://anthropic.claude-code/open?session=${opts.sessionId}`]);
  await new Promise((r) => setTimeout(r, 1100));
  await pasteAndMaybeSend(opts.text, opts.send);
  return { ok: true, via: "uri-fallback", sent: opts.send };
}

/** Open a project folder in VSCode. */
export async function openInVscode(cwd: string): Promise<void> {
  await execFileP("code", [cwd]);
}
