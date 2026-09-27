import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { generatePassphrase } from './passphrase.js';

const { utils: ssh2Utils } = ssh2;

export interface GeneratedAdminKey {
  privateKeyOpenSsh: string;
  publicKeyOpenSsh: string;
  passphrase: string;
  fingerprintSha256: string;
}

/** Thrown when a private key blob can't be parsed with the given passphrase (wrong passphrase or corrupt key). */
export class SshKeyParseError extends Error {
  constructor(message = 'Failed to parse SSH private key: wrong passphrase or corrupted key.') {
    super(message);
    this.name = 'SshKeyParseError';
  }
}

/** SHA256 fingerprint in the standard OpenSSH display format ("SHA256:<base64, no padding>"). */
function fingerprintFromPublicSsh(publicSshBlob: Buffer): string {
  const digest = createHash('sha256').update(publicSshBlob).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

/**
 * Generates a new ed25519 admin key pair, encrypted with a freshly generated passphrase
 * (7-word passphrase, DEC-002). Verified directly: ssh2's `utils.generateKeyPairSync('ed25519', ...)`
 * supports { comment, passphrase, cipher, rounds } in the installed version, so no sshpk fallback
 * is required here.
 */
// Note: key generation itself is synchronous (ssh2's generateKeyPairSync); this stays
// Promise-returning (rather than `async`, which would need a no-op `await`) because it's a
// CPU-bound operation the caller may want to keep off a hot path, and to match the brief's
// declared `Promise<...>` signature.
export function generateAdminKey(comment: string): Promise<GeneratedAdminKey> {
  const passphrase = generatePassphrase(7);
  const { private: privateKeyOpenSsh, public: publicKeyOpenSsh } = ssh2Utils.generateKeyPairSync('ed25519', {
    comment,
    passphrase,
    cipher: 'aes256-ctr',
    rounds: 16,
  });

  const parsed = ssh2Utils.parseKey(privateKeyOpenSsh, passphrase);
  if (parsed instanceof Error) {
    throw new SshKeyParseError(`Just-generated key failed to parse: ${parsed.message}`);
  }
  const publicSshBlob = parsed.getPublicSSH();
  const fingerprintSha256 = fingerprintFromPublicSsh(publicSshBlob);

  return Promise.resolve({ privateKeyOpenSsh, publicKeyOpenSsh, passphrase, fingerprintSha256 });
}

/** Parses an OpenSSH-format private key with the given passphrase. Throws SshKeyParseError on failure. */
export function parseAdminKey(privateKeyOpenSsh: string, passphrase: string): { fingerprintSha256: string } {
  const parsed = ssh2Utils.parseKey(privateKeyOpenSsh, passphrase);
  if (parsed instanceof Error) {
    throw new SshKeyParseError();
  }
  return { fingerprintSha256: fingerprintFromPublicSsh(parsed.getPublicSSH()) };
}

/** Re-derives the OpenSSH public-key line and fingerprint from a stored private key + passphrase —
 * only the private key and passphrase are kept in the vault (storeTargetKey), not the public key
 * text, so security:targetInfo needs to rebuild it on demand. Throws SshKeyParseError on failure. */
export function derivePublicKey(
  privateKeyOpenSsh: string,
  passphrase: string,
): { publicKeyOpenSsh: string; fingerprintSha256: string } {
  const parsed = ssh2Utils.parseKey(privateKeyOpenSsh, passphrase);
  if (parsed instanceof Error) {
    throw new SshKeyParseError();
  }
  const blob = parsed.getPublicSSH();
  return {
    publicKeyOpenSsh: `${parsed.type} ${blob.toString('base64')}`,
    fingerprintSha256: fingerprintFromPublicSsh(blob),
  };
}

export interface SshKeyExport {
  privateKey: string;
  fileName: string;
  adminUser: string;
  host: string;
  sshPort: number;
}

/** Packages a stored admin key for `security:exportSshKey` (DEC-022). The private key is handed out
 * exactly as stored: OpenSSH format, still encrypted with the vault passphrase, so the file alone is
 * not enough to log in. It is parsed first so a corrupt vault entry fails here, not in the user's
 * ssh client, and gets the trailing newline OpenSSH requires. Throws SshKeyParseError. */
export function buildSshKeyExport(
  target: { appName?: string; ip?: string; adminUser?: string; sshPort?: number },
  privateKeyOpenSsh: string,
  passphrase: string,
): SshKeyExport {
  parseAdminKey(privateKeyOpenSsh, passphrase);
  const label =
    (target.appName ?? target.ip ?? 'server')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'server';
  return {
    privateKey: privateKeyOpenSsh.endsWith('\n') ? privateKeyOpenSsh : `${privateKeyOpenSsh}\n`,
    fileName: `bob-deploy-${label}`,
    adminUser: target.adminUser ?? '',
    host: target.ip ?? '',
    sshPort: target.sshPort ?? 22,
  };
}

/** Minimal shape of the vault API this needs — avoids a circular import with account/. */
export interface KeyVault {
  setSecret(key: string, value: string): void;
}

/** Stores a generated admin key's private key and passphrase into the vault under `targetId`. */
export function storeTargetKey(
  vault: KeyVault,
  targetId: string,
  key: Pick<GeneratedAdminKey, 'privateKeyOpenSsh' | 'passphrase'>,
): void {
  vault.setSecret(`target.${targetId}.sshPrivateKey`, key.privateKeyOpenSsh);
  vault.setSecret(`target.${targetId}.sshPassphrase`, key.passphrase);
}
