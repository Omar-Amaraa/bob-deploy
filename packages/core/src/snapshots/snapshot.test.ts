import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openInMemory } from '../db/db.js';
import { ProjectsRepo } from '../db/repos/projects.js';
import { SnapshotsRepo } from '../db/repos/snapshots.js';
import { FakeClock } from '../testing/fake-clock.js';
import { takeSnapshot } from './snapshot.js';
import { restoreSnapshot, JobRunningError } from './restore.js';

const tempDirs: string[] = [];
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function makeDb(): ReturnType<typeof openInMemory> {
  return openInMemory();
}

function seedProject(db: ReturnType<typeof openInMemory>, folderPath: string): string {
  return new ProjectsRepo(db).create({ name: 'demo', folderPath }).id;
}

describe('takeSnapshot / restoreSnapshot', () => {
  it('round-trips a project folder, and moves aside files created since the snapshot', async () => {
    const db = makeDb();
    const repo = new SnapshotsRepo(db);
    const clock = new FakeClock('2026-05-01T00:00:00Z');
    const dataDir = await makeTempDir('bd-data-');
    const projectDir = await makeTempDir('bd-project-');
    const projectId = seedProject(db, projectDir);

    await writeFile(join(projectDir, 'index.html'), '<html>v1</html>');
    await mkdir(join(projectDir, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(projectDir, 'node_modules', 'x', 'index.js'), '');
    await writeFile(join(projectDir, '.env'), 'SECRET=1');

    const snapshot = await takeSnapshot({
      projectId,
      projectDir,
      dataDir,
      reason: 'before Bob fixes',
      snapshotsRepo: repo,
      clock,
    });
    expect(snapshot.reason).toBe('before Bob fixes');
    expect(snapshot.sizeBytes).toBeGreaterThan(0);

    // Snapshot excluded node_modules/.env, same as staging.
    const manifest = JSON.parse(await readFile(`${repo.getPath(snapshot.id)}.manifest.json`, 'utf8')) as string[];
    expect(manifest).toEqual(['index.html']);

    // Change the live project: edit the existing file, add a new one.
    await writeFile(join(projectDir, 'index.html'), '<html>v2 (broken)</html>');
    await writeFile(join(projectDir, 'new-file.txt'), 'created after the snapshot');
    clock.advance(1000);

    const result = await restoreSnapshot({
      projectId,
      snapshotId: snapshot.id,
      projectDir,
      dataDir,
      snapshotsRepo: repo,
      clock,
      isJobRunning: () => false,
    });

    expect(result.restoredFiles).toBe(1);
    expect(result.movedAsideFiles).toEqual(['new-file.txt']);
    expect(await readFile(join(projectDir, 'index.html'), 'utf8')).toBe('<html>v1</html>');
    // The extra file was moved aside, not deleted — still exists, just not in the project anymore.
    await expect(readFile(join(projectDir, 'new-file.txt'), 'utf8')).rejects.toThrow();
    const extraDir = join(dataDir, 'snapshots', projectId, 'restored-extra-20260501T000001Z');
    expect(await readFile(join(extraDir, 'new-file.txt'), 'utf8')).toBe('created after the snapshot');

    db.close();
  });

  it('refuses to restore while a job is running', async () => {
    const db = makeDb();
    const repo = new SnapshotsRepo(db);
    const clock = new FakeClock();
    await expect(
      restoreSnapshot({
        projectId: 'proj1',
        snapshotId: 'whatever',
        projectDir: '/tmp/x',
        dataDir: '/tmp/y',
        snapshotsRepo: repo,
        clock,
        isJobRunning: () => true,
      }),
    ).rejects.toBeInstanceOf(JobRunningError);
    db.close();
  });

  it('keeps only the 10 newest snapshots per project, deleting the oldest directories', async () => {
    const db = makeDb();
    const repo = new SnapshotsRepo(db);
    const clock = new FakeClock('2026-01-01T00:00:00Z');
    const dataDir = await makeTempDir('bd-data-');
    const projectDir = await makeTempDir('bd-project-');
    const projectId = seedProject(db, projectDir);
    await writeFile(join(projectDir, 'index.html'), 'v');

    let firstId = '';
    for (let i = 0; i < 12; i++) {
      const snap = await takeSnapshot({
        projectId,
        projectDir,
        dataDir,
        reason: `snapshot ${i}`,
        snapshotsRepo: repo,
        clock,
      });
      if (i === 0) firstId = snap.id;
      clock.advance(60_000);
    }

    const remaining = repo.listForProject(projectId);
    expect(remaining.length).toBe(10);
    expect(remaining.find((r) => r.id === firstId)).toBeUndefined();

    db.close();
  });
});
