import { join } from 'node:path';
import type { KeyProtector } from '@bob-deploy/contracts';
import { open, seal, type Sealed } from '../security/crypto.js';
import { readFileIfExists, writeFileAtomicWithBackup } from './atomic-file.js';

export const VAULT_AAD = 'bd-vault-v1';

/** Header byte: which layer(s) wrap the sealed vault JSON. */
const HEADER_PLAIN = 0x01; // sealed JSON only (DEK layer)
const HEADER_PROTECTED = 0x02; // keyProtector(sealed JSON) (DEK layer + OS keychain outer layer)

export type SecretMap = Record<string, string>;

interface SealedJson {
  iv: string;
  ct: string;
  tag: string;
}

function sealedToJson(sealed: Sealed): SealedJson {
  return { iv: sealed.iv.toString('base64'), ct: sealed.ct.toString('base64'), tag: sealed.tag.toString('base64') };
}

function sealedFromJson(json: SealedJson): Sealed {
  return { iv: Buffer.from(json.iv, 'base64'), ct: Buffer.from(json.ct, 'base64'), tag: Buffer.from(json.tag, 'base64') };
}

export function vaultFilePath(dataDir: string): string {
  return join(dataDir, 'vault.bin');
}

function vaultBakPath(dataDir: string): string {
  return `${vaultFilePath(dataDir)}.bak`;
}

/** Serialises and writes `secrets` sealed under `dek`, optionally with an outer keyProtector layer. */
export function saveVaultFile(dataDir: string, dek: Buffer, secrets: SecretMap, keyProtector?: KeyProtector): void {
  const plaintext = Buffer.from(JSON.stringify(secrets), 'utf8');
  const sealed = seal(dek, plaintext, VAULT_AAD);
  const sealedBuf = Buffer.from(JSON.stringify(sealedToJson(sealed)), 'utf8');

  let body: Buffer;
  let header: number;
  if (keyProtector?.isAvailable()) {
    header = HEADER_PROTECTED;
    body = keyProtector.encryptString(sealedBuf.toString('base64'));
  } else {
    header = HEADER_PLAIN;
    body = sealedBuf;
  }

  const out = Buffer.concat([Buffer.from([header]), body]);
  writeFileAtomicWithBackup(vaultFilePath(dataDir), out);
}

export class VaultCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultCorruptError';
  }
}

/** Parses a raw vault.bin buffer (header byte + body) into its sealed-JSON form, honouring the
 * header regardless of the keyProtector's current availability — the header, not runtime state,
 * decides which layer(s) to peel off, so a file's readability never depends on isAvailable() having
 * stayed the same since it was written. */
function unwrapVaultBuffer(raw: Buffer, keyProtector?: KeyProtector): SealedJson {
  if (raw.length < 1) throw new VaultCorruptError('vault file is empty');
  const header = raw[0];
  const body = raw.subarray(1);
  if (header === HEADER_PLAIN) {
    return JSON.parse(body.toString('utf8')) as SealedJson;
  }
  if (header === HEADER_PROTECTED) {
    if (!keyProtector) {
      throw new VaultCorruptError('vault was sealed with an OS keychain layer, but none is available');
    }
    const decrypted = keyProtector.decryptString(Buffer.from(body));
    return JSON.parse(Buffer.from(decrypted, 'base64').toString('utf8')) as SealedJson;
  }
  throw new VaultCorruptError(`unknown vault header byte: ${header}`);
}

export interface LoadVaultResult {
  secrets: SecretMap;
  /** Set when the primary vault.bin was unreadable and the .bak copy was used instead. */
  usedBackup: boolean;
}

/**
 * Loads and decrypts the vault. Tries vault.bin first; if it's missing, corrupt, or fails to parse
 * or decrypt, falls back to vault.bin.bak (if present) and reports that via `usedBackup` so the
 * caller can log a warning. Returns an empty vault only when neither file exists.
 */
export function loadVaultFile(dataDir: string, dek: Buffer, keyProtector?: KeyProtector): LoadVaultResult {
  const primary = readFileIfExists(vaultFilePath(dataDir));
  if (primary) {
    try {
      const sealed = sealedFromJson(unwrapVaultBuffer(primary, keyProtector));
      const plaintext = open(dek, sealed, VAULT_AAD);
      return { secrets: JSON.parse(plaintext.toString('utf8')) as SecretMap, usedBackup: false };
    } catch {
      // fall through to backup below
    }
  }

  const backup = readFileIfExists(vaultBakPath(dataDir));
  if (backup) {
    const sealed = sealedFromJson(unwrapVaultBuffer(backup, keyProtector));
    const plaintext = open(dek, sealed, VAULT_AAD);
    return { secrets: JSON.parse(plaintext.toString('utf8')) as SecretMap, usedBackup: true };
  }

  if (primary) {
    // Primary existed but was unreadable, and there's no backup to fall back to.
    throw new VaultCorruptError('vault.bin is corrupt and no vault.bin.bak backup exists');
  }

  return { secrets: {}, usedBackup: false };
}
