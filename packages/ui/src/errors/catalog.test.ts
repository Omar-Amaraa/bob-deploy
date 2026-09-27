import type { ErrorCode } from '@bob-deploy/contracts';
import { describe, expect, it } from 'vitest';
import { ERROR_CATALOG } from './catalog.js';

const CONTRACT_ERROR_CODES = [
  'LOCKED',
  'NO_ACCOUNT',
  'ACCOUNT_EXISTS',
  'BAD_PASSWORD',
  'WEAK_PASSWORD',
  'TOO_MANY_ATTEMPTS',
  'BAD_RECOVERY_CODE',
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'JOB_RUNNING',
  'CANCELLED',
  'BOB_NOT_INSTALLED',
  'BOB_NODE_TOO_OLD',
  'BOB_LICENSE_NOT_ACCEPTED',
  'BOB_AUTH_FAILED',
  'BOB_FAILED',
  'BOB_BAD_OUTPUT',
  'SSH_UNREACHABLE',
  'SSH_AUTH_FAILED',
  'SSH_HOSTKEY_MISMATCH',
  'SSH_HOSTKEY_REJECTED',
  'SSH_TIMEOUT',
  'DNS_MISMATCH',
  'UNSUPPORTED_OS',
  'UNSUPPORTED_STACK',
  'SERVER_NOT_FRESH',
  'HOST_AUTH_FAILED',
  'HOST_API_ERROR',
  'HOST_UNSUPPORTED',
  'BUILD_FAILED',
  'HEALTHCHECK_FAILED',
  'HARDENING_FAILED',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

describe('error catalogue', () => {
  it('contains plain-language copy for every contract error code', () => {
    expect(Object.keys(ERROR_CATALOG).sort()).toEqual([...CONTRACT_ERROR_CODES].sort());
    for (const code of CONTRACT_ERROR_CODES) {
      expect(ERROR_CATALOG[code].title.length).toBeGreaterThan(3);
      expect(ERROR_CATALOG[code].body.length).toBeGreaterThan(8);
    }
  });
});
