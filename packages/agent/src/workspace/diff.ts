import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { DiffResult, StagingWorkspace } from './types.js';
import { walkFiles } from './fs-walk.js';

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((res, rej) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => res());
    stream.on('error', rej);
  });
  return hash.digest('hex');
}

/** Recomputes the staging dir's current contents (same exclusion rules as createStaging — an
 * `npm ci` run inside staging, say, must not show up as hundreds of "added" files). */
export async function computeManifest(dir: string): Promise<Map<string, string>> {
  const manifest = new Map<string, string>();
  const skipped: StagingWorkspace['skipped'] = [];
  for await (const file of walkFiles(dir, skipped)) {
    manifest.set(file.relPath, await sha256File(file.sourcePath));
  }
  return manifest;
}

/**
 * Diffs the staging dir's current contents against `staging.manifest` (the baseline from
 * createStaging, or the last time this was called), and updates `staging.manifest` to the new
 * snapshot so a second call reports no further changes until something else edits staging again.
 */
export async function diffStaging(staging: StagingWorkspace): Promise<DiffResult> {
  const current = await computeManifest(staging.dir);
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const [path, hash] of current) {
    const before = staging.manifest.get(path);
    if (before === undefined) added.push(path);
    else if (before !== hash) modified.push(path);
  }
  for (const path of staging.manifest.keys()) {
    if (!current.has(path)) deleted.push(path);
  }

  staging.manifest = current;
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}
