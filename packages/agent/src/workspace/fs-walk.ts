import { readdir, stat, readlink } from 'node:fs/promises';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import type { SkippedEntry } from './types.js';

export const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__']);
export const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

export function isEnvFile(name: string): boolean {
  return name === '.env' || name.startsWith('.env.') || name.startsWith('.env-');
}

export function toPosix(relPath: string): string {
  return relPath.split(sep).join('/');
}

/** True when `target` is `base` itself or a path underneath it. Both must already be resolved
 * (absolute, no unresolved symlinks) for this to be meaningful. */
export function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export interface WalkedFile {
  /** posix-style, project-relative. */
  relPath: string;
  /** Absolute path to actually read the content from (a symlink's resolved target, if `relPath`
   * names a symlink). */
  sourcePath: string;
  size: number;
}

/**
 * Walks `rootDir` (a project dir, or a staging copy of one — the exclusion rules are the same
 * either way), applying the shared rules: skip node_modules/.git/.venv/venv/__pycache__ dirs,
 * .DS_Store and any `.env*` file, and skip (reporting via `skipped`) a symlink that resolves
 * outside `rootDir` or a file over 50 MB. Yields one `WalkedFile` per included file.
 */
export async function* walkFiles(rootDir: string, skipped: SkippedEntry[]): AsyncGenerator<WalkedFile> {
  const resolvedRoot = resolve(rootDir);
  const visitedRealDirs = new Set<string>();

  async function* walk(sourceDir: string, relDir: string): AsyncGenerator<WalkedFile> {
    const entries = await readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      const sourcePath = join(sourceDir, name);
      const relPath = relDir ? `${relDir}/${name}` : name;

      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(name)) continue;
        yield* walk(sourcePath, relPath);
        continue;
      }

      if (entry.isSymbolicLink()) {
        let resolvedTarget: string;
        let targetStat;
        try {
          const linkTarget = await readlink(sourcePath);
          resolvedTarget = resolve(sourceDir, linkTarget);
          targetStat = await stat(resolvedTarget);
        } catch {
          skipped.push({ path: toPosix(relPath), reason: 'symlink-outside-project' });
          continue;
        }
        if (!isWithin(resolvedRoot, resolvedTarget)) {
          skipped.push({ path: toPosix(relPath), reason: 'symlink-outside-project' });
          continue;
        }
        if (targetStat.isDirectory()) {
          if (visitedRealDirs.has(resolvedTarget)) continue; // symlink loop guard
          visitedRealDirs.add(resolvedTarget);
          if (EXCLUDED_DIR_NAMES.has(name)) continue;
          yield* walk(resolvedTarget, relPath);
          continue;
        }
        if (targetStat.size > MAX_FILE_BYTES) {
          skipped.push({ path: toPosix(relPath), reason: 'too-large' });
          continue;
        }
        yield { relPath: toPosix(relPath), sourcePath: resolvedTarget, size: targetStat.size };
        continue;
      }

      if (entry.isFile()) {
        if (name === '.DS_Store' || isEnvFile(name)) continue;
        const st = await stat(sourcePath);
        if (st.size > MAX_FILE_BYTES) {
          skipped.push({ path: toPosix(relPath), reason: 'too-large' });
          continue;
        }
        yield { relPath: toPosix(relPath), sourcePath, size: st.size };
      }
      // Sockets, FIFOs, devices, etc. are silently ignored.
    }
  }

  yield* walk(resolvedRoot, '');
}
