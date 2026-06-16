import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import {
  CreateSessionInputSchema,
  ClaudeAnswerPermissionBodySchema,
  ClaudeAnswerToolApprovalBodySchema,
  ClaudeContinueBodySchema,
  ClaudeCreateBodySchema,
  ClaudeSwitchProjectBodySchema,
  ERROR_CODES,
  HealthResponseSchema,
  ListLogsQuerySchema,
  ListWorkspacesResponseSchema,
  PROTOCOL_VERSION,
  PairRequestSchema,
  PasswordLoginSchema,
  PushSubscriptionSchema,
  SessionInputBodySchema,
  SwitchWorkspaceBodySchema,
} from "@mac/shared";
import type { PushManager } from "./push-manager.js";
import type { AuthManager } from "./auth-manager.js";
import type { SessionManager } from "./session-manager.js";
import type { HistoryStore } from "./history-store.js";
import type { WorkspaceReader } from "./workspace-reader.js";
import type { ClaudeStore } from "./claude-store.js";
import { ClaudeDriver, SessionLiveError } from "./claude-driver.js";
import { readUsageCache } from "./usage-cache.js";
import { transcribe, asrConfigured } from "./asr.js";

export interface BuildHttpOptions {
  auth: AuthManager;
  sessions: SessionManager;
  store: HistoryStore;
  workspaceReader: WorkspaceReader;
  claude: ClaudeStore;
  driver: ClaudeDriver;
  serverVersion: string;
  allowedOrigins: string[];
  whisperApiKey?: string | undefined;
  /** Skip bearer-token auth (local convenience). Default false = auth required. */
  noAuth?: boolean;
  switchWorkspace?: (input: { workspaceId?: string; rootPath?: string }) => boolean;
  push?: PushManager;
}

// VAPID public key is needed before login to create a subscription → free path.
const FREE_PATHS = new Set([
  "/health",
  "/auth/pair",
  "/auth/pair/issue",
  "/auth/login",
  "/usage",
  "/push/vapid-public-key",
]);

export async function buildHttpApp(opts: BuildHttpOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (opts.allowedOrigins.includes("*")) return cb(null, true);
      cb(null, opts.allowedOrigins.includes(origin));
    },
    credentials: true,
  });

  if (!opts.noAuth) {
    app.addHook("onRequest", async (req, reply) => {
      if (FREE_PATHS.has(req.url.split("?")[0]!)) return;
      const header = req.headers.authorization;
      const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
      const device = opts.auth.verifyToken(token);
      if (!device) {
        reply.code(401).send({ error: "unauthorized", code: ERROR_CODES.UNAUTHORIZED });
      }
    });
  }

  // Unauthenticated probe. Exposes whether a password is required so clients can
  // skip the login step when the agent runs open (no password configured).
  app.get("/health", async () => {
    return { ok: true, version: opts.serverVersion, auth: opts.noAuth ? "none" : "password" } as const;
  });

  app.post("/auth/login", async (req, reply) => {
    const parsed = PasswordLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "bad_request", code: ERROR_CODES.BAD_REQUEST };
    }
    // No-auth mode: accept any login, hand back an empty token (open access).
    if (opts.noAuth) {
      return { token: "", workspace: opts.workspaceReader.current() };
    }
    const result = opts.auth.loginWithPassword(parsed.data);
    if ("error" in result) {
      reply.code(result.error === "rate_limited" ? 429 : 401);
      return { error: result.error, code: ERROR_CODES.UNAUTHORIZED };
    }
    return { token: result.token, workspace: opts.workspaceReader.current() };
  });

  app.post("/auth/pair", async (req, reply) => {
    const parsed = PairRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "bad_request", code: ERROR_CODES.BAD_REQUEST };
    }
    const result = opts.auth.pair(parsed.data);
    if ("error" in result) {
      reply.code(result.error === "rate_limited" ? 429 : 401);
      return { error: result.error, code: ERROR_CODES.PAIRING_INVALID };
    }
    return {
      token: result.token,
      device: stripTokenHash(result.device),
      workspace: opts.workspaceReader.current(),
      serverVersion: opts.serverVersion,
    };
  });

  app.get("/workspaces", async () =>
    ListWorkspacesResponseSchema.parse({
      workspaces: opts.workspaceReader.list(),
      current: opts.workspaceReader.current(),
    }),
  );

  app.post("/workspaces/switch", async (req, reply) => {
    const parsed = SwitchWorkspaceBodySchema.safeParse(req.body);
    if (!parsed.success || (!parsed.data.workspaceId && !parsed.data.rootPath)) {
      reply.code(400);
      return { error: "bad_request", code: ERROR_CODES.BAD_REQUEST, issues: parsed.success ? [] : parsed.error.issues };
    }
    const ok = opts.switchWorkspace?.(parsed.data) ?? false;
    if (!ok) {
      reply.code(404);
      return { error: "workspace_not_found", code: ERROR_CODES.NOT_FOUND };
    }
    return {
      workspace: opts.workspaceReader.current(),
      workspaces: opts.workspaceReader.list(),
    };
  });

  app.post("/auth/pair/issue", async () => {
    const code = opts.auth.issuePairCode();
    return { pairCode: code };
  });

  app.get("/sessions", async () => ({ sessions: opts.sessions.list() }));

  app.post("/sessions", async (req, reply) => {
    const parsed = CreateSessionInputSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "bad_request", code: ERROR_CODES.BAD_REQUEST, issues: parsed.error.issues };
    }
    const session = opts.sessions.create(parsed.data);
    return { session };
  });

  app.get<{ Params: { id: string } }>("/sessions/:id", async (req, reply) => {
    const s = opts.sessions.get(req.params.id);
    if (!s) {
      reply.code(404);
      return { error: "not_found", code: ERROR_CODES.NOT_FOUND };
    }
    return { session: s };
  });

  app.delete<{ Params: { id: string } }>("/sessions/:id", async (req, reply) => {
    const ok = opts.sessions.delete(req.params.id);
    if (!ok) {
      reply.code(404);
      return { error: "not_found", code: ERROR_CODES.NOT_FOUND };
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/input", async (req, reply) => {
    const parsed = SessionInputBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "bad_request", code: ERROR_CODES.BAD_REQUEST };
    }
    const ok = opts.sessions.writeInput(
      req.params.id,
      parsed.data.data,
      parsed.data.appendNewline ?? true,
    );
    if (!ok) {
      reply.code(404);
      return { error: "not_found", code: ERROR_CODES.NOT_FOUND };
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/interrupt", async (req, reply) => {
    const ok = opts.sessions.interrupt(req.params.id);
    if (!ok) {
      reply.code(404);
      return { error: "not_found", code: ERROR_CODES.NOT_FOUND };
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/restart", async (req, reply) => {
    const s = opts.sessions.restart(req.params.id);
    if (!s) {
      reply.code(404);
      return { error: "not_found", code: ERROR_CODES.NOT_FOUND };
    }
    return { session: s };
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    "/sessions/:id/logs",
    async (req) => {
      const q = ListLogsQuerySchema.parse(req.query ?? {});
      const logs = opts.store.getLogs({ sessionId: req.params.id, ...q });
      return { logs };
    },
  );

  app.get<{ Params: { id: string } }>("/sessions/:id/files", async (req) => {
    const files = opts.store.listFileChanges(req.params.id);
    return { files };
  });

  // ─────────────────── Claude Code native sessions ───────────────────

  app.get("/claude/projects", async () => {
    return { projects: await opts.claude.listProjects() };
  });

  app.post("/claude/projects/switch", async (req, reply) => {
    const parsed = ClaudeSwitchProjectBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "bad_request", code: ERROR_CODES.BAD_REQUEST, issues: parsed.error.issues };
    }
    const project = await opts.claude.switchProject(parsed.data.dir);
    if (!project) {
      reply.code(404);
      return { error: "project_not_found", code: ERROR_CODES.NOT_FOUND };
    }
    return { project, sessions: await opts.claude.listSessions() };
  });

  app.get("/claude/sessions", async () => {
    return { sessions: await opts.claude.listSessions() };
  });

  // Cross-project overview (dashboard default): sessions from ALL projects, meta-only.
  app.get("/claude/sessions/all", async () => {
    return { sessions: await opts.claude.listAllSessions() };
  });

  app.post("/claude/sessions", async (req, reply) => {
    const parsed = ClaudeCreateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "bad_request", code: ERROR_CODES.BAD_REQUEST, issues: parsed.error.issues };
    }
    const { sessionId } = opts.driver.newSession(
      parsed.data.prompt,
      parsed.data.cwd,
      parsed.data.images,
      parsed.data.permissionMode,
    );
    return { sessionId };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>(
    "/claude/sessions/:id",
    async (req, reply) => {
      const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
      const before = req.query.before != null ? Number(req.query.before) : undefined;
      const detail = await opts.claude.getSession(req.params.id, {
        limit: Number.isFinite(limit) ? limit : undefined,
        before: Number.isFinite(before) ? before : undefined,
      });
      if (!detail) {
        reply.code(404);
        return { error: "not_found", code: ERROR_CODES.NOT_FOUND };
      }
      return detail;
    },
  );

  app.post<{ Params: { id: string } }>("/claude/sessions/:id/continue", async (req, reply) => {
    const parsed = ClaudeContinueBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "bad_request", code: ERROR_CODES.BAD_REQUEST, issues: parsed.error.issues };
    }
    try {
      await opts.driver.continueSession(
        req.params.id,
        parsed.data.prompt,
        parsed.data.force,
        parsed.data.images,
        parsed.data.permissionMode,
      );
      return { ok: true };
    } catch (err) {
      if (err instanceof SessionLiveError) {
        reply.code(409);
        return {
          error: "session_live",
          code: ERROR_CODES.SESSION_FAILED,
          message: "该会话在终端仍活跃，接管前请先停止终端进程",
        };
      }
      reply.code(500);
      return { error: "drive_failed", code: ERROR_CODES.INTERNAL };
    }
  });

  app.post<{ Params: { id: string } }>(
    "/claude/sessions/:id/answer-permission",
    async (req, reply) => {
      const parsed = ClaudeAnswerPermissionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "bad_request", code: ERROR_CODES.BAD_REQUEST, issues: parsed.error.issues };
      }
      // live (in-process) first; fall back to durable recovery (resume) if needed
      let ok = opts.driver.answerPermission(
        req.params.id,
        parsed.data.requestId,
        parsed.data.answers,
      );
      if (!ok) {
        ok = await opts.driver.recoverAnswerPermission(
          req.params.id,
          parsed.data.requestId,
          parsed.data.answers,
        );
      }
      if (!ok) {
        reply.code(409);
        return {
          error: "permission_not_pending",
          code: ERROR_CODES.SESSION_FAILED,
          message: "该问题已失效（可能已回答或会话已结束）",
        };
      }
      return { ok: true };
    },
  );

  // Answer a pending tool approval (non-AskUserQuestion): allow once / deny.
  app.post<{ Params: { id: string } }>(
    "/claude/sessions/:id/answer-tool-approval",
    async (req, reply) => {
      const parsed = ClaudeAnswerToolApprovalBodySchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "bad_request", code: ERROR_CODES.BAD_REQUEST, issues: parsed.error.issues };
      }
      // live (in-process) first; otherwise the process is gone (recovered row) →
      // drop the durable row so the badge/panel clears instead of lingering.
      let ok = opts.driver.approveTool(
        req.params.id,
        parsed.data.requestId,
        parsed.data.decision,
      );
      if (!ok) ok = opts.driver.dropApproval(req.params.id, parsed.data.requestId);
      if (!ok) {
        reply.code(409);
        return {
          error: "approval_not_pending",
          code: ERROR_CODES.SESSION_FAILED,
          message: "该审批已失效（可能已处理或会话已结束）",
        };
      }
      return { ok: true };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/claude/sessions/:id/pending-permission",
    async (req) => {
      return {
        pending: opts.driver.listPending(req.params.id),
        approvals: opts.driver.listPendingApprovals(req.params.id),
      };
    },
  );

  // Dismiss a session's lingering AskUserQuestion(s) without answering — clears the
  // "needs answer" attention badge (e.g. a question abandoned in a closed terminal).
  app.post<{ Params: { id: string } }>(
    "/claude/sessions/:id/dismiss-question",
    async (req) => {
      const id = req.params.id;
      const ids = await opts.claude.getOpenQuestionIds(id);
      if (ids.length > 0) {
        opts.store.dismissQuestions(id, ids, new Date().toISOString());
        opts.claude.addDismissedQuestions(ids);
        await opts.claude.refreshSession(id);
      }
      // also drop any durable pending row so a recovered picker won't re-surface
      opts.driver.clearPersistedPending(id);
      return { ok: true, dismissed: ids.length };
    },
  );

  // Close a live picker without answering: claude is told the user declined.
  app.post<{ Params: { id: string } }>(
    "/claude/sessions/:id/decline-permission",
    async (req, reply) => {
      const parsed = ClaudeAnswerPermissionBodySchema.pick({ requestId: true }).safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "bad_request", code: ERROR_CODES.BAD_REQUEST, issues: parsed.error.issues };
      }
      const ok = opts.driver.declinePermission(req.params.id, parsed.data.requestId);
      if (!ok) {
        reply.code(409);
        return {
          error: "permission_not_pending",
          code: ERROR_CODES.SESSION_FAILED,
          message: "该问题已失效（可能已回答或会话已结束）",
        };
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>("/claude/sessions/:id/prewarm", async (req) => {
    const warmed = await opts.driver.prewarm(req.params.id);
    return { warmed };
  });

  app.post<{ Params: { id: string } }>("/claude/sessions/:id/interrupt", async (req, reply) => {
    const ok = opts.driver.interrupt(req.params.id);
    if (!ok) {
      reply.code(404);
      return { error: "not_found", code: ERROR_CODES.NOT_FOUND };
    }
    return { ok: true };
  });

  // ─────────────────── Voice transcription (Tencent ASR) ───────────────────
  app.post("/asr", async (req, reply) => {
    const body = req.body as { audioBase64?: string; format?: string } | undefined;
    if (!body?.audioBase64 || typeof body.audioBase64 !== "string") {
      reply.code(400);
      return { error: "bad_request", code: ERROR_CODES.BAD_REQUEST };
    }
    if (!asrConfigured()) {
      reply.code(503);
      return { error: "asr_not_configured", message: "未配置 VOICE_SECRET_ID / VOICE_SECRET_KEY" };
    }
    try {
      const text = await transcribe(body.audioBase64, body.format || "pcm");
      return { text };
    } catch (e) {
      reply.code(502);
      return { error: "asr_failed", message: e instanceof Error ? e.message : "asr error" };
    }
  });

  app.get("/devices", async () => {
    return {
      devices: opts.auth.listDevices().map((d) => stripTokenHash(d)),
    };
  });

  app.delete<{ Params: { id: string } }>("/devices/:id", async (req) => {
    opts.auth.revokeDevice(req.params.id);
    return { ok: true };
  });

  app.get("/usage", async (req, reply) => {
    const cache = await readUsageCache();
    if (!cache) {
      reply.code(404);
      return { error: "usage_not_available", five_hour: null, seven_day: null };
    }
    return {
      five_hour: cache.five_hour || null,
      seven_day: cache.seven_day || null,
    };
  });

  app.get("/protocol", async () => ({ version: PROTOCOL_VERSION }));

  // ─────────────── Web Push ───────────────
  app.get("/push/vapid-public-key", async () => {
    if (!opts.push) return { enabled: false, publicKey: null };
    return { enabled: true, publicKey: opts.push.publicKey };
  });

  app.post("/push/subscribe", async (req, reply) => {
    if (!opts.push) {
      reply.code(503);
      return { error: "push_disabled", code: ERROR_CODES.INTERNAL };
    }
    const parsed = PushSubscriptionSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "bad_request", code: ERROR_CODES.BAD_REQUEST, issues: parsed.error.issues };
    }
    opts.push.subscribe(parsed.data);
    return { ok: true };
  });

  app.post("/push/unsubscribe", async (req, reply) => {
    if (!opts.push) {
      reply.code(503);
      return { error: "push_disabled", code: ERROR_CODES.INTERNAL };
    }
    const endpoint = (req.body as { endpoint?: string } | undefined)?.endpoint;
    if (!endpoint) {
      reply.code(400);
      return { error: "bad_request", code: ERROR_CODES.BAD_REQUEST };
    }
    opts.push.unsubscribe(endpoint);
    return { ok: true };
  });

  return app;
}

function stripTokenHash<T extends { tokenHash?: string }>(d: T): Omit<T, "tokenHash"> {
  const clone = { ...d } as T;
  delete clone.tokenHash;
  return clone;
}
