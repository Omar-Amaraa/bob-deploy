import { describe, it, expect } from 'vitest';
import ssh2 from 'ssh2';
import { buildSshKeyExport, generateAdminKey, SshKeyParseError } from './sshkey.js';

const TARGET = { appName: 'static-html', ip: '185.166.212.156', adminUser: 'omar', sshPort: 22 };

describe('buildSshKeyExport (DEC-022)', () => {
  it('hands out the stored key still encrypted, usable with the vault passphrase only', async () => {
    const key = await generateAdminKey('bob-deploy');
    const exported = buildSshKeyExport(TARGET, key.privateKeyOpenSsh, key.passphrase);

    expect(exported).toMatchObject({
      fileName: 'bob-deploy-static-html',
      adminUser: 'omar',
      host: '185.166.212.156',
      sshPort: 22,
    });
    expect(exported.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true);
    expect(exported.privateKey.endsWith('\n')).toBe(true);
    // Encrypted: unusable without the passphrase, usable with it.
    expect(ssh2.utils.parseKey(exported.privateKey)).toBeInstanceOf(Error);
    expect(ssh2.utils.parseKey(exported.privateKey, key.passphrase)).not.toBeInstanceOf(Error);
  });

  it('builds a safe file name from the IP when there is no app name, and defaults the port to 22', async () => {
    const key = await generateAdminKey('bob-deploy');
    const exported = buildSshKeyExport({ ip: '203.0.113.9' }, key.privateKeyOpenSsh, key.passphrase);
    expect(exported.fileName).toBe('bob-deploy-203-0-113-9');
    expect(exported.sshPort).toBe(22);
  });

  it('refuses a key that does not parse with the stored passphrase', async () => {
    const key = await generateAdminKey('bob-deploy');
    expect(() => buildSshKeyExport(TARGET, key.privateKeyOpenSsh, 'not-the-passphrase')).toThrow(
      SshKeyParseError,
    );
  });
});
