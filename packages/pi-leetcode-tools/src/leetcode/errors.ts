import type { Region, ToolErrorCode, ToolFailure, ToolMeta } from "../types.js";

export class LeetCodeToolError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly operationId: string | undefined;
  readonly details:
    | Record<string, string | number | boolean | null>
    | undefined;

  constructor(
    code: ToolErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      retryAfterMs?: number;
      operationId?: string;
      details?: Record<string, string | number | boolean | null>;
      cause?: unknown;
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LeetCodeToolError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.operationId = options.operationId;
    this.details = options.details;
  }
}

export function toToolFailure(
  error: unknown,
  meta: ToolMeta,
  fallbackCode: ToolErrorCode = "REMOTE_UNAVAILABLE"
): ToolFailure {
  if (error instanceof LeetCodeToolError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: error.retryAfterMs }),
        ...(error.operationId === undefined
          ? {}
          : { operationId: error.operationId }),
        ...(error.details === undefined ? {} : { details: error.details })
      },
      meta
    };
  }

  return {
    ok: false,
    error: {
      code: fallbackCode,
      message: "LeetCode request failed",
      retryable: true
    },
    meta
  };
}

export function unsupportedRegion(region: never): LeetCodeToolError {
  return new LeetCodeToolError(
    "UNSUPPORTED_REGION",
    `Unsupported LeetCode region: ${String(region)}`
  );
}

export function authRequired(region: Region): LeetCodeToolError {
  return new LeetCodeToolError(
    "AUTH_REQUIRED",
    `Authentication is required for LeetCode ${region}`
  );
}
