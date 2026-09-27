import type { ErrorCode } from '@bob-deploy/contracts';

export class SshError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SshError';
    this.code = code;
    this.details = details;
  }
}

const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT']);

/** Maps a raw ssh2 connection-time error (network error, auth failure, ready timeout) to a plain-
 * language SshError with the matching contracts ErrorCode. */
export function classifyConnectError(err: unknown): SshError {
  const code = (err as { code?: string } | undefined)?.code;
  const message = err instanceof Error ? err.message : String(err);

  if (code && UNREACHABLE_CODES.has(code)) {
    return new SshError('SSH_UNREACHABLE', 'The server could not be reached.', { cause: message });
  }
  if (message.includes('All configured authentication methods failed')) {
    return new SshError('SSH_AUTH_FAILED', 'The server did not accept the password.', { cause: message });
  }
  if (message.toLowerCase().includes('timed out while waiting for handshake') || message.toLowerCase().includes('timeout')) {
    return new SshError('SSH_TIMEOUT', 'The server did not respond in time.', { cause: message });
  }
  return new SshError('SSH_UNREACHABLE', 'Could not connect to the server.', { cause: message });
}
