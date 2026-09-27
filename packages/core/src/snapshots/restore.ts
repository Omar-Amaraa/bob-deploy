import { mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Clock } from '@bob-deploy/contracts';
import { walkFiles, type SkippedEntry } from '@bob-deploy/agent';
import type { SnapshotsRepo } from '../db/repos/snapshots.js';

export class JobRunningError extends Error {
  constructor() {
    super('A job is running for this project; wait for it to finish before restoring a snapshot.');
    this.name = 'JobRunningError';
  }
}

export interface RestoreSnapshotInput {
  projectId: string;
  snapshotId: string;
  projectDir: string;
  dataDir: string;
  snapshotsRepo: SnapshotsRepo;
  clock: Clock;
  /** Refuses (JobRunningError) while true — the brief's "refuses while a job runs". */
  isJobRunning(): boolean;
}

export interface RestoreSnapshotResult {
  restoredFiles: number;
  /** Files that existed in the project but weren't in the snapshot manifest — moved aside, never
   * deleted, to dataDir/snapshots/<projectId>/restored-extra-<ts>/. Empty when there were none. */
  movedAsideFiles: string[];
}

function timestamp(clock: Clock): string {
  const d = clock.now();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Restores a project folder from a snapshot taken by takeSnapshot: copies back only the files
 * recorded in the snapshot's manifest (overwriting whatever's there now), and moves aside — never
 * deletes — any file currently in the project (found by the same staging-exclusion walk, so
 * .git/node_modules aren't treated as "extra") that isn't in that manifest, i.e. was created since
 * the snapshot was taken.
 */
export async function restoreSnapshot(input: RestoreSnapshotInput): Promise<RestoreSnapshotResult> {
  if (input.isJobRunning()) throw new JobRunningError();

  const snapshotPath = input.snapshotsRepo.getPath(input.snapshotId);
  if (!snapshotPath) throw new Error(`Snapshot ${input.snapshotId} not found.`);

  const manifestPath = `${snapshotPath}.manifest.json`;
  const manifestRelPaths: string[] = JSON.parse(await readFile(manifestPath, 'utf8')) as string[];
  const manifestSet = new Set(manifestRelPaths);

  // Move aside anything currently in the project that the snapshot doesn't know about, *before*
  // copying the snapshot back over it, so nothing is ever silently overwritten without a copy.
  const movedAsideFiles: string[] = [];
  const extraDir = join(input.dataDir, 'snapshots', input.projectId, `restored-extra-${timestamp(input.clock)}`);
  const skipped: SkippedEntry[] = [];
  for await (const file of walkFiles(input.projectDir, skipped)) {
    if (manifestSet.has(file.relPath)) continue;
    const dest = join(extraDir, ...file.relPath.split('/'));
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(file.sourcePath, dest);
    await rm(file.sourcePath, { force: true });
    movedAsideFiles.push(file.relPath);
  }

  // Copy every manifest file back into the project, overwriting whatever's there.
  for (const relPath of manifestRelPaths) {
    const src = join(snapshotPath, ...relPath.split('/'));
    const dest = join(input.projectDir, ...relPath.split('/'));
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }

  return { restoredFiles: manifestRelPaths.length, movedAsideFiles };
}
