import type {
  AgentLog,
  AgentSession,
  ClaudeDriveStatus,
  ClaudeMessage,
  ClaudeSession,
  FileChange,
} from "@mac/shared";

/**
 * Internal event bus. Modules emit and listen here so REST/WS layers can stay
 * decoupled from SessionManager / PtyManager / FileChangeTracker.
 */
export type BusEvents = {
  "session:created": (s: AgentSession) => void;
  "session:updated": (s: AgentSession) => void;
  "session:deleted": (sessionId: string) => void;
  "session:log": (log: AgentLog) => void;
  "session:command_started": (sessionId: string, command: string) => void;
  "session:command_finished": (sessionId: string, exitCode: number | null) => void;
  "session:file_changed": (change: FileChange) => void;
  "claude:session_updated": (session: ClaudeSession) => void;
  "claude:message": (sessionId: string, message: ClaudeMessage) => void;
  "claude:delta": (event: {
    sessionId: string;
    delta: string;
    blockKind: "text" | "thinking" | "tool_use";
    status: ClaudeDriveStatus;
    timestamp: string;
  }) => void;
  "claude:drive_done": (
    sessionId: string,
    timestamp: string,
    usage?: import("@mac/shared").ClaudeUsage,
  ) => void;
  "claude:rate_limit": (info: {
    resetsAt?: number;
    limitType?: string;
    status?: string;
  }) => void;
  "claude:drive_error": (sessionId: string | undefined, message: string, timestamp: string) => void;
  /** An interactive permission (AskUserQuestion) is awaiting the user's choice. */
  "claude:permission_request": (
    sessionId: string,
    requestId: string,
    toolName: string,
    questions: import("@mac/shared").ClaudePermissionQuestion[],
  ) => void;
  /** A pending permission request is no longer waiting (answered/cancelled/aborted). */
  "claude:permission_cancel": (sessionId: string, requestId: string) => void;
  /** Authoritative "a turn started/stopped" signal (driver busy transition). */
  "claude:driving": (sessionId: string, driving: boolean) => void;
  "device:pair_request": (info: { deviceName: string; platform: string; pairCode: string }) => void;
  "device:paired": (deviceId: string) => void;
};

type Listener = (...args: unknown[]) => void;

export class Bus {
  private readonly listeners = new Map<keyof BusEvents, Set<Listener>>();

  on<K extends keyof BusEvents>(event: K, fn: BusEvents[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener);
    return () => set!.delete(fn as Listener);
  }

  off<K extends keyof BusEvents>(event: K, fn: BusEvents[K]): void {
    this.listeners.get(event)?.delete(fn as Listener);
  }

  emit<K extends keyof BusEvents>(event: K, ...args: Parameters<BusEvents[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (...a: unknown[]) => void)(...(args as unknown[]));
      } catch (err) {
        // Listeners must not break the bus; surface via console.
        // eslint-disable-next-line no-console
        console.error(`[bus] listener for ${String(event)} threw:`, err);
      }
    }
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
