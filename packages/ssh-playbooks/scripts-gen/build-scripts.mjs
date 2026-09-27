#!/usr/bin/env node
// build-scripts.mjs
// Generates packages/ssh-playbooks/src/generated/scripts.ts from the fixed shell scripts under
// packages/ssh-playbooks/scripts/. Each numbered bootstrap script and each helper script has
// lib.sh's body inlined in place of its `# @@LIB@@` marker line, so the TypeScript side can upload
// a single self-contained file per script with no runtime `source` dependency. This keeps the
// scripts themselves (fixed code per CLAUDE.md) as the single source of truth; nothing here
// generates or edits the *.sh files, only bundles them.
//
// Usage:
//   node scripts-gen/build-scripts.mjs        # regenerate src/generated/scripts.ts
//
// A test (src/generated/scripts.freshness.test.ts) imports `buildGeneratedSource` from this same
// module and asserts it matches the committed file byte-for-byte, so a change to any script that
// isn't followed by re-running this generator fails CI rather than silently drifting.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = join(__dirname, '..');
export const SCRIPTS_DIR = join(PKG_ROOT, 'scripts');
export const HELPERS_DIR = join(SCRIPTS_DIR, 'helpers');
export const OUT_FILE = join(PKG_ROOT, 'src', 'generated', 'scripts.ts');

const LIB_MARKER = '# @@LIB@@\n';

// Explicit, ordered lists (rather than just globbing scripts/) so the generator fails loudly if a
// script is added or removed without also updating this file — see the consistency check below.
export const NUMBERED_SCRIPTS = [
  '00-preflight.sh',
  '10-create-admin.sh',
  '20-sshd-harden.sh',
  '21-sshd-restore.sh',
  '30-firewall.sh',
  '40-install-helpers.sh',
];

export const HELPER_SCRIPT_NAMES = [
  'bd-install-runtime',
  'bd-install-packages',
  'bd-install-apt-packages',
  'bd-install-caddy',
  'bd-app-setup',
  'bd-caddy-site',
  'bd-service',
  'bd-read-log',
  'bd-read-journal',
  'bd-security-upgrade',
  'bd-clean-disk',
  'bd-reboot',
];

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Exported so tests (e.g. the failure-injection suite) can inline lib.sh into a one-off script
 * variant that lives outside scripts/ (and is therefore never part of the generated bundle) the
 * same way this generator does for the real scripts. */
export function readLibBody() {
  const raw = readFileSync(join(SCRIPTS_DIR, 'lib.sh'), 'utf8');
  const lines = raw.split('\n');
  if (lines[0]?.startsWith('#!')) lines.shift();
  return lines.join('\n');
}

export function inlineLib(content, libBody, sourcePath) {
  if (!content.includes(LIB_MARKER)) {
    throw new Error(`${sourcePath} is missing the "${LIB_MARKER.trim()}" marker line`);
  }
  return content.split(LIB_MARKER).join(libBody);
}

function assertInSync(label, actual, expected) {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (JSON.stringify(a) !== JSON.stringify(e)) {
    throw new Error(
      `${label} is out of sync: found [${a.join(', ')}] on disk, but the generator lists [${e.join(', ')}]. ` +
        'Update NUMBERED_SCRIPTS / HELPER_SCRIPT_NAMES in scripts-gen/build-scripts.mjs.',
    );
  }
}

function emitEntries(entries) {
  return entries
    .map(
      (e) =>
        `  {\n    name: ${JSON.stringify(e.name)},\n    sha256: ${JSON.stringify(e.sha256)},\n    content: ${JSON.stringify(e.content)},\n  },`,
    )
    .join('\n');
}

/**
 * Pure function: reads scripts/ from disk and returns the full TypeScript source that should be
 * written to src/generated/scripts.ts. Exported so both this file's CLI entry point and the
 * freshness test use exactly the same generation logic.
 */
export function buildGeneratedSource() {
  const libBody = readLibBody();

  const actualNumbered = readdirSync(SCRIPTS_DIR).filter((f) => /^\d\d-[a-z-]+\.sh$/.test(f));
  assertInSync('scripts/*.sh', actualNumbered, NUMBERED_SCRIPTS);

  const actualHelpers = readdirSync(HELPERS_DIR).filter((f) => f.startsWith('bd-'));
  assertInSync('scripts/helpers/bd-*', actualHelpers, HELPER_SCRIPT_NAMES);

  const bootstrapEntries = NUMBERED_SCRIPTS.map((name) => {
    const path = join(SCRIPTS_DIR, name);
    const content = inlineLib(readFileSync(path, 'utf8'), libBody, path);
    return { name, content, sha256: sha256(content) };
  });

  const helperEntries = HELPER_SCRIPT_NAMES.map((name) => {
    const path = join(HELPERS_DIR, name);
    const content = inlineLib(readFileSync(path, 'utf8'), libBody, path);
    return { name, content, sha256: sha256(content) };
  });

  const allowlistRaw = readFileSync(join(HELPERS_DIR, 'allowlist.txt'), 'utf8');
  const allowlistEntry = {
    name: 'allowlist.txt',
    content: allowlistRaw,
    sha256: sha256(allowlistRaw),
  };

  return `// GENERATED FILE — do not edit by hand.
// Produced by packages/ssh-playbooks/scripts-gen/build-scripts.mjs from packages/ssh-playbooks/scripts/.
// After changing any *.sh script, run \`node scripts-gen/build-scripts.mjs\` from this package's
// root and commit the result. src/generated/scripts.freshness.test.ts fails if this drifts.

export interface GeneratedScript {
  readonly name: string;
  readonly sha256: string;
  readonly content: string;
}

export const BOOTSTRAP_SCRIPTS: readonly GeneratedScript[] = [
${emitEntries(bootstrapEntries)}
];

export const HELPER_SCRIPTS: readonly GeneratedScript[] = [
${emitEntries(helperEntries)}
];

export const HELPERS_ALLOWLIST: GeneratedScript = {
  name: ${JSON.stringify(allowlistEntry.name)},
  sha256: ${JSON.stringify(allowlistEntry.sha256)},
  content: ${JSON.stringify(allowlistEntry.content)},
};
`;
}

function isMainModule() {
  return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) {
  const source = buildGeneratedSource();
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, source);
  console.log(`Wrote ${OUT_FILE}`);
}
