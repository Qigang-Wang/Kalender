export type MailProviderErrorCode =
  | "AUTH_REQUIRED"
  | "TOKEN_EXPIRED"
  | "PERMISSION_DENIED"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNSUPPORTED"
  | "INVALID_REQUEST"
  | "REMOTE_ERROR"
  | "CANCELLED";

export interface MailProviderErrorOptions {
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly providerId?: string;
  readonly accountId?: string;
  readonly cause?: unknown;
}

export class MailProviderError extends Error {
  readonly code: MailProviderErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly providerId?: string;
  readonly accountId?: string;
  readonly originalCause?: unknown;

  constructor(
    code: MailProviderErrorCode,
    message: string,
    options: MailProviderErrorOptions = {},
  ) {
    super(message);
    this.name = "MailProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.providerId = options.providerId;
    this.accountId = options.accountId;
    this.originalCause = options.cause;
  }
}

export function normalizeMailProviderError(
  error: unknown,
  context: { readonly providerId?: string; readonly accountId?: string } = {},
): MailProviderError {
  if (error instanceof MailProviderError) {
    return error;
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return new MailProviderError("CANCELLED", "Provider operation was cancelled", {
      providerId: context.providerId,
      accountId: context.accountId,
      cause: error,
    });
  }

  const message = error instanceof Error ? error.message : "Unknown provider error";
  return new MailProviderError("REMOTE_ERROR", message, {
    providerId: context.providerId,
    accountId: context.accountId,
    cause: error,
  });
}
