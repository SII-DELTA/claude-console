/**
 * Protocol version + constants shared across all transport layers.
 */
export const PROTOCOL_VERSION = 1 as const;

export const DEFAULT_PORT = 7345;

export const WS_PATH = "/ws";

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 60_000;

export const PAIR_CODE_LENGTH = 8;
export const PAIR_CODE_TTL_MS = 5 * 60_000;

export const MAX_LOG_BUFFER_PER_SESSION = 5_000;

/** Claude 会话文件 mtime 在该窗口内视为「活跃」(可能有进程在写)。
 * 仅作提示：自然停顿可能误判，最终安全靠 continue 的 force 显式确认。 */
export const LIVE_WINDOW_MS = 30_000;

export const ERROR_CODES = {
  UNAUTHORIZED: "unauthorized",
  NOT_FOUND: "not_found",
  BAD_REQUEST: "bad_request",
  INTERNAL: "internal",
  RATE_LIMITED: "rate_limited",
  PAIRING_EXPIRED: "pairing_expired",
  PAIRING_INVALID: "pairing_invalid",
  SESSION_FAILED: "session_failed",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
