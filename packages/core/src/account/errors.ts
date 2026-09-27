import type { ErrorCode } from '@bob-deploy/contracts';

/** Thrown by AccountService / the vault layer. Carries the same `code` shape as contracts' AppError
 * so an IPC handler can turn it into `{ ok: false, error: { code, message, details } }` directly. */
export class AccountError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
    this.details = details;
  }
}
