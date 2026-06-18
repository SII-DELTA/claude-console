import type {
  AgentSession,
  ClaudeImage,
  ClaudeMessage,
  ClaudePendingPermission,
  ClaudeToolApproval,
  ClaudePermissionMode,
  ClaudeProject,
  ClaudeSession,
  FsListResponse,
  ListWorkspacesResponse,
  PushSubscriptionJSON,
  Workspace,
} from "@mac/shared";

export interface PairResult {
  token: string;
  device: { id: string; name: string; platform: string };
  workspace: { id: string; name: string; rootPath: string };
  serverVersion: string;
}

export class ApiClient {
  constructor(
    public readonly baseUrl: string,
    private token: string | null = null,
  ) {}

  setToken(token: string | null): void {
    this.token = token;
  }

  private async request<T>(
    method: string,
    pathname: string,
    body?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    // fail fast instead of hanging forever when the agent isn't reachable.
    // Default 12s for light GETs; heavy mutations (new/continue) pass a longer
    // budget — a cold `claude --resume` (process spawn + large jsonl parse over a
    // remote Tailscale link) legitimately needs more than 12s before it acks.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts?.timeoutMs ?? 12_000);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
    } catch (e) {
      if (ac.signal.aborted) throw new ApiError(`${method} ${pathname} → timeout`, 0, "无法连接到服务器（超时）");
      throw new ApiError(`${method} ${pathname} → network`, 0, "无法连接到服务器");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let payload: unknown = undefined;
      const text = await res.text();
      try {
        payload = JSON.parse(text);
      } catch {
        /* keep text */
      }
      throw new ApiError(`${method} ${pathname} → ${res.status}`, res.status, payload ?? text);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  health(): Promise<{ ok: boolean; version?: string; auth?: "none" | "password" | "pair" }> {
    return this.request("GET", "/health");
  }

  pair(input: {
    pairCode: string;
    deviceName: string;
    platform: "ios" | "android" | "web" | "unknown";
  }): Promise<PairResult> {
    return this.request("POST", "/auth/pair", input);
  }

  /** Login → { token, workspace }. token is "" in no-auth mode. */
  login(input: {
    password: string;
    deviceName: string;
    platform: "ios" | "android" | "web" | "unknown";
  }): Promise<{ token: string; workspace: Workspace }> {
    return this.request("POST", "/auth/login", input);
  }

  workspaces(): Promise<ListWorkspacesResponse> {
    return this.request("GET", "/workspaces");
  }

  switchWorkspace(input: { workspaceId?: string; rootPath?: string }): Promise<{
    workspace: Workspace;
    workspaces: Workspace[];
  }> {
    return this.request("POST", "/workspaces/switch", input);
  }

  // ─────────────── Claude Code projects ───────────────

  claudeProjects(): Promise<{ projects: ClaudeProject[] }> {
    return this.request("GET", "/claude/projects");
  }

  switchClaudeProject(dir: string): Promise<{ project: ClaudeProject; sessions: ClaudeSession[] }> {
    return this.request("POST", "/claude/projects/switch", { dir });
  }

  hideClaudeProject(dir: string): Promise<{ projects: ClaudeProject[] }> {
    return this.request("POST", "/claude/projects/hide", { dir });
  }

  unhideClaudeProject(dir: string): Promise<{ projects: ClaudeProject[] }> {
    return this.request("POST", "/claude/projects/unhide", { dir });
  }

  addClaudeProject(cwd: string): Promise<{ projects: ClaudeProject[] }> {
    return this.request("POST", "/claude/projects/add", { cwd });
  }

  /** Browse a directory on the host (folders only) for the project picker. */
  fsList(path?: string): Promise<FsListResponse> {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    return this.request("GET", `/claude/fs/list${q}`);
  }

  // ─────────────── Claude Code sessions ───────────────

  claudeSessions(): Promise<{ sessions: ClaudeSession[] }> {
    return this.request("GET", "/claude/sessions");
  }

  /** Sessions across all projects (dashboard overview). */
  claudeAllSessions(): Promise<{ sessions: ClaudeSession[] }> {
    return this.request("GET", "/claude/sessions/all");
  }

  claudeSession(
    id: string,
    opts?: { limit?: number; before?: number },
  ): Promise<{ session: ClaudeSession; messages: ClaudeMessage[]; total: number; offset: number; cursor?: number }> {
    const qs = new URLSearchParams();
    if (opts?.limit != null) qs.set("limit", String(opts.limit));
    if (opts?.before != null) qs.set("before", String(opts.before));
    const q = qs.toString();
    return this.request("GET", `/claude/sessions/${id}${q ? `?${q}` : ""}`);
  }

  /** Incremental tail: messages appended since `cursor` (a byte offset), plus the new cursor. */
  claudeSessionTail(
    id: string,
    cursor: number,
  ): Promise<{ session: ClaudeSession; messages: ClaudeMessage[]; cursor: number }> {
    return this.request("GET", `/claude/sessions/${id}/tail?cursor=${cursor}`);
  }

  /** Preview a file referenced in a transcript (restricted to the session cwd subtree). */
  previewFile(
    cwd: string,
    path: string,
  ): Promise<{
    path: string;
    relPath: string;
    kind: "text" | "markdown" | "image" | "binary";
    content?: string;
    mediaType?: string;
    truncated?: boolean;
    size: number;
  }> {
    const qs = new URLSearchParams({ cwd, path });
    return this.request("GET", `/files/preview?${qs.toString()}`);
  }

  /** Start a brand new Claude session. Returns the generated session id. */
  newClaudeSession(
    prompt: string,
    cwd?: string,
    images?: ClaudeImage[],
    permissionMode?: ClaudePermissionMode,
  ): Promise<{ sessionId: string }> {
    const body: Record<string, unknown> = { prompt };
    if (cwd) body.cwd = cwd;
    if (images?.length) body.images = images;
    if (permissionMode) body.permissionMode = permissionMode;
    return this.request("POST", "/claude/sessions", body, { timeoutMs: 45_000 });
  }

  /** Resume an existing session. Throws ApiError(409) if live and !force. */
  continueClaudeSession(
    id: string,
    prompt: string,
    force = false,
    images?: ClaudeImage[],
    permissionMode?: ClaudePermissionMode,
  ): Promise<{ ok: true }> {
    const body: Record<string, unknown> = { prompt };
    if (force) body.force = force;
    if (images?.length) body.images = images;
    if (permissionMode) body.permissionMode = permissionMode;
    return this.request("POST", `/claude/sessions/${id}/continue`, body, { timeoutMs: 45_000 });
  }

  interruptClaudeSession(id: string): Promise<{ ok: true }> {
    return this.request("POST", `/claude/sessions/${id}/interrupt`);
  }

  /** Recover pending interactive permissions for a session (survives reload/restart). */
  getClaudePendingPermission(
    id: string,
  ): Promise<{ pending: ClaudePendingPermission[]; approvals?: ClaudeToolApproval[] }> {
    return this.request("GET", `/claude/sessions/${id}/pending-permission`);
  }

  /** Answer a pending tool approval (non-AskUserQuestion): allow once / deny. */
  answerClaudeToolApproval(
    id: string,
    requestId: string,
    decision: "allow" | "deny",
  ): Promise<{ ok: true }> {
    return this.request("POST", `/claude/sessions/${id}/answer-tool-approval`, {
      requestId,
      decision,
    });
  }

  /** Dismiss a session's lingering question(s) without answering (clears the badge). */
  dismissClaudeQuestion(id: string): Promise<{ ok: true; dismissed: number }> {
    return this.request("POST", `/claude/sessions/${id}/dismiss-question`);
  }

  /** Close a live picker without answering (claude is told the user declined). */
  declineClaudePermission(id: string, requestId: string): Promise<{ ok: true }> {
    return this.request("POST", `/claude/sessions/${id}/decline-permission`, { requestId });
  }

  /** Answer a pending interactive permission (AskUserQuestion, 方案 B). */
  answerClaudePermission(
    id: string,
    requestId: string,
    answers: Record<string, string | string[]>,
  ): Promise<{ ok: true }> {
    return this.request("POST", `/claude/sessions/${id}/answer-permission`, {
      requestId,
      answers,
    });
  }

  /** Pre-spawn the warm process so the first prompt skips process startup. */
  prewarmClaudeSession(id: string): Promise<{ warmed: boolean }> {
    return this.request("POST", `/claude/sessions/${id}/prewarm`);
  }

  /** Transcribe 16k mono PCM (base64) via Tencent ASR. */
  asr(audioBase64: string): Promise<{ text: string }> {
    return this.request("POST", "/asr", { audioBase64, format: "pcm" });
  }

  // shell/pty sessions (kept for completeness; not used by the Claude console UI)
  listSessions(): Promise<{ sessions: AgentSession[] }> {
    return this.request("GET", "/sessions");
  }

  // ─────────────── Web Push ───────────────
  pushVapidPublicKey(): Promise<{ enabled: boolean; publicKey: string | null }> {
    return this.request("GET", "/push/vapid-public-key");
  }
  pushSubscribe(sub: PushSubscriptionJSON): Promise<{ ok: true }> {
    return this.request("POST", "/push/subscribe", sub);
  }
  pushUnsubscribe(endpoint: string): Promise<{ ok: true }> {
    return this.request("POST", "/push/unsubscribe", { endpoint });
  }

  // Claude API usage quota
  getUsage(): Promise<{
    five_hour: { utilization: number; resets_at: string } | null;
    seven_day: { utilization: number; resets_at: string } | null;
  }> {
    return this.request("GET", "/usage");
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isUnauthorizedError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

export function isLiveConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}
