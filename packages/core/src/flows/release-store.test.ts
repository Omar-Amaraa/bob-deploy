import { describe, it, expect } from 'vitest';
import { openInMemory } from '../db/db.js';
import { ProjectsRepo } from '../db/repos/projects.js';
import { TargetsRepo } from '../db/repos/targets.js';
import { ReleasesRepo } from '../db/repos/releases.js';
import { FakeClock } from '../testing/fake-clock.js';
import { CoreReleaseStore } from './release-store.js';

function seed(db: ReturnType<typeof openInMemory>): { projectId: string; targetId: string } {
  const projectId = new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/demo' }).id;
  const targetId = new TargetsRepo(db).upsert({ projectId, kind: 'own_server' }).id;
  return { projectId, targetId };
}

describe('CoreReleaseStore', () => {
  it('records a release under its human releaseId, applies the caller-supplied initial status, and lists/updates by that id', async () => {
    const db = openInMemory();
    const { projectId, targetId } = seed(db);
    const releasesRepo = new ReleasesRepo(db);
    const clock = new FakeClock('2026-03-01T00:00:00Z');
    const store = new CoreReleaseStore(releasesRepo, projectId, targetId, clock);

    // Mirrors releaseProcedure's own call sequence: optimistic 'failed' placeholder right after
    // packaging, promoted to 'live' once health checks pass.
    await store.recordRelease('myapp', {
      id: '20260301T000000Z',
      status: 'failed',
      createdAt: clock.now().toISOString(),
      folderHash: 'hash-1',
    });

    let releases = await store.listReleases('myapp');
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ id: '20260301T000000Z', status: 'failed', folderHash: 'hash-1' });
    expect(typeof releases[0]?.createdAt).toBe('string');

    await store.updateReleaseStatus('myapp', '20260301T000000Z', 'live');
    releases = await store.listReleases('myapp');
    expect(releases[0]?.status).toBe('live');

    // The underlying repo row is keyed by an internal UUID, not the human releaseId; confirm the
    // adapter didn't leak that detail and that the repo actually has the update.
    const stored = releasesRepo.getByReleaseId(projectId, '20260301T000000Z');
    expect(stored?.status).toBe('live');
    expect(stored?.targetId).toBe(targetId);

    // A second release demotes nothing on its own (that's promoteToLive, which the flow calls
    // directly, not part of ReleaseStore) but is listed alongside the first.
    await store.recordRelease('myapp', {
      id: '20260302T000000Z',
      status: 'failed',
      createdAt: clock.now().toISOString(),
      folderHash: 'hash-2',
    });
    await store.updateReleaseStatus('myapp', '20260302T000000Z', 'deleted');
    releases = await store.listReleases('myapp');
    expect(releases.map((r) => r.id).sort()).toEqual(['20260301T000000Z', '20260302T000000Z']);
    expect(releases.find((r) => r.id === '20260302T000000Z')?.status).toBe('deleted');

    db.close();
  });

  it('updateReleaseStatus throws for a releaseId that was never recorded', async () => {
    const db = openInMemory();
    const { projectId, targetId } = seed(db);
    const store = new CoreReleaseStore(new ReleasesRepo(db), projectId, targetId, new FakeClock());
    await expect(store.updateReleaseStatus('myapp', 'nope', 'live')).rejects.toThrow(/not found/);
    db.close();
  });
});
