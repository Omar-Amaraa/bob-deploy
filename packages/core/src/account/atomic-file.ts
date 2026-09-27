import { openSync, writeSync, fsyncSync, closeSync, renameSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Writes `data` to `path` atomically: write to a sibling temp file, fsync it, rename over the
 * target (POSIX rename is atomic), then best-effort fsync the containing directory so the rename
 * itself survives a crash. Never leaves a partially-written `path` behind.
 */
export function writeFileAtomic(path: string, data: Buffer): void {
  const dir = dirname(path);
  const tmpPath = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmpPath, 'w', 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
  try {
    const dirFd = openSync(dir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Directory fsync isn't supported on every platform (e.g. Windows) — best effort only.
  }
}

/**
 * Writes `data` to `path` via writeFileAtomic, but first copies whatever currently exists at
 * `path` to `${path}.bak` (overwriting any previous backup). Used for vault.bin so a corrupted
 * write can fall back to the last known-good version.
 */
export function writeFileAtomicWithBackup(path: string, data: Buffer): void {
  if (existsSync(path)) {
    const current = readFileSync(path);
    writeFileAtomic(`${path}.bak`, current);
  }
  writeFileAtomic(path, data);
}

export function readFileIfExists(path: string): Buffer | undefined {
  return existsSync(path) ? readFileSync(path) : undefined;
}

export function removeIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}
