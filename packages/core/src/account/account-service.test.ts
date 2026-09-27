import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KeyProtector } from '@bob-deploy/contracts';
import { AccountService } from './account-service.js';
import { AccountError } from './errors.js';
import { Redactor } from '../security/redactor.js';
import { FakeClock } from '../testing/fake-clock.js';
import { vaultFilePath } from './vault-file.js';
import { accountFilePath } from './account-file.js';

const STRONG_PASSWORD = 'correct-horse-battery-Staple-42'; // testbed/test-secrets.json masterPassword

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'bd-account-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeService(opts: Partial<{ clock: FakeClock; keyProtector: KeyProtector; busy: () => boolean }> = {}) {
  const redactor = new Redactor();
  const clock = opts.clock ?? new FakeClock('2026-01-01T00:00:00.000Z');
  const service = new AccountService({ dataDir, redactor, clock, keyProtector: opts.keyProtector, busy: opts.busy });
  return { service, redactor, clock };
}

// A simple in-memory fake OS-keychain-style KeyProtector: XORs with a fixed key and prefixes a marker.
function makeFakeKeyProtector(available = true): KeyProtector & { setAvailable: (v: boolean) => void } {
  let isAvail = available;
  const MARKER = Buffer.from('FAKEPROT');
  const XOR_KEY = 0x5a;
  return {
    isAvailable: () => isAvail,
    setAvailable: (v: boolean) => {
      isAvail = v;
    },
    encryptString: (plain: string) => {
      const buf = Buffer.from(plain, 'utf8');
      const xored = Buffer.from(buf.map((b) => b ^ XOR_KEY));
      return Buffer.concat([MARKER, xored]);
    },
    decryptString: (cipher: Buffer) => {
      const body = cipher.subarray(MARKER.length);
      return Buffer.from(body.map((b) => b ^ XOR_KEY)).toString('utf8');
    },
  };
}

describe('AccountService.create', () => {
  it('creates an account, returns a recovery code, and stays unlocked', async () => {
    const { service } = makeService();
    const result = await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    expect(result.recoveryCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);

    const status = service.status();
    expect(status).toMatchObject({ exists: true, unlocked: true, onboardingComplete: false, displayName: 'Alice', email: 'alice@example.com' });
  });

  it('rejects ACCOUNT_EXISTS on a second create', async () => {
    const { service } = makeService();
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    await expect(service.create({ displayName: 'Bob', email: 'bob@example.com', masterPassword: STRONG_PASSWORD })).rejects.toMatchObject({
      code: 'ACCOUNT_EXISTS',
    });
  });

  it.each(['password123456', 'bobdeploy2026!', 'AliceAliceAliceAlice'])('rejects WEAK_PASSWORD for %s', async (weak) => {
    const { service } = makeService();
    await expect(service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: weak })).rejects.toMatchObject({
      code: 'WEAK_PASSWORD',
    });
  });

  it('never writes the master password, recovery code, or DEK in plaintext to account.json or vault.bin', async () => {
    const { service } = makeService();
    const { recoveryCode } = await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    service.setSecret('bob.apiKey', 'bob-test-key-DO-NOT-USE-5f2c');

    const accountBytes = readFileSync(accountFilePath(dataDir));
    const vaultBytes = readFileSync(vaultFilePath(dataDir));
    for (const secret of [STRONG_PASSWORD, recoveryCode, 'bob-test-key-DO-NOT-USE-5f2c']) {
      expect(accountBytes.includes(Buffer.from(secret, 'utf8'))).toBe(false);
      expect(vaultBytes.includes(Buffer.from(secret, 'utf8'))).toBe(false);
      const b64 = Buffer.from(secret, 'utf8').toString('base64');
      expect(accountBytes.includes(Buffer.from(b64, 'utf8'))).toBe(false);
      expect(vaultBytes.includes(Buffer.from(b64, 'utf8'))).toBe(false);
    }
  });
});

describe('AccountService.unlock / lock', () => {
  it('unlocks with the correct password and locks cleanly', async () => {
    const { service } = makeService();
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    service.lock('manual');
    expect(service.status().unlocked).toBe(false);

    const status = await service.unlock(STRONG_PASSWORD);
    expect(status.unlocked).toBe(true);
  });

  it('rejects BAD_PASSWORD on wrong password', async () => {
    const { service } = makeService();
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    service.lock('manual');
    await expect(service.unlock('totally-wrong-password')).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
  });

  it('after lock: getSecret throws LOCKED and the DEK is wiped to all zeros', async () => {
    const { service } = makeService();
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    service.setSecret('bob.apiKey', 'some-value');
    service.lock('manual');

    expect(() => service.getSecret('bob.apiKey')).toThrow(AccountError);
    expect(service.isDekZeroed()).toBe(true);
  });

  it('emits onLocked with the given reason', async () => {
    const redactor = new Redactor();
    const clock = new FakeClock('2026-01-01T00:00:00.000Z');
    const reasons: string[] = [];
    const service = new AccountService({ dataDir, redactor, clock, onLocked: (r) => reasons.push(r) });
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    service.lock('manual');
    expect(reasons).toEqual(['manual']);
  });

  it('idle lock fires after autoLockMinutes of inactivity, deferred while busy() is true', async () => {
    let busy = true;
    const clock = new FakeClock('2026-01-01T00:00:00.000Z');
    const redactor = new Redactor();
    const reasons: string[] = [];
    const service = new AccountService({ dataDir, redactor, clock, busy: () => busy, onLocked: (r) => reasons.push(r) });
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });

    clock.advance(15 * 60 * 1000 + 1000); // default autoLockMinutes = 15
    expect(service.status().unlocked).toBe(true); // deferred: busy() is true
    expect(reasons).toEqual([]);

    busy = false;
    service.onJobFinished();
    expect(service.status().unlocked).toBe(false);
    expect(reasons).toEqual(['idle']);
  });

  it('touch() resets the idle timer', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z');
    const redactor = new Redactor();
    const service = new AccountService({ dataDir, redactor, clock });
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });

    clock.advance(10 * 60 * 1000);
    service.touch();
    clock.advance(10 * 60 * 1000); // 20 min total, but touch() reset the clock at 10 min
    expect(service.status().unlocked).toBe(true);

    clock.advance(6 * 60 * 1000); // now 16 min since touch()
    expect(service.status().unlocked).toBe(false);
  });
});

describe('S12: AccountService — failed-attempt backoff', () => {
  it('locks out from the 5th failure with exponential backoff capped at 300s, and survives restart', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z');
    const { service } = makeService({ clock });
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    service.lock('manual');

    // Failures 1-4: no lockout yet.
    for (let i = 0; i < 4; i++) {
      await expect(service.unlock('wrong')).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
    }

    // 5th failure: locked out for 1s (2^0).
    await expect(service.unlock('wrong')).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS', details: { retryAfterSeconds: 1 } });
    // Still locked out immediately after (no time has passed).
    await expect(service.unlock(STRONG_PASSWORD)).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });

    clock.advance(1100);
    // 6th failure (backoff cleared, now failing again): should lock out for 2s (2^1).
    await expect(service.unlock('wrong')).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS', details: { retryAfterSeconds: 2 } });

    // Simulate a restart: a fresh AccountService instance reading the same dataDir/account.json.
    clock.advance(2100);
    const redactor2 = new Redactor();
    const restarted = new AccountService({ dataDir, redactor: redactor2, clock });
    // Counters persisted in account.json survive the restart; after 6 failures we're one away from a 7th.
    const status = await restarted.unlock(STRONG_PASSWORD);
    expect(status.unlocked).toBe(true);
  });

  it('caps backoff at 300 seconds', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z');
    const { service } = makeService({ clock });
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    service.lock('manual');

    // Drive failures well past the point where 2^(n-5) would exceed 300.
    for (let i = 0; i < 4; i++) {
      await expect(service.unlock('wrong')).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
    }
    let lastRetry = 0;
    for (let i = 0; i < 10; i++) {
      try {
        await service.unlock('wrong');
      } catch (err) {
        lastRetry = (err as AccountError).details?.retryAfterSeconds as number;
      }
      clock.advance((lastRetry + 1) * 1000);
    }
    expect(lastRetry).toBeLessThanOrEqual(300);
  });
});

describe('S12: AccountService.checkPassword', () => {
  it('rejects known-weak passwords and accepts the testbed strong password', async () => {
    const { service } = makeService();
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });

    expect(service.checkPassword('password123456').ok).toBe(false);
    expect(service.checkPassword('bobdeploy2026!').ok).toBe(false);
    expect(service.checkPassword('AliceAliceAliceAlice').ok).toBe(false);
    expect(service.checkPassword(STRONG_PASSWORD).ok).toBe(true);
  });
});

describe('AccountService.changePassword', () => {
  it('re-wraps the DEK under the new password without touching the vault', async () => {
    const { service } = makeService();
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    service.setSecret('bob.apiKey', 'my-api-key-value');

    const newPassword = 'a-different-Correct-Horse-99!';
    await service.changePassword({ currentPassword: STRONG_PASSWORD, newPassword });

    service.lock('manual');
    await expect(service.unlock(STRONG_PASSWORD)).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
    await service.unlock(newPassword);
    expect(service.getSecret('bob.apiKey')).toBe('my-api-key-value');
  });

  it('rejects BAD_PASSWORD when current password is wrong', async () => {
    const { service } = makeService();
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    await expect(service.changePassword({ currentPassword: 'wrong', newPassword: 'another-Strong-Passw0rd!' })).rejects.toMatchObject({
      code: 'BAD_PASSWORD',
    });
  });

  it('rejects WEAK_PASSWORD for the new password', async () => {
    const { service } = makeService();
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    await expect(service.changePassword({ currentPassword: STRONG_PASSWORD, newPassword: 'weak' })).rejects.toMatchObject({
      code: 'WEAK_PASSWORD',
    });
  });
});

describe('AccountService.recover', () => {
  it('unwraps the DEK with the recovery code, sets a new password, issues a new recovery code, and unlocks', async () => {
    const { service } = makeService();
    const { recoveryCode } = await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    service.setSecret('bob.apiKey', 'my-api-key-value');
    service.lock('manual');

    const newPassword = 'yet-Another-Strong-Passw0rd!';
    const result = await service.recover({ recoveryCode, newPassword });
    expect(result.recoveryCode).not.toBe(recoveryCode);
    expect(service.status().unlocked).toBe(true);
    expect(service.getSecret('bob.apiKey')).toBe('my-api-key-value');

    // The old recovery code is now invalid.
    service.lock('manual');
    await expect(service.recover({ recoveryCode, newPassword: 'irrelevant-Strong-Passw0rd!' })).rejects.toMatchObject({
      code: 'BAD_RECOVERY_CODE',
    });
    // The new password works.
    await service.unlock(newPassword);
  });

  it('rejects BAD_RECOVERY_CODE for a wrong code', async () => {
    const { service } = makeService();
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    await expect(service.recover({ recoveryCode: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', newPassword: 'Another-Strong-Passw0rd!' })).rejects.toMatchObject(
      { code: 'BAD_RECOVERY_CODE' },
    );
  });

  it('rejects WEAK_PASSWORD for the new password without consuming the recovery code', async () => {
    const { service } = makeService();
    const { recoveryCode } = await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    await expect(service.recover({ recoveryCode, newPassword: 'weak' })).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    // The recovery code must still work since the weak attempt didn't consume it.
    const result = await service.recover({ recoveryCode, newPassword: 'a-Fine-Strong-Passw0rd!' });
    expect(result.recoveryCode).toBeDefined();
  });
});

describe('S13: AccountService.regenerateRecoveryCode', () => {
  it('verifies the password and returns a fresh code that replaces the old one', async () => {
    const { service } = makeService();
    const { recoveryCode: oldCode } = await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    const { recoveryCode: newCode } = await service.regenerateRecoveryCode(STRONG_PASSWORD);
    expect(newCode).not.toBe(oldCode);

    service.lock('manual');
    await expect(service.recover({ recoveryCode: oldCode, newPassword: 'Another-Strong-Passw0rd!' })).rejects.toMatchObject({
      code: 'BAD_RECOVERY_CODE',
    });
    await service.recover({ recoveryCode: newCode, newPassword: 'Another-Strong-Passw0rd!' });
  });

  it('rejects BAD_PASSWORD for a wrong password', async () => {
    const { service } = makeService();
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    await expect(service.regenerateRecoveryCode('wrong')).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
  });
});

describe('AccountService.completeOnboarding', () => {
  it('flips onboardingComplete and persists it', async () => {
    const { service } = makeService();
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    expect(service.status().onboardingComplete).toBe(false);
    service.completeOnboarding();
    expect(service.status().onboardingComplete).toBe(true);
  });
});

describe('AccountService vault API', () => {
  it('setSecret registers the value with the Redactor', async () => {
    const { service, redactor } = makeService();
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    service.setSecret('bob.apiKey', 'plaintext-api-key-value');
    expect(redactor.redact('the key is plaintext-api-key-value')).toBe('the key is [hidden]');
  });

  it('listKeys filters by prefix, deleteSecret removes a key', async () => {
    const { service } = makeService();
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    service.setSecret('target.t1.sshPrivateKey', 'key-1');
    service.setSecret('target.t1.sshPassphrase', 'pass-1');
    service.setSecret('bob.apiKey', 'other');

    expect(service.listKeys('target.t1.').sort()).toEqual(['target.t1.sshPassphrase', 'target.t1.sshPrivateKey']);
    service.deleteSecret('bob.apiKey');
    expect(service.listKeys()).not.toContain('bob.apiKey');
  });

  it('vault survives a lock/unlock round trip', async () => {
    const { service } = makeService();
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    service.setSecret('bob.apiKey', 'my-value');
    service.lock('manual');
    await service.unlock(STRONG_PASSWORD);
    expect(service.getSecret('bob.apiKey')).toBe('my-value');
  });
});

describe('AccountService with a keyProtector outer layer', () => {
  it('a vault written while the protector is unavailable still opens later once it becomes available', async () => {
    const protector = makeFakeKeyProtector(false);
    const redactor = new Redactor();
    const clock = new FakeClock('2026-01-01T00:00:00.000Z');
    const service = new AccountService({ dataDir, redactor, clock, keyProtector: protector });
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    service.setSecret('bob.apiKey', 'value-a');
    service.lock('manual');

    protector.setAvailable(true);
    const redactor2 = new Redactor();
    const service2 = new AccountService({ dataDir, redactor: redactor2, clock, keyProtector: protector });
    await service2.unlock(STRONG_PASSWORD);
    expect(service2.getSecret('bob.apiKey')).toBe('value-a');
  });

  it('a vault written while the protector is available round-trips when read back with it available', async () => {
    const protector = makeFakeKeyProtector(true);
    const redactor = new Redactor();
    const clock = new FakeClock('2026-01-01T00:00:00.000Z');
    const service = new AccountService({ dataDir, redactor, clock, keyProtector: protector });
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    service.setSecret('bob.apiKey', 'value-b');
    service.lock('manual');

    const redactor2 = new Redactor();
    const service2 = new AccountService({ dataDir, redactor: redactor2, clock, keyProtector: protector });
    await service2.unlock(STRONG_PASSWORD);
    expect(service2.getSecret('bob.apiKey')).toBe('value-b');
  });
});

describe('AccountService — corrupted vault.bin', () => {
  it('falls back to vault.bin.bak and logs a warning', async () => {
    const { service, clock } = makeService();
    await service.create({ displayName: 'Alice', email: 'alice@example.com', masterPassword: STRONG_PASSWORD });
    service.setSecret('bob.apiKey', 'first-value');
    // A second write creates vault.bin.bak holding the "first-value" version.
    service.setSecret('bob.apiKey', 'second-value');
    service.lock('manual');

    // Corrupt the live vault.bin.
    writeFileSync(vaultFilePath(dataDir), Buffer.from([0x01, 0xff, 0xff, 0xff]));

    const warnings: string[] = [];
    const artifactsDir = mkdtempSync(join(tmpdir(), 'bd-account-logs-'));
    process.env.BD_ARTIFACTS_DIR = artifactsDir;
    try {
      const redactor2 = new Redactor();
      const { Logger } = await import('../logging/logger.js');
      const logger = new Logger(dataDir, redactor2, clock);
      const service2 = new AccountService({ dataDir, redactor: redactor2, clock, logger });
      await service2.unlock(STRONG_PASSWORD);
      expect(service2.getSecret('bob.apiKey')).toBe('first-value'); // recovered from .bak

      const logFiles = readdirSync(join(artifactsDir, 'logs'));
      expect(logFiles.length).toBeGreaterThan(0);
      const logText = readFileSync(join(artifactsDir, 'logs', logFiles[0]!), 'utf8');
      expect(logText).toContain('warn');
      warnings.push(logText);
    } finally {
      delete process.env.BD_ARTIFACTS_DIR;
      rmSync(artifactsDir, { recursive: true, force: true });
    }
    expect(warnings.length).toBe(1);
  });
});

describe('AccountService.status before an account exists', () => {
  it('reports exists: false', () => {
    const { service } = makeService();
    expect(service.status()).toEqual({ exists: false, unlocked: false, onboardingComplete: false, autoLockMinutes: 15 });
  });

  it('locked/vault operations throw NO_ACCOUNT or LOCKED before create/unlock', () => {
    const { service } = makeService();
    expect(() => service.getSecret('x')).toThrow(AccountError);
    expect(() => service.completeOnboarding()).toThrow(AccountError);
  });
});
