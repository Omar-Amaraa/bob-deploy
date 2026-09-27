import { describe, it, expect } from 'vitest';
import { utils as ssh2Utils } from 'ssh2';
import { generateAdminKey, parseAdminKey, storeTargetKey, SshKeyParseError, type KeyVault } from './sshkey.js';

describe('generateAdminKey', () => {
  it('generates an ed25519 key that parses with the returned passphrase', async () => {
    const key = await generateAdminKey('bob-deploy admin key');
    expect(key.privateKeyOpenSsh).toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(key.publicKeyOpenSsh.startsWith('ssh-ed25519 ')).toBe(true);
    expect(key.fingerprintSha256).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(key.passphrase.split('-')).toHaveLength(7);

    const parsed = ssh2Utils.parseKey(key.privateKeyOpenSsh, key.passphrase);
    expect(parsed).not.toBeInstanceOf(Error);
  });

  it('fails to parse the generated key with a wrong passphrase', async () => {
    const key = await generateAdminKey('bob-deploy admin key');
    const parsed = ssh2Utils.parseKey(key.privateKeyOpenSsh, 'definitely-the-wrong-passphrase');
    expect(parsed).toBeInstanceOf(Error);
  });

  it('produces a different key (and fingerprint) each time', async () => {
    const a = await generateAdminKey('a');
    const b = await generateAdminKey('b');
    expect(a.fingerprintSha256).not.toBe(b.fingerprintSha256);
  });
});

describe('parseAdminKey', () => {
  it('returns the fingerprint on success', async () => {
    const key = await generateAdminKey('target-1');
    const result = parseAdminKey(key.privateKeyOpenSsh, key.passphrase);
    expect(result.fingerprintSha256).toBe(key.fingerprintSha256);
  });

  it('throws SshKeyParseError on a wrong passphrase', async () => {
    const key = await generateAdminKey('target-1');
    expect(() => parseAdminKey(key.privateKeyOpenSsh, 'wrong')).toThrow(SshKeyParseError);
  });
});

describe('storeTargetKey', () => {
  it('writes sshPrivateKey and sshPassphrase into the vault under the target id', async () => {
    const key = await generateAdminKey('target-abc');
    const stored: Record<string, string> = {};
    const fakeVault: KeyVault = { setSecret: (k, v) => { stored[k] = v; } };

    storeTargetKey(fakeVault, 'target-abc', key);

    expect(stored['target.target-abc.sshPrivateKey']).toBe(key.privateKeyOpenSsh);
    expect(stored['target.target-abc.sshPassphrase']).toBe(key.passphrase);
  });
});
