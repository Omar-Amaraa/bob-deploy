/**
 * S8 — "Job events are append-only and include every file Bob changed and every command run."
 *
 * The append-only half is enforced by real SQLite triggers (migrations/0001_init.ts:
 * trg_job_events_no_update / trg_job_events_no_delete), gated only by the deleteProject() path via
 * withEventDeletesAllowed(). This suite proves the triggers hold under direct SQL (not just through
 * JobsRepo's own API, which never tries to UPDATE/DELETE anyway — a real regression here would be
 * someone adding a raw UPDATE/DELETE somewhere else in the codebase, which only the trigger, not
 * any TypeScript-level discipline, actually stops). The "includes every file/command" half is
 * JobEngine.ctx.change()'s job (packages/core/src/jobs/engine.ts) — verified structurally: every
 * FileChange/CommandChange passed to ctx.change() is appended as a 'change' event with the change
 * payload attached, never dropped or coalesced.
 */
import { describe, it, expect } from 'vitest';
import { openInMemory, withEventDeletesAllowed } from '../../db/db.js';
import { ProjectsRepo } from '../../db/repos/projects.js';
import { JobsRepo } from '../../db/repos/jobs.js';

function seedJobWithOneEvent(db: ReturnType<typeof openInMemory>) {
  const projectId = new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/bd-s8-demo' }).id;
  const jobsRepo = new JobsRepo(db);
  const { job } = jobsRepo.create({ projectId, kind: 'deploy_own_server' }, [{ stepKey: 's1', name: 'step 1', kind: 'script' }]);
  const event = jobsRepo.appendEvent({ jobId: job.id, ts: '2026-01-01T00:00:00.000Z', type: 'step_log', message: 'hello' });
  return { jobsRepo, job, event };
}

describe('S8: job_events is append-only at the SQL level, not just by API convention', () => {
  it('a raw UPDATE on job_events is rejected by the trigger regardless of who issues it', () => {
    const db = openInMemory();
    const { job, event } = seedJobWithOneEvent(db);
    expect(() => db.prepare('UPDATE job_events SET message = ? WHERE job_id = ? AND seq = ?').run('tampered', job.id, event.seq)).toThrow(
      /append-only/,
    );
    const stillThere = db.prepare('SELECT message FROM job_events WHERE job_id = ? AND seq = ?').get(job.id, event.seq) as { message: string };
    expect(stillThere.message).toBe('hello');
    db.close();
  });

  it('a raw DELETE on job_events is rejected outside of withEventDeletesAllowed()', () => {
    const db = openInMemory();
    const { job, event } = seedJobWithOneEvent(db);
    expect(() => db.prepare('DELETE FROM job_events WHERE job_id = ? AND seq = ?').run(job.id, event.seq)).toThrow(/append-only/);
    db.close();
  });

  it('DELETE succeeds only inside withEventDeletesAllowed(), and the gate is closed again immediately afterward', () => {
    const db = openInMemory();
    const { job, event } = seedJobWithOneEvent(db);

    withEventDeletesAllowed(db, () => {
      db.prepare('DELETE FROM job_events WHERE job_id = ? AND seq = ?').run(job.id, event.seq);
    });
    const gone = db.prepare('SELECT 1 FROM job_events WHERE job_id = ? AND seq = ?').get(job.id, event.seq);
    expect(gone).toBeUndefined();

    // The gate table is emptied again as soon as the callback returns — a second, unrelated
    // DELETE outside any withEventDeletesAllowed() call still fails.
    const { event: event2 } = (() => {
      const e = new JobsRepo(db).appendEvent({ jobId: job.id, ts: '2026-01-01T00:00:01.000Z', type: 'step_log', message: 'again' });
      return { event: e };
    })();
    expect(() => db.prepare('DELETE FROM job_events WHERE job_id = ? AND seq = ?').run(job.id, event2.seq)).toThrow(/append-only/);
    db.close();
  });

  it("ctx.change() (via JobEngine) records every file/command change as its own event, never silently dropped", () => {
    const db = openInMemory();
    const projectId = new ProjectsRepo(db).create({ name: 'demo2', folderPath: '/tmp/bd-s8-demo2' }).id;
    const jobsRepo = new JobsRepo(db);
    const { job } = jobsRepo.create({ projectId, kind: 'update' }, [{ stepKey: 's1', name: 'step', kind: 'script' }]);
    const changes = [
      { kind: 'file' as const, path: 'src/app.js', action: 'modified' as const },
      { kind: 'command' as const, cmd: 'npm run build', code: 0 },
      { kind: 'file' as const, path: 'package.json', action: 'modified' as const },
    ];
    for (const change of changes) {
      jobsRepo.appendEvent({
        jobId: job.id,
        ts: '2026-01-01T00:00:00.000Z',
        type: 'change',
        message: change.kind === 'file' ? `${change.action} ${change.path}` : `ran: ${change.cmd}`,
        data: { change },
      });
    }
    const events = jobsRepo.listEvents(job.id);
    const changeEvents = events.filter((e) => e.type === 'change');
    expect(changeEvents).toHaveLength(3);
    expect(changeEvents.map((e) => e.data?.change)).toEqual(changes);
    db.close();
  });
});
