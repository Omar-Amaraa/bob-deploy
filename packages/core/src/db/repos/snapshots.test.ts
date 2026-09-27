import { describe, expect, it } from 'vitest';
import { openInMemory } from '../db.js';
import { ProjectsRepo } from './projects.js';
import { SnapshotsRepo } from './snapshots.js';

function seedProject(db: ReturnType<typeof openInMemory>): string {
  return new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/demo' }).id;
}

describe('SnapshotsRepo', () => {
  it('creates, lists (newest first) and deletes snapshots', () => {
    const db = openInMemory();
    const projectId = seedProject(db);
    const repo = new SnapshotsRepo(db);
    const early = () => new Date('2026-01-01T00:00:00.000Z');
    const late = () => new Date('2026-01-02T00:00:00.000Z');
    const s1 = repo.create({ projectId, path: '/snap/1.tgz', reason: 'pre-deploy', sizeBytes: 100 }, early);
    const s2 = repo.create({ projectId, path: '/snap/2.tgz', reason: 'pre-deploy', sizeBytes: 200 }, late);

    expect(repo.listForProject(projectId).map((s) => s.id)).toEqual([s2.id, s1.id]);
    expect(repo.getPath(s1.id)).toBe('/snap/1.tgz');

    repo.delete(s1.id);
    expect(repo.get(s1.id)).toBeUndefined();
    db.close();
  });

  it('delete throws NOT_FOUND for an unknown id', () => {
    const db = openInMemory();
    expect(() => new SnapshotsRepo(db).delete('missing')).toThrowError(/not found/);
    db.close();
  });
});
