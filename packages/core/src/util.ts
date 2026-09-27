import { randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

export function nowIso(clockNow?: () => Date): string {
  return (clockNow ? clockNow() : new Date()).toISOString();
}

/** Thrown by repositories on an obvious invariant violation (not found, conflict, ...). */
export class RepoError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RepoError';
    this.code = code;
  }
}
