/**
 * S2 (revised) — "SSH private key is OpenSSH ed25519 encrypted with the generated passphrase. Both
 * key and passphrase are stored only inside the vault (AES-256-GCM, DEK wrapped by
 * Argon2id(master password)). Never in plaintext on disk."
 *
 * Drives a real AccountService (account.json + vault.bin on a real temp dataDir, real Argon2id —
 * same as account-service.test.ts) through create -> generate an admin key -> store it -> lock,
 * then scans every byte on disk (account.json, vault.bin, vault.bin.bak included) for the
 * plaintext private key PEM/OpenSSH body and passphrase. Also proves the inverse: the wrong
 * passphrase fails to parse the freshly generated key.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountService } from '../../account/account-service.js';
import { Redactor } from '../redactor.js';
import { generateAdminKey, parseAdminKey, storeTargetKey, SshKeyParseError } from '../sshkey.js';
import { sshPrivateKeySecretKey, sshPassphraseSecretKey } from '../../account/secret-keys.js';
import { scanDirForSecrets } from './fixtures/secrets.js';

const tempDirs: string[] = [];
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bd-s2-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('S2: the generated SSH private key and passphrase never touch disk outside vault.bin', () => {
  it('a full create -> generate key -> store -> lock cycle leaves no plaintext copy anywhere in dataDir', async () => {
    const dataDir = await makeTempDir();
    const redactor = new Redactor();
    const account = new AccountService({ dataDir, redactor });

    await account.create({ displayName: 'Suite', email: 'suite@example.com', masterPassword: 'correct-horse-battery-Staple-42' });

    const key = await generateAdminKey('bd-s2-suite-key');
    expect(key.privateKeyOpenSsh).toContain('PRIVATE KEY');
    expect(key.passphrase.split('-').length).toBeGreaterThanOrEqual(5); // multi-word generated passphrase

    storeTargetKey(account, 'target-1', key);

    // Sanity: the vault really does hold it (proves the scan below isn't vacuous).
    expect(account.getSecret(sshPrivateKeySecretKey('target-1'))).toBe(key.privateKeyOpenSsh);
    expect(account.getSecret(sshPassphraseSecretKey('target-1'))).toBe(key.passphrase);

    account.lock();

    // account.json + vault.bin (+ vault.bin.bak, if a prior write left one) now exist on disk.
    const filesPresent = await readdir(dataDir);
    expect(filesPresent).toContain('account.json');
    expect(filesPresent).toContain('vault.bin');

    const hits = scanDirForSecrets(dataDir, [key.privateKeyOpenSsh, key.passphrase], { skipVaultFiles: false });
    expect(hits).toEqual([]);
    // The private key's PEM/OpenSSH marker line by itself must not appear either — guards against
    // a scan that only matched the full literal by coincidence.
    const markerHits = scanDirForSecrets(dataDir, ['-----BEGIN OPENSSH PRIVATE KEY-----'], { skipVaultFiles: false });
    expect(markerHits).toEqual([]);
  });

  it('parseAdminKey throws SshKeyParseError for a wrong passphrase and succeeds for the right one', async () => {
    const key = await generateAdminKey('bd-s2-wrong-passphrase');
    expect(() => parseAdminKey(key.privateKeyOpenSsh, 'definitely-the-wrong-passphrase')).toThrow(SshKeyParseError);
    expect(parseAdminKey(key.privateKeyOpenSsh, key.passphrase).fingerprintSha256).toBe(key.fingerprintSha256);
  });

  it('vault.bin.bak (if present) also never carries the plaintext key or passphrase', async () => {
    const dataDir = await makeTempDir();
    const redactor = new Redactor();
    const account = new AccountService({ dataDir, redactor });
    await account.create({ displayName: 'Suite', email: 'suite2@example.com', masterPassword: 'correct-horse-battery-Staple-42' });

    const key = await generateAdminKey('bd-s2-backup-check');
    storeTargetKey(account, 'target-1', key);
    // A second vault write (any setSecret call) triggers writeFileAtomicWithBackup to snapshot the
    // previous vault.bin into vault.bin.bak before overwriting.
    account.setSecret('another.key', 'another-value');

    const filesPresent = await readdir(dataDir);
    expect(filesPresent).toContain('vault.bin.bak');

    const hits = scanDirForSecrets(dataDir, [key.privateKeyOpenSsh, key.passphrase], { skipVaultFiles: false });
    expect(hits).toEqual([]);
  });
});
