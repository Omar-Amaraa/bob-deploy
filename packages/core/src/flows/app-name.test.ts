import { describe, it, expect } from 'vitest';
import { appSlugSchema } from '@bob-deploy/contracts';
import { openInMemory } from '../db/db.js';
import { ProjectsRepo } from '../db/repos/projects.js';
import { TargetsRepo } from '../db/repos/targets.js';
import { uniqueAppName, APP_NAME_MAX_LENGTH } from './deploy-own-server.js';

const IP = '203.0.113.10';
const PORT = 22;

function setup() {
  const db = openInMemory();
  const projects = new ProjectsRepo(db);
  const targets = new TargetsRepo(db);
  return { db, projects, targets };
}

describe('uniqueAppName', () => {
  it('uses the project name, so the server app user bd-<name> stays within Linux 32 characters', () => {
    const { db, targets } = setup();
    const name = uniqueAppName(targets, IP, PORT, 'My Very Long Portfolio Website For Clients 2026', 'p1');
    expect(name.length).toBeLessThanOrEqual(APP_NAME_MAX_LENGTH);
    expect(`bd-${name}`.length).toBeLessThanOrEqual(32);
    expect(appSlugSchema.safeParse(name).success).toBe(true);
    expect(name.startsWith('my-very-long-portfolio')).toBe(true);
    db.close();
  });

  it('keeps the same name when the same project retries on the same server', () => {
    const { db, projects, targets } = setup();
    const p = projects.create({ name: 'static-html', folderPath: '/tmp/a' });
    targets.upsert({ projectId: p.id, kind: 'own_server', appName: 'static-html', ip: IP, sshPort: PORT });
    expect(uniqueAppName(targets, IP, PORT, 'static-html', p.id)).toBe('static-html');
    db.close();
  });

  it('adds a suffix for another project on the same server, still within the length cap', () => {
    const { db, projects, targets } = setup();
    const long = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const other = projects.create({ name: long, folderPath: '/tmp/b' });
    const taken = uniqueAppName(targets, IP, PORT, long, other.id);
    targets.upsert({ projectId: other.id, kind: 'own_server', appName: taken, ip: IP, sshPort: PORT });

    const mine = uniqueAppName(targets, IP, PORT, long, 'another-project');
    expect(mine).not.toBe(taken);
    expect(mine.endsWith('-2')).toBe(true);
    expect(mine.length).toBeLessThanOrEqual(APP_NAME_MAX_LENGTH);
    db.close();
  });
});
