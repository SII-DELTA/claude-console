import { z } from "zod";

/* ─────────────────────────── Core entity types ─────────────────────────── */

export const AgentSessionTypeSchema = z.enum(["claude", "shell", "custom"]);
export type AgentSessionType = z.infer<typeof AgentSessionTypeSchema>;

export const AgentSessionStatusSchema = z.enum([
  "idle",
  "running",
  "waiting",
  "error",
  "completed",
]);
export type AgentSessionStatus = z.infer<typeof AgentSessionStatusSchema>;

export const AgentSessionSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  title: z.string().min(1),
  type: AgentSessionTypeSchema,
  command: z.string().min(1),
  cwd: z.string().min(1),
  env: z.record(z.string()).optional(),
  status: AgentSessionStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastMessage: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const AgentLogLevelSchema = z.enum(["info", "action", "test", "error", "warn"]);
export type AgentLogLevel = z.infer<typeof AgentLogLevelSchema>;

export const AgentLogSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  timestamp: z.string(),
  level: AgentLogLevelSchema,
  content: z.string(),
  raw: z.string().optional(),
});
export type AgentLog = z.infer<typeof AgentLogSchema>;

export const FileChangeKindSchema = z.enum(["added", "modified", "deleted"]);
export type FileChangeKind = z.infer<typeof FileChangeKindSchema>;

export const FileChangeSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  path: z.string().min(1),
  kind: FileChangeKindSchema,
  addedLines: z.number().int().nonnegative(),
  removedLines: z.number().int().nonnegative(),
  timestamp: z.string(),
  diff: z.string().optional(),
});
export type FileChange = z.infer<typeof FileChangeSchema>;

/* ─────────────────────────── Claude Code native sessions ─────────────────── */

export const ClaudeSessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  workspaceId: z.string().min(1),
  cwd: z.string().min(1),
  sessionFilePath: z.string().min(1),
  createdAt: z.string().optional(),
  updatedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
  userMessageCount: z.number().int().nonnegative(),
  assistantMessageCount: z.number().int().nonnegative(),
  toolUseCount: z.number().int().nonnegative(),
  modelId: z.string().optional(),
  /** 最近一轮 assistant 的总输入上下文 token（input + cache read + cache creation），≈ 当前上下文窗口占用 */
  contextTokens: z.number().int().nonnegative().optional(),
  /** 文件近 LIVE_WINDOW_MS 内仍在写 → 该会话可能有活跃进程，接管前需提示 */
  isLive: z.boolean(),
  /** 该 live 是由本 agent 的 driver 进程驱动的（而非终端等外部）。 */
  drivenByAgent: z.boolean().optional(),
  /** 本 agent 的 driver 此刻正在跑一轮（write→done 之间）。权威的"运行中"信号。 */
  driving: z.boolean().optional(),
  preview: z.string().optional(),
  /** 最近一条用户指令（截断）。无原生 ai-title 时作为标题兜底。 */
  lastUserText: z.string().optional(),
  /** Claude Code 原生维护的会话标题（jsonl 的 ai-title 行）。监控台标题首选。 */
  aiTitle: z.string().optional(),
  /** 运行中会话的最近一个工具动作（友好串，如「编辑 Dashboard.tsx」）。 */
  lastActivity: z.string().optional(),
  /** 最后一条 assistant 文本首行（已完成会话的结果摘要）。 */
  lastResult: z.string().optional(),
  /**
   * 该会话是否需要用户关注（供监控台跨会话聚合，无需点进会话即可判断）：
   * - question: 末尾 assistant turn 含未应答的 AskUserQuestion
   * - error:    最近一次回合以错误结束
   * - done:     非 live 且最后回合已完成（跑完待续写）
   * 缺省表示无需关注。
   */
  attention: z.enum(["question", "approval", "error", "done"]).optional(),
});
export type ClaudeSession = z.infer<typeof ClaudeSessionSchema>;

export const ClaudeProjectSchema = z.object({
  /** ~/.claude/projects 下的编码目录名（项目唯一键） */
  dir: z.string().min(1),
  /** 解码 / 从会话 cwd 字段得到的真实路径 */
  cwd: z.string().min(1),
  /** 展示名（cwd 的 basename） */
  name: z.string().min(1),
  sessionCount: z.number().int().nonnegative(),
  liveCount: z.number().int().nonnegative(),
  updatedAt: z.string(),
  active: z.boolean().optional(),
  /** 用户在「项目管理」里隐藏了它 → 不在监控台总览/切换栏出现。 */
  hidden: z.boolean().optional(),
  /** 用户手动新增（pin）的项目，可能还没有任何会话。 */
  pinned: z.boolean().optional(),
});
export type ClaudeProject = z.infer<typeof ClaudeProjectSchema>;

export const ClaudeMessageBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("thinking"), text: z.string() }),
  z.object({ kind: z.literal("image"), mediaType: z.string(), dataBase64: z.string() }),
  z.object({
    kind: z.literal("tool_use"),
    toolName: z.string(),
    input: z.unknown().optional(),
    toolUseId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("tool_result"),
    toolUseId: z.string().optional(),
    content: z.string(),
    isError: z.boolean().optional(),
  }),
]);
export type ClaudeMessageBlock = z.infer<typeof ClaudeMessageBlockSchema>;

export const ClaudeMessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  parentUuid: z.string().nullable().optional(),
  role: z.enum(["user", "assistant", "system"]),
  blocks: z.array(ClaudeMessageBlockSchema),
  timestamp: z.string(),
});
export type ClaudeMessage = z.infer<typeof ClaudeMessageSchema>;

export const ClaudeDriveStatusSchema = z.enum([
  "pending",
  "streaming",
  "completed",
  "failed",
]);
export type ClaudeDriveStatus = z.infer<typeof ClaudeDriveStatusSchema>;

export const WorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rootPath: z.string().min(1),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const SwitchWorkspaceBodySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  rootPath: z.string().min(1).optional(),
});
export type SwitchWorkspaceBody = z.infer<typeof SwitchWorkspaceBodySchema>;

export const PairedDeviceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  platform: z.enum(["ios", "android", "web", "unknown"]),
  pairedAt: z.string(),
  lastSeenAt: z.string(),
  revoked: z.boolean().optional(),
});
export type PairedDevice = z.infer<typeof PairedDeviceSchema>;

/* ─────────────────────────── REST request / response ─────────────────────── */

export const CreateSessionInputSchema = z.object({
  type: AgentSessionTypeSchema,
  title: z.string().min(1).max(200).optional(),
  command: z.string().min(1).max(4_000).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string()).optional(),
});
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

export const SessionInputBodySchema = z.object({
  data: z.string(),
  appendNewline: z.boolean().optional(),
});
export type SessionInputBody = z.infer<typeof SessionInputBodySchema>;

export const PairRequestSchema = z.object({
  pairCode: z.string().min(1),
  deviceName: z.string().min(1).max(100),
  platform: z.enum(["ios", "android", "web", "unknown"]).default("unknown"),
});
export type PairRequest = z.infer<typeof PairRequestSchema>;

export const PairResponseSchema = z.object({
  token: z.string().min(1),
  device: PairedDeviceSchema,
  workspace: WorkspaceSchema,
  serverVersion: z.string(),
});
export type PairResponse = z.infer<typeof PairResponseSchema>;

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  workspaceId: z.string().optional(),
  /** how clients should authenticate: none (open) / password / pair code */
  auth: z.enum(["none", "password", "pair"]).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const PasswordLoginSchema = z.object({
  // may be "" in no-auth mode; a real password still fails the constant-time compare
  password: z.string().max(512),
  deviceName: z.string().min(1).max(100),
  platform: z.enum(["ios", "android", "web", "unknown"]).default("unknown"),
});
export type PasswordLogin = z.infer<typeof PasswordLoginSchema>;

export const ListWorkspacesResponseSchema = z.object({
  workspaces: z.array(WorkspaceSchema),
  current: WorkspaceSchema,
});
export type ListWorkspacesResponse = z.infer<typeof ListWorkspacesResponseSchema>;

export const ListSessionsResponseSchema = z.object({
  sessions: z.array(AgentSessionSchema),
});
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;

export const ListLogsQuerySchema = z.object({
  since: z.string().optional(),
  limit: z.coerce.number().int().positive().max(2_000).optional(),
  level: AgentLogLevelSchema.optional(),
});
export type ListLogsQuery = z.infer<typeof ListLogsQuerySchema>;

export const ListLogsResponseSchema = z.object({
  logs: z.array(AgentLogSchema),
});
export type ListLogsResponse = z.infer<typeof ListLogsResponseSchema>;

export const ListFilesResponseSchema = z.object({
  changes: z.array(FileChangeSchema),
});
export type ListFilesResponse = z.infer<typeof ListFilesResponseSchema>;

export const ListClaudeSessionsResponseSchema = z.object({
  sessions: z.array(ClaudeSessionSchema),
});
export type ListClaudeSessionsResponse = z.infer<typeof ListClaudeSessionsResponseSchema>;

export const ClaudeSessionDetailResponseSchema = z.object({
  session: ClaudeSessionSchema,
  messages: z.array(ClaudeMessageSchema),
  /** byte cursor at end-of-file for subsequent incremental tail reads (optional, back-compat) */
  cursor: z.number().optional(),
});
export type ClaudeSessionDetailResponse = z.infer<typeof ClaudeSessionDetailResponseSchema>;

/** Incremental tail: messages appended since the requested byte cursor, plus the new cursor. */
export const ClaudeSessionTailResponseSchema = z.object({
  session: ClaudeSessionSchema,
  messages: z.array(ClaudeMessageSchema),
  cursor: z.number(),
});
export type ClaudeSessionTailResponse = z.infer<typeof ClaudeSessionTailResponseSchema>;

export const ClaudeImageSchema = z.object({
  mediaType: z.string().min(1),
  /** raw base64 (no data: prefix) */
  dataBase64: z.string().min(1),
});
export type ClaudeImage = z.infer<typeof ClaudeImageSchema>;

export const ClaudePermissionModeSchema = z.enum([
  "plan",
  "auto",
  "default",
  "acceptEdits",
  "bypassPermissions",
]);
export type ClaudePermissionMode = z.infer<typeof ClaudePermissionModeSchema>;

export const ClaudeContinueBodySchema = z.object({
  prompt: z.string().min(1).max(50_000),
  /** 越过 isLive 检查，强制接管（web 在 409 确认后重试时带上） */
  force: z.boolean().optional(),
  images: z.array(ClaudeImageSchema).max(8).optional(),
  permissionMode: ClaudePermissionModeSchema.optional(),
});
export type ClaudeContinueBody = z.infer<typeof ClaudeContinueBodySchema>;

/** One AskUserQuestion question surfaced to the client for interactive answering. */
export const ClaudePermissionQuestionSchema = z.object({
  question: z.string(),
  header: z.string().optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(
    z.object({ label: z.string(), description: z.string().optional() }),
  ),
});
export type ClaudePermissionQuestion = z.infer<typeof ClaudePermissionQuestionSchema>;

/** A recoverable pending permission (AskUserQuestion) for a session. */
export const ClaudePendingPermissionSchema = z.object({
  requestId: z.string(),
  toolName: z.string(),
  questions: z.array(ClaudePermissionQuestionSchema),
  /** true: still answerable in-process; false: only persisted (needs resume to answer). */
  live: z.boolean(),
});
export type ClaudePendingPermission = z.infer<typeof ClaudePendingPermissionSchema>;

/** A recoverable pending tool-approval (allow/deny) for a non-AskUserQuestion tool. */
export const ClaudeToolApprovalSchema = z.object({
  requestId: z.string(),
  toolName: z.string(),
  /** Human-readable summary of the tool input (display only; not authoritative). */
  summary: z.string(),
  /** true: still answerable in-process; false: only persisted (process gone). */
  live: z.boolean(),
});
export type ClaudeToolApproval = z.infer<typeof ClaudeToolApprovalSchema>;

export const ClaudePendingPermissionsResponseSchema = z.object({
  pending: z.array(ClaudePendingPermissionSchema),
  approvals: z.array(ClaudeToolApprovalSchema).optional(),
});
export type ClaudePendingPermissionsResponse = z.infer<
  typeof ClaudePendingPermissionsResponseSchema
>;

/** Body for answering a pending interactive permission (AskUserQuestion). */
export const ClaudeAnswerPermissionBodySchema = z.object({
  requestId: z.string().min(1),
  /** question text → chosen label(s); string for single-select, array for multi. */
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
});
export type ClaudeAnswerPermissionBody = z.infer<typeof ClaudeAnswerPermissionBodySchema>;

/** Body for answering a pending tool approval (allow once / deny). */
export const ClaudeAnswerToolApprovalBodySchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(["allow", "deny"]),
});
export type ClaudeAnswerToolApprovalBody = z.infer<typeof ClaudeAnswerToolApprovalBodySchema>;

export const ClaudeCreateBodySchema = z.object({
  prompt: z.string().min(1).max(50_000),
  cwd: z.string().min(1).optional(),
  images: z.array(ClaudeImageSchema).max(8).optional(),
  permissionMode: ClaudePermissionModeSchema.optional(),
});
export type ClaudeCreateBody = z.infer<typeof ClaudeCreateBodySchema>;

export const ListClaudeProjectsResponseSchema = z.object({
  projects: z.array(ClaudeProjectSchema),
});
export type ListClaudeProjectsResponse = z.infer<typeof ListClaudeProjectsResponseSchema>;

export const ClaudeSwitchProjectBodySchema = z.object({
  dir: z.string().min(1),
});
export type ClaudeSwitchProjectBody = z.infer<typeof ClaudeSwitchProjectBodySchema>;

/** Hide / unhide a project from the monitor (by its encoded dir key). */
export const ClaudeProjectHideBodySchema = z.object({
  dir: z.string().min(1),
});
export type ClaudeProjectHideBody = z.infer<typeof ClaudeProjectHideBodySchema>;

/** Add (pin) a project by its real cwd, so it shows even with 0 sessions. */
export const ClaudeAddProjectBodySchema = z.object({
  cwd: z.string().min(1),
});
export type ClaudeAddProjectBody = z.infer<typeof ClaudeAddProjectBodySchema>;

/** One directory entry from the filesystem browser (folders only). */
export const FsDirEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
});
export type FsDirEntry = z.infer<typeof FsDirEntrySchema>;

export const FsListResponseSchema = z.object({
  /** absolute path that was listed */
  path: z.string(),
  /** parent dir, or null at filesystem root */
  parent: z.string().nullable(),
  /** the user's home dir (for the "~" quick root) */
  home: z.string(),
  entries: z.array(FsDirEntrySchema),
});
export type FsListResponse = z.infer<typeof FsListResponseSchema>;

export const TranscribeResponseSchema = z.object({
  text: z.string(),
  mocked: z.boolean().optional(),
});
export type TranscribeResponse = z.infer<typeof TranscribeResponseSchema>;

/* ─────────────────────────── WebSocket envelopes ─────────────────────────── */

export const ClientHelloSchema = z.object({
  type: z.literal("client:hello"),
  token: z.string().min(1),
  deviceId: z.string().min(1).optional(),
  platform: z.enum(["ios", "android", "web", "unknown"]).optional(),
});

export const ClientInputSchema = z.object({
  type: z.literal("client:input"),
  sessionId: z.string().min(1),
  data: z.string(),
  appendNewline: z.boolean().optional(),
});

export const ClientInterruptSchema = z.object({
  type: z.literal("client:interrupt"),
  sessionId: z.string().min(1),
});

export const ClientCreateSessionSchema = z.object({
  type: z.literal("client:create_session"),
  payload: CreateSessionInputSchema,
});

export const ClientDeleteSessionSchema = z.object({
  type: z.literal("client:delete_session"),
  sessionId: z.string().min(1),
});

export const ClientSubscribeSchema = z.object({
  type: z.literal("client:subscribe"),
  sessionId: z.string().min(1).optional(),
});

export const ClientPingSchema = z.object({
  type: z.literal("client:ping"),
  ts: z.number().int().optional(),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  ClientHelloSchema,
  ClientInputSchema,
  ClientInterruptSchema,
  ClientCreateSessionSchema,
  ClientDeleteSessionSchema,
  ClientSubscribeSchema,
  ClientPingSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const ServerHelloSchema = z.object({
  type: z.literal("server:hello"),
  serverVersion: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  protocolVersion: z.number(),
});

export const ServerSessionCreatedSchema = z.object({
  type: z.literal("server:session_created"),
  session: AgentSessionSchema,
});

export const ServerSessionUpdatedSchema = z.object({
  type: z.literal("server:session_updated"),
  session: AgentSessionSchema,
});

export const ServerSessionDeletedSchema = z.object({
  type: z.literal("server:session_deleted"),
  sessionId: z.string(),
});

export const ServerLogSchema = z.object({
  type: z.literal("server:log"),
  log: AgentLogSchema,
});

export const ServerFileChangedSchema = z.object({
  type: z.literal("server:file_changed"),
  change: FileChangeSchema,
});

export const ServerCommandStartedSchema = z.object({
  type: z.literal("server:command_started"),
  sessionId: z.string(),
  command: z.string(),
});

export const ServerCommandFinishedSchema = z.object({
  type: z.literal("server:command_finished"),
  sessionId: z.string(),
  exitCode: z.number().int().nullable(),
});

export const ServerClaudeSessionUpdatedSchema = z.object({
  type: z.literal("server:claude_session_updated"),
  session: ClaudeSessionSchema,
});

export const ServerClaudeMessageSchema = z.object({
  type: z.literal("server:claude_message"),
  sessionId: z.string().min(1),
  message: ClaudeMessageSchema,
});

export const ServerClaudeDeltaSchema = z.object({
  type: z.literal("server:claude_delta"),
  sessionId: z.string().min(1),
  /** 增量文本（assistant 文本块的流式片段） */
  delta: z.string(),
  /** 增量所属块类型 */
  blockKind: z.enum(["text", "thinking", "tool_use"]).default("text"),
  status: ClaudeDriveStatusSchema,
  timestamp: z.string(),
});

export const ClaudeUsageSchema = z.object({
  costUsd: z.number().optional(),
  durationMs: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});
export type ClaudeUsage = z.infer<typeof ClaudeUsageSchema>;

export const ServerClaudeDriveDoneSchema = z.object({
  type: z.literal("server:claude_drive_done"),
  sessionId: z.string().min(1),
  timestamp: z.string(),
  usage: ClaudeUsageSchema.optional(),
});

export const ServerClaudeDriveErrorSchema = z.object({
  type: z.literal("server:claude_drive_error"),
  sessionId: z.string().min(1).optional(),
  message: z.string(),
  timestamp: z.string(),
});

export const ServerClaudeRateLimitSchema = z.object({
  type: z.literal("server:claude_rate_limit"),
  resetsAt: z.number().optional(),
  limitType: z.string().optional(),
  status: z.string().optional(),
});

/** An interactive permission (AskUserQuestion) awaiting the user's choice. */
export const ServerClaudePermissionRequestSchema = z.object({
  type: z.literal("server:claude_permission_request"),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  toolName: z.string(),
  questions: z.array(ClaudePermissionQuestionSchema),
});

/** A non-AskUserQuestion tool is awaiting the user's allow/deny decision. */
export const ServerClaudeToolApprovalRequestSchema = z.object({
  type: z.literal("server:claude_tool_approval_request"),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  toolName: z.string(),
  summary: z.string(),
});

/** A previously-surfaced permission request is no longer pending (answered/cancelled). */
export const ServerClaudePermissionCancelSchema = z.object({
  type: z.literal("server:claude_permission_cancel"),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
});

/** Authoritative "a turn is (not) running" signal for a session. */
export const ServerClaudeDrivingSchema = z.object({
  type: z.literal("server:claude_driving"),
  sessionId: z.string().min(1),
  driving: z.boolean(),
});

export const ServerErrorSchema = z.object({
  type: z.literal("server:error"),
  message: z.string(),
  code: z.string().optional(),
});

export const ServerPongSchema = z.object({
  type: z.literal("server:pong"),
  ts: z.number().int().optional(),
});

/** A browser Web Push subscription (the JSON from PushSubscription.toJSON()). */
export const PushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export type PushSubscriptionJSON = z.infer<typeof PushSubscriptionSchema>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  ServerHelloSchema,
  ServerSessionCreatedSchema,
  ServerSessionUpdatedSchema,
  ServerSessionDeletedSchema,
  ServerLogSchema,
  ServerFileChangedSchema,
  ServerCommandStartedSchema,
  ServerCommandFinishedSchema,
  ServerClaudeSessionUpdatedSchema,
  ServerClaudeMessageSchema,
  ServerClaudeDeltaSchema,
  ServerClaudeDriveDoneSchema,
  ServerClaudeDriveErrorSchema,
  ServerClaudeRateLimitSchema,
  ServerClaudePermissionRequestSchema,
  ServerClaudeToolApprovalRequestSchema,
  ServerClaudePermissionCancelSchema,
  ServerClaudeDrivingSchema,
  ServerErrorSchema,
  ServerPongSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
