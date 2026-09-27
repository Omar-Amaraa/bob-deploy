import { describe, expect, it } from 'vitest';
import { openInMemory } from '../db.js';
import { ProjectsRepo } from './projects.js';
import { TargetsRepo } from './targets.js';

function seedProject(db: ReturnType<typeof openInMemory>): string {
  return new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/demo' }).id;
}

describe('TargetsRepo', () => {
  it('upsert inserts on first call and updates in place on the second (one target per project)', () => {
    const db = openInMemory();
    const projectId = seedProject(db);
    const repo = new TargetsRepo(db);

    const first = repo.upsert({ projectId, kind: 'own_server', domain: 'example.com' });
    expect(repo.getByProjectId(projectId)?.domain).toBe('example.com');

    const second = repo.upsert({ projectId, kind: 'own_server', domain: 'other.example.com' });
    expect(second.id).toBe(first.id);
    expect(repo.getByProjectId(projectId)?.domain).toBe('other.example.com');
    db.close();
  });

  it('getByProjectId returns undefined when there is no target yet', () => {
    const db = openInMemory();
    const projectId = seedProject(db);
    expect(new TargetsRepo(db).getByProjectId(projectId)).toBeUndefined();
    db.close();
  });

  it('deleteForProject removes the target', () => {
    const db = openInMemory();
    const projectId = seedProject(db);
    const repo = new TargetsRepo(db);
    repo.upsert({ projectId, kind: 'netlify', siteUrl: 'https://demo.netlify.app' });
    repo.deleteForProject(projectId);
    expect(repo.getByProjectId(projectId)).toBeUndefined();
    db.close();
  });

  it('setSiteUrl updates only the siteUrl, leaving every other column untouched', () => {
    const db = openInMemory();
    const projectId = seedProject(db);
    const repo = new TargetsRepo(db);
    const target = repo.upsert({ projectId, kind: 'own_server', domain: 'example.com', ip: '203.0.113.10', appName: 'demo' });
    repo.setSiteUrl(target.id, 'https://example.com');
    const updated = repo.get(target.id);
    expect(updated).toMatchObject({ domain: 'example.com', ip: '203.0.113.10', appName: 'demo', siteUrl: 'https://example.com' });
    db.close();
  });

  it('getPorts returns undefined until setPorts (or upsert with portA/portB) has been called', () => {
    const db = openInMemory();
    const projectId = seedProject(db);
    const repo = new TargetsRepo(db);
    const target = repo.upsert({ projectId, kind: 'own_server' });
    expect(repo.getPorts(target.id)).toBeUndefined();
    repo.setPorts(target.id, 3101, 3102);
    expect(repo.getPorts(target.id)).toEqual({ portA: 3101, portB: 3102, tlsMode: 'auto' });
    db.close();
  });

  it('listByServer finds every own_server target on a given host:port, across projects', () => {
    const db = openInMemory();
    const repo = new TargetsRepo(db);
    const p1 = seedProject(db);
    const p2 = new ProjectsRepo(db).create({ name: 'demo2', folderPath: '/tmp/demo2' }).id;
    const p3 = new ProjectsRepo(db).create({ name: 'demo3', folderPath: '/tmp/demo3' }).id;
    repo.upsert({ projectId: p1, kind: 'own_server', ip: '203.0.113.10', sshPort: 22, appName: 'demo' });
    repo.upsert({ projectId: p2, kind: 'own_server', ip: '203.0.113.10', sshPort: 22, appName: 'demo-2' });
    repo.upsert({ projectId: p3, kind: 'own_server', ip: '203.0.113.99', sshPort: 22, appName: 'demo' });
    const onServer = repo.listByServer('203.0.113.10', 22);
    expect(onServer.map((t) => t.appName).sort()).toEqual(['demo', 'demo-2']);
    db.close();
  });
});
