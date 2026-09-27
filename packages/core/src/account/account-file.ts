import { join } from 'node:path';
import type { KdfParams } from '../security/crypto.js';
import { readFileIfExists, writeFileAtomic } from './atomic-file.js';

/** A DEK sealed under a key derived from some secret (master password or recovery code). */
export interface WrapJson {
  salt: string; // base64
  iv: string; // base64
  ct: string; // base64
  tag: string; // base64
  kdf: KdfParams; // stored with each wrapping so params can be raised later without breaking old vaults
}

export interface AccountFileJson {
  version: 1;
  displayName: string;
  email: string;
  createdAt: string;
  autoLockMinutes: number;
  kdf: KdfParams;
  passwordWrap: WrapJson;
  recoveryWrap: WrapJson;
  failedAttempts: number;
  lockedUntil?: string;
  onboardingComplete: boolean;
}

export function accountFilePath(dataDir: string): string {
  return join(dataDir, 'account.json');
}

export function accountFileExists(dataDir: string): boolean {
  return readFileIfExists(accountFilePath(dataDir)) !== undefined;
}

export function loadAccountFile(dataDir: string): AccountFileJson | undefined {
  const raw = readFileIfExists(accountFilePath(dataDir));
  if (!raw) return undefined;
  return JSON.parse(raw.toString('utf8')) as AccountFileJson;
}

export function saveAccountFile(dataDir: string, account: AccountFileJson): void {
  writeFileAtomic(accountFilePath(dataDir), Buffer.from(JSON.stringify(account, null, 2), 'utf8'));
}
