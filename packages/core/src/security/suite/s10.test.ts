/**
 * S10 — "Host tokens are in the vault and can be removed from the app."
 *
 * create-core.test.ts's "hosts" describe already exercises this through the full IPC path
 * (hosts:saveToken -> hosts:revokeToken) and asserts the *reported status* flips to disconnected.
 * This file asserts the stronger claim directly against AccountService's vault: the token is
 * genuinely stored under a vault key (not just recorded as "connected" somewhere else), and
 * deleteSecret genuinely removes it — getSecret returns undefined afterward, not just an app-level
 * "disconnected" flag while the value quietly lingers.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountService } from '../../account/account-service.js';
import { Redactor } from '../redactor.js';
import { SECRET_NETLIFY_TOKEN } from '../../account/secret-keys.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('S10: a host token lives in the vault and deleteSecret genuinely removes it', () => {
  it('setSecret stores it under a vault key; deleteSecret removes it; listKeys no longer reports it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'bd-s10-'));
    tempDirs.push(dataDir);
    const account = new AccountService({ dataDir, redactor: new Redactor() });
    await account.create({ displayName: 'Suite', email: 's10@example.com', masterPassword: 'correct-horse-battery-Staple-42' });

    account.setSecret(SECRET_NETLIFY_TOKEN, 'nfp_test_token');
    expect(account.getSecret(SECRET_NETLIFY_TOKEN)).toBe('nfp_test_token');
    expect(account.listKeys('host.')).toContain(SECRET_NETLIFY_TOKEN);

    account.deleteSecret(SECRET_NETLIFY_TOKEN);
    expect(account.getSecret(SECRET_NETLIFY_TOKEN)).toBeUndefined();
    expect(account.listKeys('host.')).not.toContain(SECRET_NETLIFY_TOKEN);

    // Surviving a lock/unlock cycle: the deletion is persisted to vault.bin, not just in-memory.
    account.lock();
    await account.unlock('correct-horse-battery-Staple-42');
    expect(account.getSecret(SECRET_NETLIFY_TOKEN)).toBeUndefined();
  });
});
