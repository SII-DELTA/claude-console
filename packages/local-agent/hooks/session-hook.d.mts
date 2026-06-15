export interface HookStateOut {
  sessionId: string | null;
  cwd: string | null;
  state: "idle" | "busy" | "ended";
  transcriptPath: string | null;
  currentTool: string | null;
  lastEvent: string;
  version: string | null;
}

/** Pure lifecycle-event → state transition (see session-hook.mjs). */
export function computeHookState(
  prev: Partial<HookStateOut>,
  event: string,
  payload: Record<string, unknown>,
): HookStateOut;

/** Absolute path to `~/.claude/session-state`. */
export function stateDir(): string;
