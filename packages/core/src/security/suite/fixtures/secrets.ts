/**
 * Shared helpers for the S1-S15 security suite (A11). Loads the fixed fake secrets from
 * testbed/test-secrets.json (the same file CI's own log/DB scan is documented to use — see
 * testbed/README.md and docs/security/README.md's "CI secret scan" section) and gives the suite a
 * single place to build "does this text/tree/db contain any of these secrets" checks, in the same
 * literal + encoded-forms shape the real Redactor (packages/core/src/security/redactor.ts) uses.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export interface TestSecrets {
  rootPassword: string;
  masterPassword: string;
  bobApiKey: string;
  netlifyToken: string;
  vercelToken: string;
  sshPassphrase: string;
}

/** Repo-root testbed/test-secrets.json, resolved relative to this file (mirrors testbed.ts's own
 * `fileURLToPath(new URL('../../../testbed/...', import.meta.url))` convention). This file lives
 * at packages/core/src/security/suite/fixtures/, four levels under packages/core/src, so the
 * relative walk back to the repo root is one level deeper than testbed.ts's. */
const TEST_SECRETS_PATH = fileURLToPath(new URL('../../../../../../testbed/test-secrets.json', import.meta.url));

let cached: TestSecrets | undefined;

export function loadTestSecrets(): TestSecrets {
  if (!cached) {
    cached = JSON.parse(readFileSync(TEST_SECRETS_PATH, 'utf8')) as TestSecrets;
  }
  return cached;
}

/** Every fixed test secret as a flat array, for "must never appear anywhere" scans. */
export function allTestSecretValues(): string[] {
  const s = loadTestSecrets();
  return [s.rootPassword, s.masterPassword, s.bobApiKey, s.netlifyToken, s.vercelToken, s.sshPassphrase];
}

function base64Of(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}
function base64UrlOf(s: string): string {
  return base64Of(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** A secret plus the encoded forms the Redactor also registers for it (see Redactor.add) — the
 * CI scan must miss none of these, since a leak in any encoded form is still a leak. */
export function secretAndEncodedForms(secret: string): string[] {
  const forms = new Set<string>([secret]);
  if (secret.length >= 6) {
    forms.add(base64Of(secret));
    forms.add(base64UrlOf(secret));
    forms.add(encodeURIComponent(secret));
    forms.add(JSON.stringify(secret).slice(1, -1));
  }
  return [...forms];
}

/** Returns every (secret, form) pair found verbatim inside `text`. Empty array = clean. */
export function findSecretsInText(text: string, secrets: string[] = allTestSecretValues()): string[] {
  const hits: string[] = [];
  for (const secret of secrets) {
    for (const form of secretAndEncodedForms(secret)) {
      if (form.length > 0 && text.includes(form)) hits.push(form);
    }
  }
  return hits;
}

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.pnpm-store']);
/** Files whose entire purpose is to hold a secret sealed at rest — a byte-for-byte scan of these
 * would find nothing (they're binary/ciphertext), so callers that mean to assert "no plaintext
 * copy exists outside the vault" should scan everything else and verify these files separately
 * (open them with the wrong key / assert they don't parse as JSON containing the raw value). */
export const VAULT_FILE_NAMES = new Set(['vault.bin', 'vault.bin.bak']);

export interface ScannedFile {
  path: string;
  hits: string[];
}

/** Recursively scans every regular file under `dir` (skipping vault files by default) for any of
 * `secrets` in raw or encoded form. Used against artifacts/, a job's dataDir, and log output. */
export function scanDirForSecrets(
  dir: string,
  secrets: string[] = allTestSecretValues(),
  opts: { skipVaultFiles?: boolean } = { skipVaultFiles: true },
): ScannedFile[] {
  const found: ScannedFile[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      found.push(...scanDirForSecrets(full, secrets, opts));
      continue;
    }
    if (opts.skipVaultFiles !== false && VAULT_FILE_NAMES.has(entry)) continue;
    let text: string;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue; // binary/unreadable-as-utf8 file; not a plaintext leak vector for these checks
    }
    const hits = findSecretsInText(text, secrets);
    if (hits.length > 0) found.push({ path: full, hits });
  }
  return found;
}
