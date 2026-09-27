export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };

export type ErrorCode =
  | 'LOCKED'
  | 'NO_ACCOUNT'
  | 'ACCOUNT_EXISTS'
  | 'BAD_PASSWORD'
  | 'WEAK_PASSWORD'
  | 'TOO_MANY_ATTEMPTS'
  | 'BAD_RECOVERY_CODE'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'JOB_RUNNING'
  | 'CANCELLED'
  | 'BOB_NOT_INSTALLED'
  | 'BOB_NODE_TOO_OLD'
  | 'BOB_LICENSE_NOT_ACCEPTED'
  | 'BOB_AUTH_FAILED'
  | 'BOB_FAILED'
  | 'BOB_BAD_OUTPUT'
  | 'SSH_UNREACHABLE'
  | 'SSH_AUTH_FAILED'
  | 'SSH_HOSTKEY_MISMATCH'
  | 'SSH_HOSTKEY_REJECTED'
  | 'SSH_TIMEOUT'
  | 'DNS_MISMATCH'
  | 'UNSUPPORTED_OS'
  | 'UNSUPPORTED_STACK'
  | 'SERVER_NOT_FRESH'
  | 'HOST_AUTH_FAILED'
  | 'HOST_API_ERROR'
  | 'HOST_UNSUPPORTED'
  | 'BUILD_FAILED'
  | 'HEALTHCHECK_FAILED'
  | 'HARDENING_FAILED'
  | 'INTERNAL';

export interface AppError {
  code: ErrorCode;
  message: string; // plain language, safe to show, already redacted
  details?: Record<string, unknown>; // never contains secrets
}

export type TimeRange = '24h' | '7d' | '30d';

export interface Clock {
  now(): Date;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
