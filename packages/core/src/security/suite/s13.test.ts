/**
 * S13 (new) — "Recovery code (160 bits) shown once; stored only as a second wrapping of the DEK;
 * regenerating invalidates the old one."
 *
 * passphrase.test.ts (tagged "S13") covers generateRecoveryCode's shape/entropy; account-service
 * .test.ts's "AccountService.regenerateRecoveryCode" describe (tagged "S13") covers issuing a fresh
 * code. This file is the one thing neither directly asserts: that the *old* recovery code stops
 * working the moment a new one is issued (regenerateRecoveryCode and recover() both replace
 * account.recoveryWrap, but nothing before this explicitly proved the old wrap can no longer unwrap
 * the DEK afterward).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountService } from '../../account/account-service.js';
import { Redactor } from '../redactor.js';
import { RECOVERY_CODE_BITS } from '../passphrase.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('S13: regenerating (or recovering with) a recovery code invalidates the old one', () => {
  it('RECOVERY_CODE_BITS is 160, matching the requirement', () => {
    expect(RECOVERY_CODE_BITS).toBe(160);
  });

  it('regenerateRecoveryCode() replaces the wrap so the old code is rejected afterward', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'bd-s13-'));
    tempDirs.push(dataDir);
    const account = new AccountService({ dataDir, redactor: new Redactor() });
    const { recoveryCode: oldCode } = await account.create({
      displayName: 'Suite',
      email: 's13@example.com',
      masterPassword: 'correct-horse-battery-Staple-42',
    });

    await account.regenerateRecoveryCode('correct-horse-battery-Staple-42');

    await expect(account.recover({ recoveryCode: oldCode, newPassword: 'another-Strong-Password-99' })).rejects.toMatchObject({
      code: 'BAD_RECOVERY_CODE',
    });
  });

  it('recover() with the current code also issues a fresh one that immediately invalidates it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'bd-s13b-'));
    tempDirs.push(dataDir);
    const account = new AccountService({ dataDir, redactor: new Redactor() });
    const { recoveryCode: firstCode } = await account.create({
      displayName: 'Suite',
      email: 's13b@example.com',
      masterPassword: 'correct-horse-battery-Staple-42',
    });

    const { recoveryCode: secondCode } = await account.recover({ recoveryCode: firstCode, newPassword: 'Second-Strong-Password-77' });
    expect(secondCode).not.toBe(firstCode);

    account.lock();
    await expect(account.recover({ recoveryCode: firstCode, newPassword: 'Third-Strong-Password-55' })).rejects.toMatchObject({
      code: 'BAD_RECOVERY_CODE',
    });
    // The second (current) code still works.
    const result = await account.recover({ recoveryCode: secondCode, newPassword: 'Fourth-Strong-Password-33' });
    expect(result.recoveryCode).not.toBe(secondCode);
  });
});
