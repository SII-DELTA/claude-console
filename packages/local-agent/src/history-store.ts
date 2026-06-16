import Database, { type Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentLog, AgentLogLevel, AgentSession, FileChange, PairedDevice } from "@mac/shared";

interface RawSessionRow {
  id: string;
  workspaceId: string;
  title: string;
  type: string;
  command: string;
  cwd: string;
  env: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastMessage: string | null;
  exitCode: number | null;
}

interface RawLogRow {
  id: string;
  sessionId: string;
  timestamp: string;
  level: string;
  content: string;
  raw: string | null;
}

interface RawFileRow {
  id: string;
  sessionId: string;
  path: string;
  kind: string;
  addedLines: number;
  removedLines: number;
  timestamp: string;
  diff: string | null;
}

interface RawDeviceRow {
  id: string;
  name: string;
  platform: string;
  pairedAt: string;
  lastSeenAt: string;
  revoked: number;
  tokenHash: string;
}

export interface DeviceRecord extends PairedDevice {
  tokenHash: string;
}

/** A durable record of a pending permission: an AskUserQuestion or a tool approval. */
export interface PendingPermissionRecord {
  requestId: string;
  sessionId: string;
  toolName: string;
  /** "question" → AskUserQuestion picker; "approval" → allow/deny gate. */
  kind?: "question" | "approval";
  /** JSON-serializable questions payload (ClaudePermissionQuestion[]); [] for approvals. */
  questions: unknown;
  /** Raw tool input for an approval (JSON), used to re-summarize on recovery. */
  toolInput?: unknown;
  createdAt: string;
}

interface RawPendingRow {
  requestId: string;
  sessionId: string;
  toolName: string;
  kind: string | null;
  questions: string;
  toolInput: string | null;
  createdAt: string;
}

export class HistoryStore {
  private db: DB;

  constructor(filePath: string) {
    if (filePath !== ":memory:") {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspaceId TEXT NOT NULL,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        env TEXT,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        lastMessage TEXT,
        exitCode INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_workspaceId ON sessions(workspaceId);

      CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        content TEXT NOT NULL,
        raw TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_logs_session_ts ON logs(sessionId, timestamp);

      CREATE TABLE IF NOT EXISTS file_changes (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        addedLines INTEGER NOT NULL,
        removedLines INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        diff TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_files_session_ts ON file_changes(sessionId, timestamp);

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        pairedAt TEXT NOT NULL,
        lastSeenAt TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        tokenHash TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_token ON devices(tokenHash);

      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_permissions (
        requestId TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        toolName TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'question',
        questions TEXT NOT NULL,
        toolInput TEXT,
        createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_session ON pending_permissions(sessionId);

      CREATE TABLE IF NOT EXISTS dismissed_questions (
        questionId TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        dismissedAt TEXT NOT NULL
      );
    `);
    // Tool-approval columns on a pre-existing pending_permissions table (guarded).
    this.addColumnIfMissing("pending_permissions", "kind", "TEXT NOT NULL DEFAULT 'question'");
    this.addColumnIfMissing("pending_permissions", "toolInput", "TEXT");
  }

  /** Add a column only if it doesn't already exist (sqlite has no IF NOT EXISTS for columns). */
  private addColumnIfMissing(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  /* ---------------- sessions ---------------- */

  saveSession(s: AgentSession): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id,workspaceId,title,type,command,cwd,env,status,createdAt,updatedAt,lastMessage,exitCode)
         VALUES (@id,@workspaceId,@title,@type,@command,@cwd,@env,@status,@createdAt,@updatedAt,@lastMessage,@exitCode)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, type=excluded.type, command=excluded.command, cwd=excluded.cwd,
           env=excluded.env, status=excluded.status, updatedAt=excluded.updatedAt,
           lastMessage=excluded.lastMessage, exitCode=excluded.exitCode`,
      )
      .run({
        ...s,
        env: s.env ? JSON.stringify(s.env) : null,
        lastMessage: s.lastMessage ?? null,
        exitCode: s.exitCode ?? null,
      });
  }

  getSession(id: string): AgentSession | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id=?`).get(id) as
      | RawSessionRow
      | undefined;
    return row ? this.rowToSession(row) : null;
  }

  listSessions(): AgentSession[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ORDER BY updatedAt DESC`)
      .all() as RawSessionRow[];
    return rows.map((r) => this.rowToSession(r));
  }

  deleteSession(id: string): void {
    const tx = this.db.transaction((sid: string) => {
      this.db.prepare(`DELETE FROM logs WHERE sessionId=?`).run(sid);
      this.db.prepare(`DELETE FROM file_changes WHERE sessionId=?`).run(sid);
      this.db.prepare(`DELETE FROM sessions WHERE id=?`).run(sid);
    });
    tx(id);
  }

  private rowToSession(r: RawSessionRow): AgentSession {
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      title: r.title,
      type: r.type as AgentSession["type"],
      command: r.command,
      cwd: r.cwd,
      env: r.env ? (JSON.parse(r.env) as Record<string, string>) : undefined,
      status: r.status as AgentSession["status"],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastMessage: r.lastMessage ?? undefined,
      exitCode: r.exitCode,
    };
  }

  /* ---------------- logs ---------------- */

  appendLog(log: AgentLog): void {
    this.db
      .prepare(
        `INSERT INTO logs (id,sessionId,timestamp,level,content,raw)
         VALUES (@id,@sessionId,@timestamp,@level,@content,@raw)`,
      )
      .run({ ...log, raw: log.raw ?? null });
  }

  getLogs(opts: {
    sessionId: string;
    since?: string;
    limit?: number;
    level?: AgentLogLevel;
  }): AgentLog[] {
    const limit = Math.min(opts.limit ?? 500, 2_000);
    const params: Record<string, unknown> = { sessionId: opts.sessionId, limit };
    let sql = `SELECT * FROM logs WHERE sessionId=@sessionId`;
    if (opts.since) {
      sql += ` AND timestamp > @since`;
      params.since = opts.since;
    }
    if (opts.level) {
      sql += ` AND level = @level`;
      params.level = opts.level;
    }
    sql += ` ORDER BY timestamp ASC LIMIT @limit`;
    const rows = this.db.prepare(sql).all(params) as RawLogRow[];
    return rows.map(
      (r): AgentLog => ({
        id: r.id,
        sessionId: r.sessionId,
        timestamp: r.timestamp,
        level: r.level as AgentLogLevel,
        content: r.content,
        raw: r.raw ?? undefined,
      }),
    );
  }

  trimLogs(sessionId: string, keep: number): void {
    this.db
      .prepare(
        `DELETE FROM logs WHERE sessionId=? AND id NOT IN (
           SELECT id FROM logs WHERE sessionId=? ORDER BY timestamp DESC LIMIT ?
         )`,
      )
      .run(sessionId, sessionId, keep);
  }

  /* ---------------- file changes ---------------- */

  appendFileChange(c: FileChange): void {
    this.db
      .prepare(
        `INSERT INTO file_changes (id,sessionId,path,kind,addedLines,removedLines,timestamp,diff)
         VALUES (@id,@sessionId,@path,@kind,@addedLines,@removedLines,@timestamp,@diff)`,
      )
      .run({ ...c, diff: c.diff ?? null });
  }

  listFileChanges(sessionId: string): FileChange[] {
    const rows = this.db
      .prepare(`SELECT * FROM file_changes WHERE sessionId=? ORDER BY timestamp DESC`)
      .all(sessionId) as RawFileRow[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      path: r.path,
      kind: r.kind as FileChange["kind"],
      addedLines: r.addedLines,
      removedLines: r.removedLines,
      timestamp: r.timestamp,
      diff: r.diff ?? undefined,
    }));
  }

  /* ---------------- devices ---------------- */

  saveDevice(rec: DeviceRecord): void {
    this.db
      .prepare(
        `INSERT INTO devices (id,name,platform,pairedAt,lastSeenAt,revoked,tokenHash)
         VALUES (@id,@name,@platform,@pairedAt,@lastSeenAt,@revoked,@tokenHash)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, platform=excluded.platform, lastSeenAt=excluded.lastSeenAt,
           revoked=excluded.revoked, tokenHash=excluded.tokenHash`,
      )
      .run({
        ...rec,
        revoked: rec.revoked ? 1 : 0,
      });
  }

  findDeviceByTokenHash(hash: string): DeviceRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM devices WHERE tokenHash=? AND revoked=0`)
      .get(hash) as RawDeviceRow | undefined;
    return row ? this.rowToDevice(row) : null;
  }

  listDevices(): DeviceRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM devices ORDER BY pairedAt DESC`)
      .all() as RawDeviceRow[];
    return rows.map((r) => this.rowToDevice(r));
  }

  revokeDevice(id: string): void {
    this.db.prepare(`UPDATE devices SET revoked=1 WHERE id=?`).run(id);
  }

  revokeAllDevices(): void {
    this.db.prepare(`UPDATE devices SET revoked=1`).run();
  }

  touchDevice(id: string, lastSeenAt: string): void {
    this.db.prepare(`UPDATE devices SET lastSeenAt=? WHERE id=?`).run(lastSeenAt, id);
  }

  private rowToDevice(r: RawDeviceRow): DeviceRecord {
    return {
      id: r.id,
      name: r.name,
      platform: r.platform as PairedDevice["platform"],
      pairedAt: r.pairedAt,
      lastSeenAt: r.lastSeenAt,
      revoked: r.revoked === 1,
      tokenHash: r.tokenHash,
    };
  }

  /* ---------------- pending permissions (AskUserQuestion 接管) ---------------- */

  savePendingPermission(rec: PendingPermissionRecord): void {
    this.db
      .prepare(
        `INSERT INTO pending_permissions (requestId,sessionId,toolName,kind,questions,toolInput,createdAt)
         VALUES (@requestId,@sessionId,@toolName,@kind,@questions,@toolInput,@createdAt)
         ON CONFLICT(requestId) DO UPDATE SET
           sessionId=excluded.sessionId, toolName=excluded.toolName, kind=excluded.kind,
           questions=excluded.questions, toolInput=excluded.toolInput, createdAt=excluded.createdAt`,
      )
      .run({
        ...rec,
        kind: rec.kind ?? "question",
        questions: JSON.stringify(rec.questions ?? []),
        toolInput: rec.toolInput === undefined ? null : JSON.stringify(rec.toolInput),
      });
  }

  /** True if the session has any persisted tool-approval awaiting a decision. */
  hasPendingApproval(sessionId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM pending_permissions WHERE sessionId=? AND kind='approval' LIMIT 1`,
      )
      .get(sessionId);
    return !!row;
  }

  deletePendingPermission(requestId: string): void {
    this.db.prepare(`DELETE FROM pending_permissions WHERE requestId=?`).run(requestId);
  }

  deletePendingPermissionsBySession(sessionId: string): void {
    this.db.prepare(`DELETE FROM pending_permissions WHERE sessionId=?`).run(sessionId);
  }

  getPendingPermission(requestId: string): PendingPermissionRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM pending_permissions WHERE requestId=?`)
      .get(requestId) as RawPendingRow | undefined;
    return row ? this.rowToPending(row) : null;
  }

  listPendingPermissions(sessionId: string): PendingPermissionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM pending_permissions WHERE sessionId=? ORDER BY createdAt ASC`)
      .all(sessionId) as RawPendingRow[];
    return rows.map((r) => this.rowToPending(r));
  }

  /* ---------------- dismissed questions (忽略遗留提问) ---------------- */

  /** Mark AskUserQuestion ids as dismissed so they no longer count as "needs answer". */
  dismissQuestions(sessionId: string, questionIds: string[], dismissedAt: string): void {
    const stmt = this.db.prepare(
      `INSERT INTO dismissed_questions (questionId,sessionId,dismissedAt)
       VALUES (?,?,?) ON CONFLICT(questionId) DO NOTHING`,
    );
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) stmt.run(id, sessionId, dismissedAt);
    });
    tx(questionIds);
  }

  /** All dismissed question ids (loaded once into memory for fast attention checks). */
  listDismissedQuestionIds(): string[] {
    const rows = this.db.prepare(`SELECT questionId FROM dismissed_questions`).all() as {
      questionId: string;
    }[];
    return rows.map((r) => r.questionId);
  }

  private rowToPending(r: RawPendingRow): PendingPermissionRecord {
    return {
      requestId: r.requestId,
      sessionId: r.sessionId,
      toolName: r.toolName,
      kind: r.kind === "approval" ? "approval" : "question",
      questions: safeParse(r.questions),
      toolInput: r.toolInput == null ? undefined : safeParse(r.toolInput),
      createdAt: r.createdAt,
    };
  }

  close(): void {
    this.db.close();
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
