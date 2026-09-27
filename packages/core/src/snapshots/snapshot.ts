import { mkdir, rename, rm, writeFile, stat, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Clock, SnapshotRecord } from '@bob-deploy/contracts';
import { createStaging } from '@bob-deploy/agent';
import type { SnapshotsRepo } from '../db/repos/snapshots.js';

const KEEP_NEWEST = 10;

/** UTC 'YYYYMMDDTHHMMSSZ', same shape as ssh-playbooks' release ids, so a project's snapshot and
 * release timelines read the same way. */
function timestamp(clock: Clock): string {
  const d = clock.now();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSizeBytes(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}

export interface TakeSnapshotInput {
  projectId: string;
  projectDir: string;
  /** Bob Deploy's app data directory (dataDir); snapshots live under dataDir/snapshots/<projectId>/. */
  dataDir: string;
  reason: string;
  snapshotsRepo: SnapshotsRepo;
  clock: Clock;
}

/**
 * Copies the project folder (the same node_modules/.git/.venv/__pycache__/.env* exclusions as
 * staging — literally the same walker, `@bob-deploy/agent`'s `createStaging`) to
 * dataDir/snapshots/<projectId>/<ts>/, records a row with its total size, and prunes down to the
 * 10 newest snapshots for this project (oldest directories deleted, never just the DB rows, so
 * disk usage doesn't grow unbounded).
 */
export async function takeSnapshot(input: TakeSnapshotInput): Promise<SnapshotRecord> {
  const ts = timestamp(input.clock);
  const projectSnapshotsDir = join(input.dataDir, 'snapshots', input.projectId);
  await mkdir(projectSnapshotsDir, { recursive: true });

  const tmpRoot = join(projectSnapshotsDir, '.tmp');
  const staging = await createStaging(input.projectDir, tmpRoot);
  const finalDir = join(projectSnapshotsDir, ts);
  await mkdir(dirname(finalDir), { recursive: true });
  await rename(staging.dir, finalDir);
  // staging.dir is tmpRoot/<uuid>/project; clean up its now-empty <uuid> parent.
  await rm(dirname(staging.dir), { recursive: true, force: true });

  const manifestPath = `${finalDir}.manifest.json`;
  await writeFile(manifestPath, JSON.stringify([...staging.manifest.keys()]), 'utf8');

  const sizeBytes = await dirSizeBytes(finalDir);
  const record = input.snapshotsRepo.create(
    { projectId: input.projectId, path: finalDir, reason: input.reason, sizeBytes },
    () => input.clock.now(),
  );

  const all = input.snapshotsRepo.listForProject(input.projectId); // newest first
  const toDelete = all.slice(KEEP_NEWEST);
  for (const old of toDelete) {
    const oldPath = input.snapshotsRepo.getPath(old.id);
    if (oldPath) {
      await rm(oldPath, { recursive: true, force: true });
      await rm(`${oldPath}.manifest.json`, { force: true });
    }
    input.snapshotsRepo.delete(old.id);
  }

  return record;
}
