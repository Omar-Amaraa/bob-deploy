import { describe, expect, it } from 'vitest';
import { openInMemory } from '../db.js';
import { ProjectsRepo } from './projects.js';

describe('ProjectsRepo', () => {
  it('creates and fetches a project, defaulting status to not_deployed', () => {
    const db = openInMemory();
    const repo = new ProjectsRepo(db);
    const created = repo.create({ name: 'demo', folderPath: '/tmp/demo' });
    expect(created.status).toBe('not_deployed');
    expect(created.stack).toBeUndefined();
    expect(repo.get(created.id)).toEqual(created);
    db.close();
  });

  it('rejects a second project at the same folder path', () => {
    const db = openInMemory();
    const repo = new ProjectsRepo(db);
    repo.create({ name: 'demo', folderPath: '/tmp/demo' });
    expect(() => repo.create({ name: 'demo2', folderPath: '/tmp/demo' })).toThrowError(/already exists/);
    db.close();
  });

  it('setStack stores and rehydrates stack info', () => {
    const db = openInMemory();
    const repo = new ProjectsRepo(db);
    const created = repo.create({ name: 'demo', folderPath: '/tmp/demo' });
    const stack = { framework: 'next', packageManager: 'pnpm', nodeVersion: '22.15.0' } as never;
    repo.setStack(created.id, stack);
    expect(repo.get(created.id)?.stack).toEqual(stack);
    db.close();
  });

  it('setStatus and setStack throw NOT_FOUND for a missing project', () => {
    const db = openInMemory();
    const repo = new ProjectsRepo(db);
    expect(() => repo.setStatus('missing', 'live')).toThrowError(/not found/);
    db.close();
  });

  it('list returns projects ordered by creation time', () => {
    const db = openInMemory();
    const repo = new ProjectsRepo(db);
    const clock1 = () => new Date('2026-01-01T00:00:00.000Z');
    const clock2 = () => new Date('2026-01-02T00:00:00.000Z');
    const a = repo.create({ name: 'a', folderPath: '/a' }, clock1);
    const b = repo.create({ name: 'b', folderPath: '/b' }, clock2);
    expect(repo.list().map((p) => p.id)).toEqual([a.id, b.id]);
    db.close();
  });
});
