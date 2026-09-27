import { describe, expect, it } from 'vitest';
import { openInMemory } from '../db.js';
import { ProjectsRepo } from './projects.js';
import { TargetsRepo } from './targets.js';
import { ReleasesRepo } from './releases.js';

function seed(db: ReturnType<typeof openInMemory>): { projectId: string; targetId: string } {
  const projectId = new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/demo' }).id;
  const targetId = new TargetsRepo(db).upsert({ projectId, kind: 'own_server' }).id;
  return { projectId, targetId };
}

describe('ReleasesRepo', () => {
  it('creates a release as uploaded and promotes it to live, demoting the previous one', () => {
    const db = openInMemory();
    const { projectId, targetId } = seed(db);
    const repo = new ReleasesRepo(db);

    const r1 = repo.create({ projectId, targetId, releaseId: '20260101T000000Z', folderHash: 'h1' });
    expect(r1.status).toBe('uploaded');
    repo.promoteToLive(projectId, r1.id);
    expect(repo.get(r1.id)?.status).toBe('live');

    const r2 = repo.create({ projectId, targetId, releaseId: '20260102T000000Z', folderHash: 'h2' });
    repo.promoteToLive(projectId, r2.id);
    expect(repo.get(r1.id)?.status).toBe('previous');
    expect(repo.get(r2.id)?.status).toBe('live');
    expect(repo.getLive(projectId)?.id).toBe(r2.id);
    db.close();
  });

  it('promoteToLive throws NOT_FOUND for an unknown release id', () => {
    const db = openInMemory();
    const { projectId } = seed(db);
    expect(() => new ReleasesRepo(db).promoteToLive(projectId, 'missing')).toThrowError(/not found/);
    db.close();
  });

  it('listForProject orders newest first', () => {
    const db = openInMemory();
    const { projectId, targetId } = seed(db);
    const repo = new ReleasesRepo(db);
    const early = () => new Date('2026-01-01T00:00:00.000Z');
    const late = () => new Date('2026-01-02T00:00:00.000Z');
    const r1 = repo.create({ projectId, targetId, releaseId: 'a', folderHash: 'h1' }, early);
    const r2 = repo.create({ projectId, targetId, releaseId: 'b', folderHash: 'h2' }, late);
    expect(repo.listForProject(projectId).map((r) => r.id)).toEqual([r2.id, r1.id]);
    db.close();
  });

  it('getRemotePath exposes the internal remote_path column not on the contract type', () => {
    const db = openInMemory();
    const { projectId, targetId } = seed(db);
    const repo = new ReleasesRepo(db);
    const r1 = repo.create({
      projectId,
      targetId,
      releaseId: 'a',
      folderHash: 'h1',
      remotePath: '/srv/apps/demo/releases/a',
    });
    expect(repo.getRemotePath(r1.id)).toBe('/srv/apps/demo/releases/a');
    db.close();
  });

  it('getByReleaseId finds a release by its human-readable id, scoped to the project', () => {
    const db = openInMemory();
    const { projectId, targetId } = seed(db);
    const repo = new ReleasesRepo(db);
    const r1 = repo.create({ projectId, targetId, releaseId: '20260101T000000Z', folderHash: 'h1' });
    expect(repo.getByReleaseId(projectId, '20260101T000000Z')?.id).toBe(r1.id);
    expect(repo.getByReleaseId(projectId, 'nope')).toBeUndefined();
    expect(repo.getByReleaseId('other-project', '20260101T000000Z')).toBeUndefined();
    db.close();
  });

  it('setPort records the live port once known, and throws NOT_FOUND for an unknown release id', () => {
    const db = openInMemory();
    const { projectId, targetId } = seed(db);
    const repo = new ReleasesRepo(db);
    const r1 = repo.create({ projectId, targetId, releaseId: 'a', folderHash: 'h1' });
    expect(repo.get(r1.id)?.port).toBeUndefined();
    repo.setPort(r1.id, 4001);
    expect(repo.get(r1.id)?.port).toBe(4001);
    expect(() => repo.setPort('missing', 4001)).toThrowError(/not found/);
    db.close();
  });
});
