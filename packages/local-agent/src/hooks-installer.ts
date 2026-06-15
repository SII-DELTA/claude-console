import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Lifecycle events we register a state-writer hook for. */
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
  "PreToolUse",
  "PostToolUse",
] as const;

/** Substring identifying our hook command (for idempotent re-install / migration). */
const MARKER = "session-hook.mjs";

export interface InstallResult {
  installed: boolean;
  settingsPath: string;
  scriptPath: string;
  reason?: string;
}

/** Absolute path to the bundled zero-dep hook script (sibling `hooks/` dir). */
export function hookScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // src/ or dist/
  return join(here, "..", "hooks", "session-hook.mjs");
}

/** POSIX sh quoting (macOS/Linux). NOT valid for Windows cmd.exe — backslash paths
 *  like `C:\Program Files\nodejs\node.exe` would break, so install is skipped on win32. */
function shquote(s: string): string {
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

type HookGroup = { hooks?: Array<{ type?: string; command?: string }> };

/**
 * Idempotently merge our liveness hooks into the user-level `~/.claude/settings.json`.
 * - Never overwrites unrelated keys / the user's own hooks.
 * - Re-running is a no-op (and migrates the command path if the agent moved).
 * - Backs up the existing file once before the first write.
 * Returns `installed: true` only when the file actually changed (→ caller hints the
 * user that already-running sessions must restart to be tracked).
 */
export async function installLivenessHooks(opts?: {
  node?: string;
  /** override for tests */
  settingsPath?: string;
  /** override for tests */
  scriptPath?: string;
}): Promise<InstallResult> {
  const settingsPath = opts?.settingsPath ?? join(homedir(), ".claude", "settings.json");
  const scriptPath = opts?.scriptPath ?? hookScriptPath();
  const node = opts?.node ?? process.execPath;

  // Windows agent host is unsupported: the hook command quoting below is POSIX sh
  // only. Skip cleanly rather than write broken hooks into the user's settings.
  // (The phone/browser client is unaffected — only the machine running Claude Code
  // sessions matters, which this project targets as macOS/Linux.)
  if (process.platform === "win32") {
    return { installed: false, settingsPath, scriptPath, reason: "windows agent host unsupported" };
  }

  try {
    await fs.access(scriptPath);
  } catch {
    return { installed: false, settingsPath, scriptPath, reason: `hook script missing: ${scriptPath}` };
  }

  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object") settings = parsed as Record<string, unknown>;
  } catch {
    /* missing or invalid → start from {} (we back up before writing) */
  }
  const hooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Record<
    string,
    HookGroup[]
  >;
  settings.hooks = hooks;

  const before = JSON.stringify(settings);
  for (const ev of EVENTS) {
    const cmd = `${shquote(node)} ${shquote(scriptPath)} ${ev}`;
    const arr = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    // strip any prior entry of ours (dedupe + path migration), then add a fresh one
    const cleaned = arr.filter(
      (g) => !(Array.isArray(g?.hooks) && g.hooks.some((h) => typeof h?.command === "string" && h.command.includes(MARKER))),
    );
    cleaned.push({ hooks: [{ type: "command", command: cmd }] });
    hooks[ev] = cleaned;
  }
  const after = JSON.stringify(settings);
  if (before === after) return { installed: false, settingsPath, scriptPath, reason: "already installed" };

  await fs.mkdir(dirname(settingsPath), { recursive: true });
  try {
    await fs.copyFile(settingsPath, `${settingsPath}.bak`);
  } catch {
    /* no pre-existing settings to back up */
  }
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  return { installed: true, settingsPath, scriptPath };
}
