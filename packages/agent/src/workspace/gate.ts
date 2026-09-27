import { stat, unlink, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import type { DiffResult, GateResult, GateRules, StagingWorkspace } from './types.js';

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_MAX_CHANGED_FILES = 200;
const DEFAULT_MAX_DELETED_FILES = 20;

const IMAGE_FONT_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
]);

function pathSegments(relPath: string): string[] {
  return relPath.split('/');
}

/** Structural checks that don't need to touch the filesystem: traversal, forbidden dirs/names. */
function checkPathItself(relPath: string): string | undefined {
  if (relPath.startsWith('/') || relPath.includes('\0')) return 'path-traversal';
  const segments = pathSegments(relPath);
  if (segments.some((s) => s === '..' || s === '.')) return 'path-traversal';
  if (segments[0] === '.bob' || segments[0] === '.git') return 'forbidden-path';
  const name = basename(relPath);
  if (name === '.env' || name.startsWith('.env.') || name.startsWith('.env-')) return 'forbidden-path';
  if (name.endsWith('.pem')) return 'forbidden-path';
  if (name.startsWith('id_')) return 'forbidden-path';
  return undefined;
}

async function isBinary(path: string): Promise<boolean> {
  const buf = await readFile(path);
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  return sample.includes(0);
}

function hasDisallowedBinaryExtension(relPath: string): boolean {
  const name = basename(relPath).toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot);
  return !IMAGE_FONT_EXTENSIONS.has(ext);
}

async function revertAdded(staging: StagingWorkspace, relPath: string): Promise<void> {
  await unlink(join(staging.dir, ...pathSegments(relPath))).catch(() => undefined);
}

async function revertFromProject(projectDir: string, staging: StagingWorkspace, relPath: string): Promise<void> {
  const dest = join(staging.dir, ...pathSegments(relPath));
  const src = join(projectDir, ...pathSegments(relPath));
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest).catch(() => undefined);
}

/**
 * Validates a diff against the fixed set of rules every accepted change must pass, reverting
 * anything rejected back to `projectDir`'s state in `staging` (an added file is deleted; a
 * modified or deleted file is restored from the original project, which the agent never touches
 * directly). `projectDir` is the untouched source of truth staging was created from.
 */
export async function applyGate(
  staging: StagingWorkspace,
  projectDir: string,
  diff: DiffResult,
  rules: GateRules = {},
): Promise<GateResult> {
  const maxFileBytes = rules.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxChangedFiles = rules.maxChangedFiles ?? DEFAULT_MAX_CHANGED_FILES;
  const maxDeletedFiles = rules.maxDeletedFiles ?? DEFAULT_MAX_DELETED_FILES;

  const rejected: GateResult['rejected'] = [];
  const acceptedAdded = new Set(diff.added);
  const acceptedModified = new Set(diff.modified);
  const acceptedDeleted = new Set(diff.deleted);

  const totalChanged = diff.added.length + diff.modified.length + diff.deleted.length;
  const bulkRejectAll = totalChanged > maxChangedFiles;
  const bulkRejectDeletes = diff.deleted.length > maxDeletedFiles;

  async function reject(relPath: string, reason: string, kind: 'added' | 'modified' | 'deleted'): Promise<void> {
    rejected.push({ path: relPath, reason });
    if (kind === 'added') {
      acceptedAdded.delete(relPath);
      await revertAdded(staging, relPath);
    } else {
      (kind === 'modified' ? acceptedModified : acceptedDeleted).delete(relPath);
      await revertFromProject(projectDir, staging, relPath);
    }
  }

  if (bulkRejectAll) {
    for (const p of diff.added) await reject(p, 'too-many-changed-files', 'added');
    for (const p of diff.modified) await reject(p, 'too-many-changed-files', 'modified');
    for (const p of diff.deleted) await reject(p, 'too-many-changed-files', 'deleted');
    return { accepted: { added: [], modified: [], deleted: [] }, rejected };
  }

  if (bulkRejectDeletes) {
    for (const p of diff.deleted) await reject(p, 'too-many-deleted-files', 'deleted');
  }

  for (const relPath of diff.added) {
    if (!acceptedAdded.has(relPath)) continue;
    const structural = checkPathItself(relPath);
    if (structural) {
      await reject(relPath, structural, 'added');
      continue;
    }
    const filePath = join(staging.dir, ...pathSegments(relPath));
    const st = await stat(filePath).catch(() => undefined);
    if (!st) continue; // already gone somehow; nothing to gate
    if (st.size > maxFileBytes) {
      await reject(relPath, 'too-large', 'added');
      continue;
    }
    if ((await isBinary(filePath)) && hasDisallowedBinaryExtension(relPath)) {
      await reject(relPath, 'disallowed-binary', 'added');
    }
  }

  for (const relPath of diff.modified) {
    if (!acceptedModified.has(relPath)) continue;
    const structural = checkPathItself(relPath);
    if (structural) {
      await reject(relPath, structural, 'modified');
      continue;
    }
    const filePath = join(staging.dir, ...pathSegments(relPath));
    const st = await stat(filePath).catch(() => undefined);
    if (!st) continue;
    if (st.size > maxFileBytes) {
      await reject(relPath, 'too-large', 'modified');
      continue;
    }
    if ((await isBinary(filePath)) && hasDisallowedBinaryExtension(relPath)) {
      await reject(relPath, 'disallowed-binary', 'modified');
    }
  }

  for (const relPath of diff.deleted) {
    if (!acceptedDeleted.has(relPath)) continue;
    const structural = checkPathItself(relPath);
    if (structural) {
      await reject(relPath, structural, 'deleted');
    }
  }

  return {
    accepted: {
      added: [...acceptedAdded].sort(),
      modified: [...acceptedModified].sort(),
      deleted: [...acceptedDeleted].sort(),
    },
    rejected,
  };
}

// Re-exported so callers (and tests) that only need to clean up an abandoned staging dir don't
// need to reach into node:fs/promises themselves.
export async function removeStaging(staging: StagingWorkspace): Promise<void> {
  await rm(join(staging.dir, '..'), { recursive: true, force: true });
}
