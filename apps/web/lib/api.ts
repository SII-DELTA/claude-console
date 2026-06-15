import type {
  AgentSession,
  ClaudeImage,
  ClaudeMessage,
  ClaudePermissionMode,
  ClaudeProject,
  ClaudeSession,
  ListWorkspacesResponse,
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

  private async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    // fail fast instead of hanging forever when the agent isn't reachable
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12_000);
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

  health(): Promise<{ ok: boolean }> {
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

  // ─────────────── Claude Code sessions ───────────────

  claudeSessions(): Promise<{ sessions: ClaudeSession[] }> {
    return this.request("GET", "/claude/sessions");
  }

  claudeSession(
    id: string,
    opts?: { limit?: number; before?: number },
  ): Promise<{ session: ClaudeSession; messages: ClaudeMessage[]; total: number; offset: number }> {
    const qs = new URLSearchParams();
    if (opts?.limit != null) qs.set("limit", String(opts.limit));
    if (opts?.before != null) qs.set("before", String(opts.before));
    const q = qs.toString();
    return this.request("GET", `/claude/sessions/${id}${q ? `?${q}` : ""}`);
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
    return this.request("POST", "/claude/sessions", body);
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
    return this.request("POST", `/claude/sessions/${id}/continue`, body);
  }

  interruptClaudeSession(id: string): Promise<{ ok: true }> {
    return this.request("POST", `/claude/sessions/${id}/interrupt`);
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
