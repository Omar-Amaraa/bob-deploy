import { describe, expect, it } from 'vitest';
import { openInMemory, withEventDeletesAllowed } from './db.js';

function seedProjectAndJob(db: ReturnType<typeof openInMemory>): { projectId: string; jobId: string } {
  db.prepare('INSERT INTO projects (id, name, folder_path, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'p1',
    'demo',
    '/tmp/demo',
    'not_deployed',
    '2026-01-01T00:00:00.000Z',
  );
  db.prepare('INSERT INTO jobs (id, project_id, kind, status, started_at) VALUES (?, ?, ?, ?, ?)').run(
    'j1',
    'p1',
    'deploy_own_server',
    'running',
    '2026-01-01T00:00:00.000Z',
  );
  db.prepare('INSERT INTO job_events (job_id, seq, ts, type, message) VALUES (?, ?, ?, ?, ?)').run(
    'j1',
    1,
    '2026-01-01T00:00:00.000Z',
    'step_log',
    'hello',
  );
  return { projectId: 'p1', jobId: 'j1' };
}

describe('openInMemory / db pragmas and triggers', () => {
  it('sets the required pragmas', () => {
    const db = openInMemory();
    expect(db.pragma('foreign_keys', { simple: true }) as number).toBe(1);
    db.close();
  });

  it('rejects UPDATE on job_events unconditionally', () => {
    const db = openInMemory();
    seedProjectAndJob(db);
    expect(() => db.prepare("UPDATE job_events SET message = 'edited' WHERE job_id = 'j1'").run()).toThrow(
      /append-only/,
    );
    db.close();
  });

  it('rejects DELETE on job_events outside withEventDeletesAllowed', () => {
    const db = openInMemory();
    seedProjectAndJob(db);
    expect(() => db.prepare("DELETE FROM job_events WHERE job_id = 'j1'").run()).toThrow(/append-only/);
    db.close();
  });

  it('allows DELETE on job_events inside withEventDeletesAllowed, and revokes it after', () => {
    const db = openInMemory();
    seedProjectAndJob(db);
    withEventDeletesAllowed(db, () => {
      db.prepare("DELETE FROM job_events WHERE job_id = 'j1'").run();
    });
    const remaining = (db.prepare('SELECT COUNT(*) as n FROM job_events').get() as { n: number }).n;
    expect(remaining).toBe(0);

    db.prepare('INSERT INTO job_events (job_id, seq, ts, type, message) VALUES (?, ?, ?, ?, ?)').run(
      'j1',
      2,
      '2026-01-01T00:00:01.000Z',
      'step_log',
      'again',
    );
    expect(() => db.prepare("DELETE FROM job_events WHERE job_id = 'j1'").run()).toThrow(/append-only/);
    db.close();
  });

  it('revokes delete permission even if the callback throws', () => {
    const db = openInMemory();
    seedProjectAndJob(db);
    expect(() =>
      withEventDeletesAllowed(db, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(() => db.prepare("DELETE FROM job_events WHERE job_id = 'j1'").run()).toThrow(/append-only/);
    db.close();
  });
});
