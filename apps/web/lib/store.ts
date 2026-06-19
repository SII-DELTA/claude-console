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
import { ApiClient, ApiError, isLiveConflict, isNotFound, isUnauthorizedError } from "./api";
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
/** byte cursor for the open conversation's incremental tail sync (WS-as-hint model) */
let tailCursor: { id: string; cursor: number } | null = null;
/** guard against overlapping incremental syncs for the open conversation */
let tailSyncing = false;
/** when the page was last hidden, to decide whether a returning socket is trustworthy */
let hiddenSince = 0;
/** coalesce visibilitychange/online/pageshow that fire together on resume */
let lastResumeAt = 0;
/** last time a fast `claude_driving` event set the driving flag, per session — used to
 * stop a slightly-stale `session_updated` snapshot from reverting it (badge flicker) */
const lastDrivingAt = new Map<string, number>();
/** in-flight guards so resume + intervals don't fire duplicate concurrent list scans */
let loadingSessions = false;
let loadingAllSessions = false;
/** requestIds cancelled recently — so a stale pending-permission snapshot (from a
 * reconnect-era refresh) can't revive an already-answered/cancelled question */
const recentlyCancelled = new Map<string, number>();
/** when we last raised a picker — so a slightly-stale session_updated snapshot can't
 * immediately clear a just-shown one via its (older) attention flag */
let pickerSetAt = 0;
function noteCancelled(requestId: string): void {
  const now = Date.now();
  recentlyCancelled.set(requestId, now);
  for (const [k, ts] of recentlyCancelled) if (now - ts > 10_000) recentlyCancelled.delete(k);
}
function wasRecentlyCancelled(requestId: string): boolean {
  const ts = recentlyCancelled.get(requestId);
  return ts != null && Date.now() - ts < 8000;
}

/** messages fetched on each "load earlier" step */
const HISTORY_PAGE = 40;
/**
 * A just-created session's JSONL isn't flushed until Claude (cold-spawned over a remote
 * link) writes its first line, so the first few polls of its detail/tail legitimately 404.
 * Within this window we treat such a 404 as "awaiting first write": retry quietly, don't
 * surface it or log it to the interface-error log. Past the window it's a real error again.
 */
const FRESH_WINDOW_MS = 15_000;
const FRESH_RETRY_MS = 700;
/** id → creation timestamp, for sessions newly started this session (see FRESH_WINDOW_MS). */
const freshSessions = new Map<string, number>();
function markFresh(id: string): void {
  freshSessions.set(id, Date.now());
}
/** ms since the session was created, or null if it isn't tracked as fresh. */
function freshAge(id: string): number | null {
  const t = freshSessions.get(id);
  return t == null ? null : Date.now() - t;
}
/** messages rendered on first opening a session (env default; overridable in Settings) */
const INITIAL_MESSAGES_DEFAULT = Number(process.env.NEXT_PUBLIC_INITIAL_MESSAGES) || 10;
const INITIAL_KEY = "mac.initialMessages";
const ENTER_KEY = "mac.enterBehavior";

/** How the Enter key behaves in the composer. auto = by device (touch→newline). */
export type EnterBehavior = "auto" | "send" | "newline";

function loadInitialMessages(): number {
  if (typeof window === "undefined") return INITIAL_MESSAGES_DEFAULT;
  try {
    const v = Number(window.localStorage.getItem(INITIAL_KEY));
    return Number.isFinite(v) && v > 0 ? v : INITIAL_MESSAGES_DEFAULT;
  } catch {
    return INITIAL_MESSAGES_DEFAULT;
  }
}

function loadEnterBehavior(): EnterBehavior {
  if (typeof window === "undefined") return "auto";
  try {
    const v = window.localStorage.getItem(ENTER_KEY);
    return v === "send" || v === "newline" ? v : "auto";
  } catch {
    return "auto";
  }
}
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

/** Desktop IDE detection (which projects have VSCode/plugin, per-session run state). */
export interface IdeState {
  projects: Array<{ cwd: string; hasVscode: boolean; hasPlugin: boolean }>;
  sessions: Array<{ sessionId: string; cwd: string; state: string; alive: boolean; terminal: boolean; inVscode: boolean }>;
}

/** Per-session desktop badge: this session runs in a desktop VSCode (or terminal). */
export function ideBadgeFor(ide: IdeState | null, sessionId: string): "vscode" | "terminal" | null {
  const s = ide?.sessions.find((x) => x.sessionId === sessionId);
  if (!s || !s.alive) return null;
  return s.terminal ? "terminal" : s.inVscode ? "vscode" : null;
}

/** "auto" = inject + press Enter (sends); "stage" = prefill only (you hit Enter at desktop). */
export type VscodeSendMode = "auto" | "stage";
const VSCODE_SEND_KEY = "mac.vscodeSendMode";
export function getVscodeSendMode(): VscodeSendMode {
  if (typeof window === "undefined") return "auto";
  try {
    return window.localStorage.getItem(VSCODE_SEND_KEY) === "stage" ? "stage" : "auto";
  } catch {
    return "auto";
  }
}
export function setVscodeSendMode(m: VscodeSendMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VSCODE_SEND_KEY, m);
  } catch {
    /* storage unavailable */
  }
}

/** Delivery/read receipt for the just-sent user message (方案 B). */
export type SendState = "sending" | "delivered" | "read" | "failed";

/** Active bottom-tab on mobile (desktop keeps the sidebar layout, ignores this). */
export type MobileTab = "dashboard" | "projects" | "sessions" | "settings";

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
  /** sessions across ALL projects, for the dashboard overview (meta-only) */
  allSessions: ClaudeSession[];
  /** desktop IDE state: which projects have VSCode/plugin + per-session run/terminal flags */
  ideState: IdeState | null;
  /** dashboard project focus: null = all projects overview; else filter to this dir */
  dashboardFocus: string | null;
  /** sessions-tab project focus: null = all projects; else filter to this dir */
  sessionsFocus: string | null;
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
  /** how many messages to render when first opening a session (Settings) */
  initialMessages: number;
  /** Enter-key behavior in the composer (Settings) */
  enterBehavior: EnterBehavior;
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
  /** A non-AskUserQuestion tool awaiting the user's allow/deny decision. */
  toolApproval: {
    sessionId: string;
    requestId: string;
    toolName: string;
    summary: string;
    /** false ⇒ recovered from store (process gone); only dismissable, not answerable. */
    live?: boolean;
  } | null;
  /** Delivery/read receipt for the last sent user message (方案 B). */
  sendStatus: { sessionId: string | null; messageId: string; state: SendState } | null;
  error: string | null;

  /** Incrementally sync the open conversation's tail (cheap; safe to call on a poll). */
  syncOpenSession: () => void;
  setConnection: (c: Connection | null) => void;
  setMobileTab: (t: MobileTab) => void;
  setPermissionMode: (m: ClaudePermissionMode) => void;
  setInitialMessages: (n: number) => void;
  setEnterBehavior: (b: EnterBehavior) => void;
  connectWs: () => void;
  /** Re-check the socket when the tab returns to the foreground (mobile resume). */
  handleVisible: () => void;
  loadProjects: () => Promise<void>;
  switchProject: (dir: string) => Promise<void>;
  /** set the dashboard's project focus (null = all-projects overview) */
  setDashboardFocus: (dir: string | null) => void;
  /** set the sessions-tab project focus (null = all projects) */
  setSessionsFocus: (dir: string | null) => void;
  /** project management: hide / unhide a project, or add (pin) one by cwd */
  hideProject: (dir: string) => Promise<void>;
  unhideProject: (dir: string) => Promise<void>;
  addProject: (cwd: string) => Promise<void>;
  /** restore project + session from the URL (?p=&s=) on first load */
  restoreFromUrl: () => Promise<void>;
  /** refresh desktop IDE detection (VSCode/plugin per project, run state per session) */
  loadIdeState: () => Promise<void>;
  /** inject (and optionally send per the configured mode) text into a session's desktop CC */
  sendToVscode: (sessionId: string, text: string) => Promise<{ ok: boolean; via: string; sent: boolean }>;
  /** open a project folder in desktop VSCode */
  openInVscode: (cwd: string) => Promise<void>;
  loadSessions: () => Promise<void>;
  /** refresh the cross-project overview session list */
  loadAllSessions: () => Promise<void>;
  selectSession: (id: string | null) => Promise<void>;
  /** load one older page of messages (prepended) for the selected session */
  loadEarlier: () => Promise<void>;
  /** Send a prompt: resumes selected session, or starts a new one if none selected.
   *  Resolves true on success, false on failure (so the composer can keep the draft). */
  sendPrompt: (prompt: string, opts?: { force?: boolean; images?: ClaudeImage[] }) => Promise<boolean>;
  interrupt: () => Promise<void>;
  /** Answer the pending interactive permission (方案 B). */
  answerPermission: (answers: Record<string, string | string[]>) => Promise<void>;
  /** Answer the pending tool approval (allow once / deny). */
  answerToolApproval: (decision: "allow" | "deny") => Promise<void>;
  /** Pull any pending interactive permission for a session (recover after reload/restart). */
  refreshPendingPermission: (sessionId: string) => Promise<void>;
  /** Dismiss a session's lingering question(s) without answering (clears the badge). */
  dismissQuestion: (sessionId: string) => Promise<void>;
  /** Close the current picker without answering (decline if live, else dismiss). */
  closePermission: () => Promise<void>;
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
  allSessions: [],
  ideState: null,
  dashboardFocus: null,
  sessionsFocus: null,
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
  initialMessages: loadInitialMessages(),
  enterBehavior: loadEnterBehavior(),
  rateLimit: null,
  pendingPermission: null,
  toolApproval: null,
  sendStatus: null,
  error: null,

  setPermissionMode(m) {
    if (typeof window !== "undefined") window.localStorage.setItem(PERM_KEY, m);
    set({ permissionMode: m });
  },

  setMobileTab(t) {
    set({ mobileTab: t });
  },

  setInitialMessages(n) {
    if (typeof window !== "undefined") window.localStorage.setItem(INITIAL_KEY, String(n));
    set({ initialMessages: n });
  },

  setEnterBehavior(b) {
    if (typeof window !== "undefined") window.localStorage.setItem(ENTER_KEY, b);
    set({ enterBehavior: b });
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
      allSessions: [],
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
      void get().loadAllSessions();
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
    if (reconnectTimer) {
      clearTimeout(reconnectTimer); // a pending reconnect is now moot — we're connecting
      reconnectTimer = null;
    }
    get().ws?.close();
    const ws: WsClient = new WsClient({
      url: conn.wsUrl,
      token: conn.token,
      onOpen: () => {
        set({ wsConnected: true });
        // Resync the dashboard: session_updated events broadcast while we were
        // offline were missed, and an initial load that failed during an agent
        // restart would have left the lists empty. Re-pull so cards reappear.
        void get().loadProjects();
        void get().loadSessions();
        void get().loadAllSessions();
        // a picker may have been raised while we were disconnected — recover it
        const sel = get().selectedId;
        if (sel) {
          void get().refreshPendingPermission(sel);
          // resync the open conversation: events broadcast while we were offline
          // (claude:message / delta / drive_done) were missed, so pull the tail.
          const api = get().api;
          if (api) void revalidateTail(api, sel, set, get);
        }
      },
      onClose: () => {
        // Ignore the close that fires when *we* replaced this socket (connectWs already
        // opened a fresh one) — otherwise every connect schedules a spurious reconnect
        // that 3s later kills the healthy socket. Only the current socket dying counts.
        if (get().ws !== ws) return;
        set({ wsConnected: false });
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          if (get().connection && !get().ws?.isOpen()) get().connectWs();
        }, 3000);
      },
      onMessage: (msg) => handleServerMessage(msg, set, get),
    });
    ws.open();
    set({ ws });
  },

  handleVisible() {
    if (typeof document !== "undefined" && document.hidden) {
      hiddenSince = Date.now(); // remember when we went background, to judge staleness on return
      return;
    }
    const { connection, ws, selectedId, api } = get();
    if (!connection) return;
    // online/pageshow/visibilitychange often fire within the same tick on resume —
    // collapse them so we don't reconnect + triple-fetch.
    const nowTs = Date.now();
    if (nowTs - lastResumeAt < 800) return;
    lastResumeAt = nowTs;
    const hiddenMs = hiddenSince ? nowTs - hiddenSince : 0;
    hiddenSince = 0;
    // Mobile freezes JS timers while backgrounded, so the 3s reconnect may never have
    // fired and `close` may not have surfaced. A socket that survived a long background is
    // likely a zombie — the server may have already terminated us on its 30s heartbeat.
    // Don't trust readyState past a short grace window: force a fresh reconnect.
    const STALE_AFTER_MS = 15_000;
    if (!ws || !ws.isOpen() || hiddenMs > STALE_AFTER_MS) {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      get().connectWs(); // onOpen refetches the lists + tail
    } else {
      // socket trusted alive — refresh the dashboard lists + incrementally sync the tail
      void get().loadSessions();
      void get().loadAllSessions();
      if (selectedId && api) void syncTail(api, selectedId, set, get);
    }
  },

  syncOpenSession() {
    const { selectedId, api } = get();
    // HTTP-authoritative: works even if the WS is down/zombie, so the open conversation
    // stays current without depending on push delivery.
    if (selectedId && api) void syncTail(api, selectedId, set, get);
  },

  async loadIdeState() {
    const api = get().api;
    if (!api) return;
    try {
      set({ ideState: await api.ideState() });
    } catch {
      /* IDE detection is best-effort (agent may be remote / non-mac) */
    }
  },

  async sendToVscode(sessionId, text) {
    const api = get().api;
    if (!api) return { ok: false, via: "none", sent: false };
    const send = getVscodeSendMode() === "auto";
    try {
      const r = await api.ideInject(sessionId, text, send);
      return { ok: r.ok, via: r.via, sent: r.sent };
    } catch (err) {
      set({ error: describeError(err) });
      return { ok: false, via: "none", sent: false };
    }
  },

  async openInVscode(cwd) {
    const api = get().api;
    if (!api) return;
    try {
      await api.ideOpen(cwd);
      setTimeout(() => void get().loadIdeState(), 1500); // refresh badges after VSCode opens
    } catch (err) {
      set({ error: describeError(err) });
    }
  },

  async loadSessions() {
    const api = get().api;
    if (!api || loadingSessions) return; // dedupe concurrent scans (resume + intervals)
    loadingSessions = true;
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
    } finally {
      loadingSessions = false;
    }
  },

  async loadAllSessions() {
    const api = get().api;
    if (!api || loadingAllSessions) return; // dedupe concurrent scans
    loadingAllSessions = true;
    try {
      const res = await api.claudeAllSessions();
      set({ allSessions: res.sessions });
    } catch (err) {
      if (isUnauthorizedError(err)) {
        get().setConnection(null);
        return;
      }
      // overview is best-effort; don't surface a blocking error
    } finally {
      loadingAllSessions = false;
    }
  },

  setDashboardFocus(dir) {
    set({ dashboardFocus: dir });
  },

  setSessionsFocus(dir) {
    set({ sessionsFocus: dir });
  },

  async hideProject(dir) {
    const api = get().api;
    if (!api) return;
    try {
      const res = await api.hideClaudeProject(dir);
      set({ projects: res.projects });
      void get().loadAllSessions(); // hidden project drops out of the overview
    } catch (err) {
      set({ error: describeError(err) });
    }
  },

  async unhideProject(dir) {
    const api = get().api;
    if (!api) return;
    try {
      const res = await api.unhideClaudeProject(dir);
      set({ projects: res.projects });
      void get().loadAllSessions();
    } catch (err) {
      set({ error: describeError(err) });
    }
  },

  async addProject(cwd) {
    const api = get().api;
    if (!api) return;
    try {
      const res = await api.addClaudeProject(cwd);
      set({ projects: res.projects });
    } catch (err) {
      set({ error: describeError(err) });
    }
  },

  async selectSession(id) {
    if (prewarmTimer) clearTimeout(prewarmTimer);
    const switching = id !== get().selectedId;
    if (switching) {
      // The streaming UI / pickers / cursor all belong to the session we're leaving. Reset
      // them — crucially driveStatus, else it stays "streaming" (the left turn's drive_done
      // no longer matches isStreamSession) and the new session's composer is hidden forever.
      tailCursor = null;
      set({
        selectedId: id,
        stream: null,
        driveStatus: "idle",
        pendingPermission: null,
        toolApproval: null,
        sendStatus: null,
      });
    } else {
      set({ selectedId: id }); // re-selecting the same session — don't disturb an active stream
    }
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
      const res = await api.claudeSession(id, { limit: get().initialMessages });
      // guard against a race where the user switched away mid-fetch
      if (get().selectedId === id) {
        cacheSet(id, res.messages, res.offset);
        tailCursor = { id, cursor: res.cursor ?? 0 };
        set({
          messages: res.messages,
          historyOffset: res.offset,
          sessions: upsertSession(get().sessions, res.session),
        });
        // pre-warm after a short dwell (skip if just browsing through sessions),
        // only for idle sessions not already driven elsewhere
        if (!res.session.isLive && !res.session.drivenByAgent) {
          prewarmTimer = setTimeout(() => {
            if (get().selectedId === id) void api.prewarmClaudeSession(id, get().permissionMode).catch(() => {});
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
          sendStatus: { sessionId: selected, messageId: userMsg.id, state: "sending" },
        });
        await api.continueClaudeSession(selected, prompt, opts?.force, images, get().permissionMode);
        markDelivered(set, get, userMsg.id, selected);
      } else {
        // New session: id is unknown until POST returns. Start streaming with a
        // null sessionId; the delta handler adopts the id from the first event.
        set({
          messages: [userMsg],
          driveStatus: "streaming",
          stream: { sessionId: null, text: "", thinking: "", tools: [] },
          sendStatus: { sessionId: null, messageId: userMsg.id, state: "sending" },
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
        markDelivered(set, get, userMsg.id, sessionId);
        // The JSONL isn't flushed yet → the immediate tail poll below (and any WS-hint
        // polls) would 404 for a few seconds; mark it fresh so those 404s retry silently.
        markFresh(sessionId);
        // `claude_message` events broadcast before this id was known were dropped
        // (selectedId was null). Pull the tail now that we know the id, to backfill them.
        void revalidateTail(api, sessionId, set, get);
      }
      return true;
    } catch (err) {
      if (isLiveConflict(err)) {
        // drop the optimistic bubble; the takeover dialog re-sends on confirm
        set({
          driveStatus: "idle",
          stream: null,
          sendStatus: null,
          messages: get().messages.filter((m) => m.id !== userMsg.id),
        });
        const e = err as ApiError;
        const msg =
          (e.body as { message?: string } | undefined)?.message ??
          "该会话在终端仍活跃，确认要接管吗？";
        set({ error: `LIVE:${msg}` });
      } else {
        // keep the bubble and mark it failed (never silently swallow the message)
        set({
          driveStatus: "idle",
          stream: null,
          sendStatus: { sessionId: selected ?? null, messageId: userMsg.id, state: "failed" },
          error: describeError(err),
        });
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
      // surface the next pending ask (question or approval) if the turn has more
      void get().refreshPendingPermission(p.sessionId);
    } catch (err) {
      // restore so the user can retry if the request was still pending
      if (isLiveConflict(err)) {
        // 409 = no longer pending (already answered / turn ended); stay dismissed
      } else {
        set({ pendingPermission: p, error: "提交选择失败，请重试" });
      }
    }
  },

  async answerToolApproval(decision) {
    const api = get().api;
    const p = get().toolApproval;
    if (!api || !p) return;
    // optimistic close; server emits a cancel + session_updated to reconcile all
    // clients. For a recovered (process-gone) approval the server drops the stale
    // durable row, so the "approval" badge clears everywhere — don't short-circuit.
    set({ toolApproval: null });
    try {
      await api.answerClaudeToolApproval(p.sessionId, p.requestId, decision);
      // a turn may have several tool calls awaiting approval at once; the earlier
      // ones were overwritten in the single-slot UI. Pull the next one (if any) so
      // the panel doesn't go blank while the turn is still blocked.
      void get().refreshPendingPermission(p.sessionId);
    } catch (err) {
      if (isLiveConflict(err)) {
        // 409 = no longer pending (already handled / turn ended); stay dismissed
      } else {
        set({ toolApproval: p, error: "提交失败，请重试" });
      }
    }
  },

  async closePermission() {
    const api = get().api;
    const p = get().pendingPermission;
    if (!api || !p) return;
    // recovered (process gone) → can't decline live; dismiss it instead
    if (p.live === false) {
      await get().dismissQuestion(p.sessionId);
      return;
    }
    set({ pendingPermission: null }); // optimistic close
    try {
      await api.declineClaudePermission(p.sessionId, p.requestId);
    } catch (err) {
      if (isLiveConflict(err)) {
        // 409 = already resolved/closed; stay dismissed
      } else {
        set({ pendingPermission: p, error: "关闭失败，请重试" });
      }
    }
  },

  async dismissQuestion(sessionId) {
    const api = get().api;
    if (!api || !sessionId) return;
    // optimistic: drop the local picker and clear the question badge
    set((s) => ({
      pendingPermission:
        s.pendingPermission?.sessionId === sessionId ? null : s.pendingPermission,
      sessions: s.sessions.map((x) =>
        x.id === sessionId && x.attention === "question" ? { ...x, attention: undefined } : x,
      ),
    }));
    try {
      await api.dismissClaudeQuestion(sessionId);
    } catch {
      /* best-effort; the server's session_updated broadcast reconciles state */
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
      if (first && !wasRecentlyCancelled(first.requestId)) {
        pickerSetAt = Date.now();
        set({
          pendingPermission: {
            sessionId,
            requestId: first.requestId,
            toolName: first.toolName,
            questions: first.questions,
            live: first.live,
          },
        });
      } else if (!first && get().pendingPermission?.sessionId === sessionId) {
        // server says nothing pending → clear any stale local picker
        set({ pendingPermission: null });
      }
      const firstApproval = res.approvals?.[0];
      if (firstApproval) {
        set({
          toolApproval: {
            sessionId,
            requestId: firstApproval.requestId,
            toolName: firstApproval.toolName,
            summary: firstApproval.summary,
            live: firstApproval.live,
          },
        });
      } else if (get().toolApproval?.sessionId === sessionId) {
        set({ toolApproval: null });
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
      let incoming = msg.session;
      // This full-object snapshot may have been computed just before a fresh
      // `claude_driving` transition; don't let it revert the driving flag (badge flicker).
      const droveAt = lastDrivingAt.get(incoming.id);
      if (droveAt != null && Date.now() - droveAt < 2000) {
        const cur =
          get().sessions.find((s) => s.id === incoming.id) ??
          get().allSessions.find((s) => s.id === incoming.id);
        if (cur) incoming = { ...incoming, driving: cur.driving };
      }
      set({
        sessions: upsertSession(get().sessions, incoming),
        allSessions: upsertSession(get().allSessions, incoming),
      });
      // Authoritative reconciliation: the session JSONL drives the "question"
      // attention flag (cleared once a non-error answer lands). If it's no longer
      // a question, drop any lingering picker we may hold — covers a missed
      // permission_cancel (brief disconnect) or an answer made on another client.
      // ...but don't let a snapshot that predates a just-raised picker clear it (flicker).
      const fresh = Date.now() - pickerSetAt < 1500;
      const p = get().pendingPermission;
      if (!fresh && p && p.sessionId === msg.session.id && msg.session.attention !== "question") {
        set({ pendingPermission: null });
      }
      // same reconciliation for tool approvals (attention drops to non-"approval")
      const a = get().toolApproval;
      if (!fresh && a && a.sessionId === msg.session.id && msg.session.attention !== "approval") {
        set({ toolApproval: null });
      }
      // WS-as-hint: a change on the open conversation → pull its new tail (incremental,
      // dedupes vs any delta/message already applied). Catches anything WS push dropped.
      if (msg.session.id === get().selectedId) {
        const api = get().api;
        if (api) void syncTail(api, msg.session.id, set, get);
      }
      break;
    }
    case "server:claude_driving": {
      // authoritative real-time run state (hook ∪ our driver). Patch the field so the
      // dashboard "正在运行" and the chat loading indicator update without a poll.
      lastDrivingAt.set(msg.sessionId, Date.now()); // mark fresh so a stale snapshot won't revert it
      const patchDriving = (list: ClaudeSession[]) =>
        list.map((s) => (s.id === msg.sessionId ? { ...s, driving: msg.driving } : s));
      set({ sessions: patchDriving(get().sessions), allSessions: patchDriving(get().allSessions) });
      if (msg.driving) markRead(set, get, msg.sessionId); // agent started → "已读·处理中"
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
      markRead(set, get, msg.sessionId); // first token of the reply → "已读·处理中"
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
      // notify regardless of which session is open — a question on a background
      // session still needs the user (the bell badge alone is easy to miss).
      notify("❓ Claude 需要你选择", get().sessions.find((s) => s.id === msg.sessionId)?.title);
      if (msg.sessionId === get().selectedId) {
        pickerSetAt = Date.now(); // protect this fresh picker from a stale session_updated clear
        set({
          pendingPermission: {
            sessionId: msg.sessionId,
            requestId: msg.requestId,
            toolName: msg.toolName,
            questions: msg.questions,
            live: true,
          },
        });
      }
      break;
    }
    case "server:claude_tool_approval_request": {
      notify("🔐 Claude 请求执行工具", get().sessions.find((s) => s.id === msg.sessionId)?.title);
      if (msg.sessionId === get().selectedId) {
        pickerSetAt = Date.now();
        set({
          toolApproval: {
            sessionId: msg.sessionId,
            requestId: msg.requestId,
            toolName: msg.toolName,
            summary: msg.summary,
            live: true,
          },
        });
      }
      break;
    }
    case "server:claude_permission_cancel": {
      noteCancelled(msg.requestId); // so a late refresh can't revive this exact request
      const p = get().pendingPermission;
      if (p && p.requestId === msg.requestId) set({ pendingPermission: null });
      const a = get().toolApproval;
      if (a && a.requestId === msg.requestId) set({ toolApproval: null });
      break;
    }
    default:
      break;
  }
}

/** True if the given session is the one currently being streamed/driven. */
function isStreamSession(st: AppState, sessionId: string): boolean {
  if (st.stream?.sessionId === sessionId) return true;
  // A freshly-created session hasn't adopted its id into the stream yet — match by
  // selectedId only while a stream exists and is still id-less (never for arbitrary
  // selected sessions, or a turn on another session would be misattributed).
  return st.stream != null && st.stream.sessionId == null && st.selectedId === sessionId;
}

type StoreSet = (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void;

/** sending → delivered (HTTP accepted), binding the real sessionId for new sessions. */
function markDelivered(set: StoreSet, get: () => AppState, messageId: string, sessionId: string): void {
  const ss = get().sendStatus;
  if (ss?.messageId === messageId && ss.state === "sending") {
    set({ sendStatus: { sessionId, messageId, state: "delivered" } });
  }
}

/** delivered/sending → read (the agent began this turn: first delta or driving=true). */
function markRead(set: StoreSet, get: () => AppState, sessionId: string): void {
  const ss = get().sendStatus;
  if (!ss || ss.state === "read" || ss.state === "failed") return;
  if (ss.sessionId !== null && ss.sessionId !== sessionId) return;
  set({ sendStatus: { ...ss, sessionId, state: "read" } });
}

/** End the active drive: stop streaming and refetch the authoritative tail. */
async function endTurn(
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
  sessionId: string,
): Promise<void> {
  // turn finished → the receipt's job is done; clear it (the reply is now visible)
  set({ driveStatus: "idle", stream: null, sendStatus: null });
  const api = get().api;
  if (!api || get().selectedId !== sessionId) return;
  try {
    // fetch at least as many as are currently loaded, so a turn-end doesn't snap the view
    // back to the last page when the user had scrolled earlier history into view.
    const limit = Math.max(HISTORY_PAGE, get().messages.length);
    const res = await api.claudeSession(sessionId, { limit });
    if (get().selectedId === sessionId) {
      cacheSet(sessionId, res.messages, res.offset);
      tailCursor = { id: sessionId, cursor: res.cursor ?? 0 };
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
  const age = freshAge(id);
  const fresh = age != null && age < FRESH_WINDOW_MS;
  try {
    const limit = Math.max(HISTORY_PAGE, get().messages.length); // preserve loaded history
    const res = await api.claudeSession(id, { limit }, { silent404: fresh });
    freshSessions.delete(id); // it exists now — no longer awaiting first write
    if (get().selectedId !== id) return;
    cacheSet(id, res.messages, res.offset);
    tailCursor = { id, cursor: res.cursor ?? 0 };
    set({
      messages: res.messages,
      historyOffset: res.offset,
      sessions: upsertSession(get().sessions, res.session),
    });
    // If we reconnected/returned to a turn that finished while we were away, the local
    // "streaming" state is stuck (drive_done was missed) → the composer stays hidden and
    // a stale partial bubble lingers. The authoritative session isn't driving → finalize.
    if (!res.session.driving && get().driveStatus === "streaming" && isStreamSession(get(), id)) {
      set({ driveStatus: "idle", stream: null, sendStatus: null });
    }
  } catch (err) {
    // A just-created session's JSONL isn't flushed yet → 404. Retry quietly within the
    // fresh window instead of surfacing or logging the error (the 404 was already kept
    // out of the interface-error log via silent404).
    if (fresh && isNotFound(err) && get().selectedId === id) {
      setTimeout(() => {
        if (get().selectedId === id) void revalidateTail(api, id, set, get);
      }, FRESH_RETRY_MS);
      return;
    }
    if (!fresh) freshSessions.delete(id); // window elapsed without success → stop tracking
    /* keep the cached view if revalidation fails */
  }
}

/**
 * Incremental tail sync for the open conversation (WS-as-hint model): pulls only the
 * bytes appended since our cursor, so it's cheap enough to run on every poll / hint and
 * doesn't depend on the WS staying alive. Falls back to a full revalidate when we have
 * no cursor yet. Upserts (dedupes vs WS-delivered messages) and keeps any loaded-earlier
 * history intact. Also refreshes the authoritative session (driving/isLive) so the
 * loading indicator self-heals, and finalizes a stuck local "streaming" turn.
 */
async function syncTail(
  api: ApiClient,
  id: string,
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): Promise<void> {
  if (tailSyncing) return;
  if (!tailCursor || tailCursor.id !== id) {
    void revalidateTail(api, id, set, get); // establishes the cursor
    return;
  }
  tailSyncing = true;
  try {
    const res = await api.claudeSessionTail(id, tailCursor.cursor);
    if (get().selectedId !== id) return;
    // never let a late incremental response rewind the cursor below where a concurrent
    // endTurn/revalidate already advanced it (would re-pull already-merged lines).
    const prev = tailCursor && tailCursor.id === id ? tailCursor.cursor : 0;
    tailCursor = { id, cursor: Math.max(res.cursor, prev) };
    // While this session is streaming, the live bubble + optimistic user message are on
    // screen; merging the JSONL's real user message (different id) would show a DUPLICATE
    // bubble until endTurn refetches. Skip the merge — endTurn reconciles authoritatively.
    const streamingThis = get().driveStatus === "streaming" && isStreamSession(get(), id);
    if (res.messages.length && !streamingThis) {
      let next = get().messages;
      for (const m of res.messages) next = upsertMessage(next, m);
      cacheSet(id, next, get().historyOffset);
      set({ messages: next });
    }
    set({ sessions: upsertSession(get().sessions, res.session) });
    // authoritative driving says the turn ended but our local stream is still "streaming"
    // (we missed drive_done) → finalize so the composer unlocks and the badge clears.
    if (!res.session.driving && get().driveStatus === "streaming" && isStreamSession(get(), id)) {
      void endTurn(set, get, id);
    }
  } catch {
    /* keep the current view if the incremental sync fails */
  } finally {
    tailSyncing = false;
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
