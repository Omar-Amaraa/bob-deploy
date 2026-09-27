import { mkdir, copyFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { AgentEvent } from '@bob-deploy/contracts';
import type { DiffResult, StagingWorkspace } from './types.js';

/**
 * Copies an already-gated diff from `staging` into the real `projectDir` — added/modified files
 * are copied over, deleted files are removed. The caller is responsible for having the core take
 * its snapshot first; this function only moves bytes and reports what it did.
 */
export async function* syncBack(
  staging: StagingWorkspace,
  projectDir: string,
  acceptedDiff: DiffResult,
): AsyncGenerator<AgentEvent> {
  for (const relPath of acceptedDiff.added) {
    const segments = relPath.split('/');
    const dest = join(projectDir, ...segments);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(staging.dir, ...segments), dest);
    yield { type: 'file_changed', path: relPath, action: 'added' };
  }
  for (const relPath of acceptedDiff.modified) {
    const segments = relPath.split('/');
    const dest = join(projectDir, ...segments);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(staging.dir, ...segments), dest);
    yield { type: 'file_changed', path: relPath, action: 'modified' };
  }
  for (const relPath of acceptedDiff.deleted) {
    const segments = relPath.split('/');
    await unlink(join(projectDir, ...segments)).catch(() => undefined);
    yield { type: 'file_changed', path: relPath, action: 'deleted' };
  }
}
