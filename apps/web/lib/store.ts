"use client";

import { create } from "zustand";
import type {
  ClaudeImage,
  ClaudeMessage,
  ClaudeMessageBlock,
  ClaudePermissionMode,
  ClaudePermissionQuestion,
  ClaudeProject,
  ClaudeSession,
  ClaudeUsage,
  ServerMessage,
} from "@mac/shared";
import { ApiClient, ApiError, isLiveConflict, isUnauthorizedError } from "./api";
import { WsClient } from "./ws";
import { ensureNotificationPermission, notify } from "./notify";

const STORAGE_KEY = "mac.connection";
const PERM_KEY = "mac.permissionMode";

function loadPermissionMode(): ClaudePermissionMode {
  if (typeof window === "undefined") return "acceptEdits";
  let v: string | null = null;
  try {
    v = window.localStorage.getItem(PERM_KEY);
  } catch {
    /* storage unavailable (SSR/test env) — fall back to default */
  }
  return v === "plan" || v === "auto" || v === "default" || v === "bypassPermissions"
    ? v
    : "acceptEdits";
}

/** pending WS auto-reconnect timer (module-scoped; one socket at a time) */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** debounce so we only pre-warm a session you actually dwell on */
let prewarmTimer: ReturnType<typeof setTimeout> | null = null;

/** messages fetched on each "load earlier" step */
const HISTORY_PAGE = 40;
/** messages rendered on first opening a session (configurable via env, default 10) */
const INITIAL_MESSAGES = Number(process.env.NEXT_PUBLIC_INITIAL_MESSAGES) || 10;
/** how many recently-viewed sessions to keep rendered in memory */
const SESSION_CACHE_MAX = 5;
/** in-memory cache of recently viewed sessions → instant switch-back (no refetch/re-render churn) */
const sessionCache = new Map<string, { messages: ClaudeMessage[]; historyOffset: number }>();
function cacheSet(id: string, messages: ClaudeMessage[], historyOffset: number): void {
  sessionCache.delete(id); // re-insert to move to MRU
  sessionCache.set(id, { messages, historyOffset });
  while (sessionCache.size > SESSION_CACHE_MAX) {
    const oldest = sessionCache.keys().next().value;
    if (oldest === undefined) break;
    sessionCache.delete(oldest);
  }
}

/** Reflect the open project/session in the URL so a reload restores them. */
function syncUrl(projectDir: string | null, sessionId: string | null): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams();
  if (projectDir) params.set("p", projectDir);
  if (sessionId) params.set("s", sessionId);
  const qs = params.toString();
  window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
}

export interface Connection {
  url: string;
  wsUrl: string;
  token: string;
  workspaceId: string;
  workspaceName: string;
}

export type DriveStatus = "idle" | "streaming";

/** Active bottom-tab on mobile (desktop keeps the sidebar layout, ignores this). */
export type MobileTab = "dashboard" | "sessions" | "settings";

/** Live streaming buffer for the session currently being driven. */
export interface StreamBuffer {
  /** null until a new session's id is known (set once POST returns / first delta). */
  sessionId: string | null;
  text: string;
  thinking: string;
  tools: string[];
}

interface AppState {
  connection: Connection | null;
  api: ApiClient | null;
  ws: WsClient | null;
  wsConnected: boolean;

  projects: ClaudeProject[];
  activeProjectDir: string | null;
  sessions: ClaudeSession[];
  selectedId: string | null;
  /** which bottom tab is active on mobile (home view when no session is open) */
  mobileTab: MobileTab;
  messages: ClaudeMessage[];
  /** start index of the loaded slice within the full history; >0 means older messages exist */
  historyOffset: number;
  loadingEarlier: boolean;
  loadingDetail: boolean;
  stream: StreamBuffer | null;
  driveStatus: DriveStatus;
  /** usage of the last completed turn for the selected session */
  lastUsage: { sessionId: string; usage: ClaudeUsage } | null;
  permissionMode: ClaudePermissionMode;
  rateLimit: { resetsAt?: number; limitType?: string; status?: string } | null;
  /** An interactive AskUserQuestion awaiting the user's choice (方案 B). */
  pendingPermission: {
    sessionId: string;
    requestId: string;
    toolName: string;
    questions: ClaudePermissionQuestion[];
    /** false ⇒ recovered from history (process gone); answering will resume the session. */
    live?: boolean;
  } | null;
  error: string | null;

  setConnection: (c: Connection | null) => void;
  setMobileTab: (t: MobileTab) => void;
  setPermissionMode: (m: ClaudePermissionMode) => void;
  connectWs: () => void;
  loadProjects: () => Promise<void>;
  switchProject: (dir: string) => Promise<void>;
  /** restore project + session from the URL (?p=&s=) on first load */
  restoreFromUrl: () => Promise<void>;
  loadSessions: () => Promise<void>;
  selectSession: (id: string | null) => Promise<void>;
  /** load one older page of messages (prepended) for the selected session */
  loadEarlier: () => Promise<void>;
  /** Send a prompt: resumes selected session, or starts a new one if none selected.
   *  Resolves true on success, false on failure (so the composer can keep the draft). */
  sendPrompt: (prompt: string, opts?: { force?: boolean; images?: ClaudeImage[] }) => Promise<boolean>;
  interrupt: () => Promise<void>;
  /** Answer the pending interactive permission (方案 B). */
  answerPermission: (answers: Record<string, string | string[]>) => Promise<void>;
  /** Pull any pending interactive permission for a session (recover after reload/restart). */
  refreshPendingPermission: (sessionId: string) => Promise<void>;
  /** Surface a user-facing error in the global dismissable Toast. */
  setError: (msg: string) => void;
  clearError: () => void;
}

function loadInitialConnection(): Connection | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Connection>;
    // token may legitimately be "" in no-auth mode, so check it's defined, not truthy
    if (!p.url || !p.wsUrl || p.token == null || !p.workspaceId || !p.workspaceName) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    // Mixed content: an https page can't talk to an http agent. If we saved an
    // http connection but the page is now https, discard it → re-login picks the
    // https default and avoids silent blocked requests.
    if (window.location.protocol === "https:" && p.url.startsWith("http://")) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return p as Connection;
  } catch {
    return null;
  }
}

const initial = loadInitialConnection();

export const useAppStore = create<AppState>((set, get) => ({
  connection: initial,
  api: initial ? new ApiClient(initial.url, initial.token) : null,
  ws: null,
  wsConnected: false,

  projects: [],
  activeProjectDir: null,
  sessions: [],
  selectedId: null,
  mobileTab: "dashboard",
  messages: [],
  historyOffset: 0,
  loadingEarlier: false,
  loadingDetail: false,
  stream: null,
  driveStatus: "idle",
  lastUsage: null,
  permissionMode: loadPermissionMode(),
  rateLimit: null,
  pendingPermission: null,
  error: null,

  setPermissionMode(m) {
    if (typeof window !== "undefined") window.localStorage.setItem(PERM_KEY, m);
    set({ permissionMode: m });
  },

  setMobileTab(t) {
    set({ mobileTab: t });
  },

  setConnection(c) {
    if (typeof window !== "undefined") {
      if (c) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
      else window.localStorage.removeItem(STORAGE_KEY);
    }
    get().ws?.close();
    sessionCache.clear();
    set({
      connection: c,
      api: c ? new ApiClient(c.url, c.token) : null,
      ws: null,
      wsConnected: false,
      sessions: [],
      selectedId: null,
      messages: [],
      historyOffset: 0,
      loadingEarlier: false,
      stream: null,
      driveStatus: "idle",
    });
    if (c) {
      get().connectWs();
      void get().loadProjects();
      void get().loadSessions();
    }
  },

  async loadProjects() {
    const api = get().api;
    if (!api) return;
    try {
      const res = await api.claudeProjects();
      const active = res.projects.find((p) => p.active)?.dir ?? get().activeProjectDir;
      set({ projects: res.projects, activeProjectDir: active });
    } catch {
      /* projects are optional UI sugar; ignore failures */
    }
  },

  async restoreFromUrl() {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const p = params.get("p");
    const s = params.get("s");
    if (!p && !s) return;
    if (p && p !== get().activeProjectDir) await get().switchProject(p);
    if (s) await get().selectSession(s);
  },

  async switchProject(dir) {
    const api = get().api;
    if (!api || dir === get().activeProjectDir) return;
    try {
      const res = await api.switchClaudeProject(dir);
      sessionCache.clear();
      set({
        activeProjectDir: dir,
        sessions: res.sessions,
        selectedId: null,
        messages: [],
        historyOffset: 0,
        loadingEarlier: false,
        stream: null,
        driveStatus: "idle",
        projects: get().projects.map((p) => ({ ...p, active: p.dir === dir })),
      });
      syncUrl(dir, null);
    } catch (err) {
      set({ error: describeError(err) });
    }
  },

  connectWs() {
    const conn = get().connection;
    if (!conn) return;
    get().ws?.close();
    const ws = new WsClient({
      url: conn.wsUrl,
      token: conn.token,
      onOpen: () => {
        set({ wsConnected: true });
        // a picker may have been raised while we were disconnected — recover it
        const sel = get().selectedId;
        if (sel) void get().refreshPendingPermission(sel);
      },
      onClose: () => {
        set({ wsConnected: false });
        // auto-reconnect while a connection is configured (3s backoff)
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          if (get().connection) get().connectWs();
        }, 3000);
      },
      onMessage: (msg) => handleServerMessage(msg, set, get),
    });
    ws.open();
    set({ ws });
  },

  async loadSessions() {
    const api = get().api;
    if (!api) return;
    try {
      const res = await api.claudeSessions();
      set({ sessions: res.sessions });
    } catch (err) {
      // saved token no longer valid → return to a clean login instead of a broken console
      if (isUnauthorizedError(err)) {
        get().setConnection(null);
        return;
      }
      set({ error: describeError(err) });
    }
  },

  async selectSession(id) {
    if (prewarmTimer) clearTimeout(prewarmTimer);
    // a pending picker belongs to the session we're leaving; drop it
    set({ selectedId: id, stream: null, pendingPermission: null });
    syncUrl(get().activeProjectDir, id);
    if (!id) {
      set({ messages: [], historyOffset: 0, loadingEarlier: false });
      return;
    }
    // recover any picker left pending on this session (missed event / reload / restart)
    void get().refreshPendingPermission(id);
    const api = get().api;
    if (!api) return;
    // Instant restore from in-memory cache: switching back to a recently viewed
    // session shows immediately, no refetch / re-render churn.
    const cached = sessionCache.get(id);
    if (cached) {
      set({
        messages: cached.messages,
        historyOffset: cached.historyOffset,
        loadingEarlier: false,
        loadingDetail: false,
      });
      // only re-validate if the session may have changed since we cached it
      const sess = get().sessions.find((s) => s.id === id);
      if (sess?.isLive || sess?.drivenByAgent) void revalidateTail(api, id, set, get);
      return;
    }
    set({ messages: [], historyOffset: 0, loadingEarlier: false, loadingDetail: true });
    try {
      const res = await api.claudeSession(id, { limit: INITIAL_MESSAGES });
      // guard against a race where the user switched away mid-fetch
      if (get().selectedId === id) {
        cacheSet(id, res.messages, res.offset);
        set({
          messages: res.messages,
          historyOffset: res.offset,
          sessions: upsertSession(get().sessions, res.session),
        });
        // pre-warm after a short dwell (skip if just browsing through sessions),
        // only for idle sessions not already driven elsewhere
        if (!res.session.isLive && !res.session.drivenByAgent) {
          prewarmTimer = setTimeout(() => {
            if (get().selectedId === id) void api.prewarmClaudeSession(id).catch(() => {});
          }, 1200);
        }
      }
    } catch (err) {
      set({ error: describeError(err) });
    } finally {
      set({ loadingDetail: false });
    }
  },

  async loadEarlier() {
    const { api, selectedId, historyOffset, loadingEarlier } = get();
    if (!api || !selectedId || loadingEarlier || historyOffset <= 0) return;
    set({ loadingEarlier: true });
    try {
      const res = await api.claudeSession(selectedId, {
        before: historyOffset,
        limit: HISTORY_PAGE,
      });
      if (get().selectedId === selectedId) {
        const merged = [...res.messages, ...get().messages];
        cacheSet(selectedId, merged, res.offset);
        set({ messages: merged, historyOffset: res.offset });
      }
    } catch (err) {
      set({ error: describeError(err) });
    } finally {
      set({ loadingEarlier: false });
    }
  },

  async sendPrompt(prompt, opts) {
    const api = get().api;
    if (!api || !prompt.trim()) return false;
    ensureNotificationPermission(); // first send is a user gesture
    const selected = get().selectedId;
    const images = opts?.images;
    // Optimistic user bubble so the message shows instantly (never "swallowed").
    const userMsg = optimisticUserMessage(prompt, selected, images);
    try {
      if (selected) {
        set({
          messages: [...get().messages, userMsg],
          driveStatus: "streaming",
          stream: { sessionId: selected, text: "", thinking: "", tools: [] },
        });
        await api.continueClaudeSession(selected, prompt, opts?.force, images, get().permissionMode);
      } else {
        // New session: id is unknown until POST returns. Start streaming with a
        // null sessionId; the delta handler adopts the id from the first event.
        set({
          messages: [userMsg],
          driveStatus: "streaming",
          stream: { sessionId: null, text: "", thinking: "", tools: [] },
        });
        const { sessionId } = await api.newClaudeSession(
          prompt,
          undefined,
          images,
          get().permissionMode,
        );
        set((s) => ({
          selectedId: sessionId,
          stream: s.stream ? { ...s.stream, sessionId: s.stream.sessionId ?? sessionId } : s.stream,
        }));
      }
      return true;
    } catch (err) {
      set({
        driveStatus: "idle",
        stream: null,
        messages: get().messages.filter((m) => m.id !== userMsg.id),
      });
      if (isLiveConflict(err)) {
        const e = err as ApiError;
        const msg =
          (e.body as { message?: string } | undefined)?.message ??
          "该会话在终端仍活跃，确认要接管吗？";
        set({ error: `LIVE:${msg}` });
      } else {
        set({ error: describeError(err) });
      }
      return false;
    }
  },

  async interrupt() {
    const api = get().api;
    const id = get().selectedId;
    if (!api || !id) return;
    try {
      await api.interruptClaudeSession(id);
    } catch {
      /* ignore */
    }
    set({ driveStatus: "idle", stream: null });
  },

  async answerPermission(answers) {
    const api = get().api;
    const p = get().pendingPermission;
    if (!api || !p) return;
    // optimistic dismiss; server also emits a cancel once the CLI is answered
    set({ pendingPermission: null });
    try {
      await api.answerClaudePermission(p.sessionId, p.requestId, answers);
    } catch (err) {
      // restore so the user can retry if the request was still pending
      if (isLiveConflict(err)) {
        // 409 = no longer pending (already answered / turn ended); stay dismissed
      } else {
        set({ pendingPermission: p, error: "提交选择失败，请重试" });
      }
    }
  },

  async refreshPendingPermission(sessionId) {
    const api = get().api;
    if (!api || !sessionId) return;
    try {
      const res = await api.getClaudePendingPermission(sessionId);
      // ignore if the user switched away while the request was in flight
      if (get().selectedId !== sessionId) return;
      const first = res.pending[0];
      if (first) {
        set({
          pendingPermission: {
            sessionId,
            requestId: first.requestId,
            toolName: first.toolName,
            questions: first.questions,
            live: first.live,
          },
        });
      } else if (get().pendingPermission?.sessionId === sessionId) {
        // server says nothing pending → clear any stale local picker
        set({ pendingPermission: null });
      }
    } catch {
      /* recovery is best-effort; ignore failures */
    }
  },

  setError(msg) {
    set({ error: msg });
  },

  clearError() {
    set({ error: null });
  },
}));

/* ─────────────────────────── helpers ─────────────────────────── */

function upsertSession(list: ClaudeSession[], s: ClaudeSession): ClaudeSession[] {
  const idx = list.findIndex((x) => x.id === s.id);
  const next = idx >= 0 ? list.map((x, i) => (i === idx ? s : x)) : [s, ...list];
  return [...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function upsertMessage(list: ClaudeMessage[], m: ClaudeMessage): ClaudeMessage[] {
  const idx = list.findIndex((x) => x.id === m.id);
  if (idx >= 0) return list.map((x, i) => (i === idx ? m : x));
  return [...list, m];
}

function handleServerMessage(
  msg: ServerMessage,
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): void {
  switch (msg.type) {
    case "server:claude_session_updated": {
      set({ sessions: upsertSession(get().sessions, msg.session) });
      // Authoritative reconciliation: the session JSONL drives the "question"
      // attention flag (cleared once a non-error answer lands). If it's no longer
      // a question, drop any lingering picker we may hold — covers a missed
      // permission_cancel (brief disconnect) or an answer made on another client.
      const p = get().pendingPermission;
      if (p && p.sessionId === msg.session.id && msg.session.attention !== "question") {
        set({ pendingPermission: null });
      }
      break;
    }
    case "server:claude_message": {
      const st = get();
      if (msg.sessionId !== st.selectedId) break;
      const streamingThis = st.driveStatus === "streaming" && isStreamSession(st, msg.sessionId);
      // Turn-end fallback: if an assistant message lands while we're still
      // "streaming" (e.g. drive_done was missed in a race), end the turn here.
      if (streamingThis && msg.message.role === "assistant") {
        void endTurn(set, get, msg.sessionId);
        break;
      }
      // While actively streaming, the live bubble shows tokens; suppress live
      // commits to avoid duplicates (endTurn refetches the authoritative set).
      if (!streamingThis) {
        const next = upsertMessage(st.messages, msg.message);
        cacheSet(msg.sessionId, next, st.historyOffset);
        set({ messages: next });
      }
      break;
    }
    case "server:claude_delta": {
      const cur = get().stream;
      if (get().driveStatus !== "streaming" || !cur) break;
      // Adopt the id for a freshly-created session (cur.sessionId still null).
      if (cur.sessionId && cur.sessionId !== msg.sessionId) break;
      const next: StreamBuffer = { ...cur, sessionId: msg.sessionId };
      if (msg.blockKind === "thinking") next.thinking += msg.delta;
      else if (msg.blockKind === "tool_use") next.tools = [...next.tools, msg.delta];
      else next.text += msg.delta;
      set({ stream: next });
      break;
    }
    case "server:claude_drive_done": {
      if (isStreamSession(get(), msg.sessionId)) {
        if (msg.usage) set({ lastUsage: { sessionId: msg.sessionId, usage: msg.usage } });
        const title = get().sessions.find((s) => s.id === msg.sessionId)?.title;
        notify("✅ Claude 完成一轮", title);
        void endTurn(set, get, msg.sessionId);
      }
      break;
    }
    case "server:claude_drive_error": {
      notify("⚠️ Claude 出错", msg.message);
      set({ driveStatus: "idle", stream: null, error: msg.message || "驱动失败" });
      break;
    }
    case "server:claude_rate_limit": {
      set({ rateLimit: { resetsAt: msg.resetsAt, limitType: msg.limitType, status: msg.status } });
      break;
    }
    case "server:claude_permission_request": {
      if (msg.sessionId !== get().selectedId) break;
      set({
        pendingPermission: {
          sessionId: msg.sessionId,
          requestId: msg.requestId,
          toolName: msg.toolName,
          questions: msg.questions,
        },
      });
      notify("❓ Claude 需要你选择", get().sessions.find((s) => s.id === msg.sessionId)?.title);
      break;
    }
    case "server:claude_permission_cancel": {
      const p = get().pendingPermission;
      if (p && p.requestId === msg.requestId) set({ pendingPermission: null });
      break;
    }
    default:
      break;
  }
}

/** True if the given session is the one currently being streamed/driven. */
function isStreamSession(st: AppState, sessionId: string): boolean {
  return st.stream?.sessionId === sessionId || st.selectedId === sessionId;
}

/** End the active drive: stop streaming and refetch the authoritative tail. */
async function endTurn(
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
  sessionId: string,
): Promise<void> {
  set({ driveStatus: "idle", stream: null });
  const api = get().api;
  if (!api || get().selectedId !== sessionId) return;
  try {
    const res = await api.claudeSession(sessionId, { limit: HISTORY_PAGE });
    if (get().selectedId === sessionId) {
      cacheSet(sessionId, res.messages, res.offset);
      set({
        messages: res.messages,
        historyOffset: res.offset,
        sessions: upsertSession(get().sessions, res.session),
      });
    }
  } catch {
    /* keep optimistic messages if the refetch fails */
  }
}

/** Background re-fetch of the tail for a cached session that may have changed. */
async function revalidateTail(
  api: ApiClient,
  id: string,
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): Promise<void> {
  try {
    const res = await api.claudeSession(id, { limit: HISTORY_PAGE });
    if (get().selectedId !== id) return;
    cacheSet(id, res.messages, res.offset);
    set({
      messages: res.messages,
      historyOffset: res.offset,
      sessions: upsertSession(get().sessions, res.session),
    });
  } catch {
    /* keep the cached view if revalidation fails */
  }
}

let optimisticSeq = 0;
function optimisticUserMessage(
  prompt: string,
  sessionId: string | null,
  images?: ClaudeImage[],
): ClaudeMessage {
  const blocks: ClaudeMessageBlock[] = [];
  for (const img of images ?? []) {
    blocks.push({ kind: "image", mediaType: img.mediaType, dataBase64: img.dataBase64 });
  }
  if (prompt) blocks.push({ kind: "text", text: prompt });
  return {
    id: `optimistic-${optimisticSeq++}`,
    sessionId: sessionId ?? "pending",
    role: "user",
    blocks,
    timestamp: new Date().toISOString(),
  };
}

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const b = err.body as { error?: string; message?: string } | undefined;
    return b?.message ?? b?.error ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
