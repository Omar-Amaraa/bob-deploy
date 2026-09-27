/**
 * S12 (new) — "Master password >= 12 chars and zxcvbn score >= 3; Argon2id (m = 64 MiB, t = 3,
 * p = 1, 16-byte salt); password never stored; DEK zeroed on lock; exponential backoff after 5
 * wrong attempts."
 *
 * account-service.test.ts (tagged "S12") already exercises the backoff curve, checkPassword, and
 * "DEK zeroed on lock" end to end against a real AccountService. This file pins down the exact
 * numeric parameters the requirement names (which account-service.test.ts's behavioral tests don't
 * need to restate) so a future change to CURRENT_KDF_PARAMS or PASSWORD_POLICY that silently
 * weakens them fails CI immediately.
 */
import { describe, it, expect } from 'vitest';
import { ARGON2ID_PARAMS, CURRENT_KDF_PARAMS, deriveKey } from '../crypto.js';
import { randomBytes } from 'node:crypto';
import { PASSWORD_POLICY } from '@bob-deploy/contracts';

describe('S12: the exact KDF/password parameters the requirement names', () => {
  it('Argon2id: 64 MiB memory, 3 iterations, 1 lane, 16-byte salt (salt length is wrapDek\'s randomBytes(16), checked in account-service.test.ts)', () => {
    expect(ARGON2ID_PARAMS.memorySize).toBe(65536); // KiB
    expect(ARGON2ID_PARAMS.iterations).toBe(3);
    expect(ARGON2ID_PARAMS.parallelism).toBe(1);
    expect(CURRENT_KDF_PARAMS).toEqual({ alg: 'argon2id', m: 65536, t: 3, p: 1 });
  });

  it('password policy: minimum 12 characters, minimum zxcvbn score 3', () => {
    expect(PASSWORD_POLICY.minLength).toBe(12);
    expect(PASSWORD_POLICY.minScore).toBe(3);
  });

  it('unlock (Argon2id derive at CURRENT_KDF_PARAMS) takes >= 200 ms on the CI machine, so the cost parameters are not so low they stopped mattering on real hardware', async () => {
    const salt = randomBytes(16);
    const started = process.hrtime.bigint();
    await deriveKey('a-plausible-master-password-123', salt, CURRENT_KDF_PARAMS);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeGreaterThanOrEqual(200);
  });
});
