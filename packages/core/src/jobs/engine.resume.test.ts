import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobEvent, JobKind } from '@bob-deploy/contracts';
import { openDatabase } from '../db/db.js';
import { ProjectsRepo } from '../db/repos/projects.js';
import { FakeClock } from '../testing/fake-clock.js';
import { JobEngine } from './engine.js';
import type { JobDef, StepDef } from './types.js';

function stepDef(partial: Partial<StepDef> & Pick<StepDef, 'key' | 'name' | 'run'>): StepDef {
  return { kind: 'script', idempotent: true, ...partial };
}

describe('JobEngine — crash recovery (resumeAll)', () => {
  let dir: string;
  let dbFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bob-deploy-resume-'));
    dbFile = join(dir, 'app.db');
  });

  // Every connection a test opens is closed before the temp dir is removed: Windows refuses to
  // delete a sqlite file that still has an open handle (EBUSY), unlike Linux/macOS.
  const openDbs: ReturnType<typeof openDatabase>[] = [];
  function openTracked(): ReturnType<typeof openDatabase> {
    const db = openDatabase(dbFile);
    openDbs.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of openDbs.splice(0)) if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function makeEngine(registry: Map<JobKind, JobDef>): { engine: JobEngine; events: JobEvent[] } {
    const db = openTracked();
    const events: JobEvent[] = [];
    const engine = new JobEngine({
      db,
      redact: (s) => s,
      clock: new FakeClock(),
      emit: (e) => events.push(e),
      registry,
    });
    return { engine, events };
  }

  it('re-runs an idempotent step that was mid-run when the app "crashed"', async () => {
    let runCount = 0;
    const registry = new Map<JobKind, JobDef>([
      [
        'diagnose',
        {
          kind: 'diagnose',
          build: () => [
            stepDef({
              key: 's1',
              name: 'Idempotent step',
              idempotent: true,
              run: async () => {
                runCount++;
                if (runCount === 1) return new Promise<void>(() => {}); // never resolves: simulates the crash
              },
            }),
          ],
        },
      ],
    ]);

    const first = makeEngine(registry);
    const db1 = openTracked();
    const projectId = new ProjectsRepo(db1).create({ name: 'demo', folderPath: '/tmp/demo' }).id;
    const jobId = first.engine.start(projectId, 'diagnose', {});
    await vi.waitFor(() => expect(runCount).toBe(1));
    // No clean shutdown: the process (and its in-memory `running` map) is simply gone.

    const second = makeEngine(registry);
    second.engine.resumeAll();
    await vi.waitFor(() => expect(second.engine.getJob(jobId)?.job.status).toBe('succeeded'));
    expect(runCount).toBe(2);
  });

  it('marks a non-idempotent step failed on resume, with an explanatory message, instead of re-running it', async () => {
    let runCount = 0;
    const registry = new Map<JobKind, JobDef>([
      [
        'diagnose',
        {
          kind: 'diagnose',
          build: () => [
            stepDef({
              key: 's1',
              name: 'Non-idempotent step',
              idempotent: false,
              run: async () => {
                runCount++;
                if (runCount === 1) return new Promise<void>(() => {});
              },
            }),
          ],
        },
      ],
    ]);

    const first = makeEngine(registry);
    const db1 = openTracked();
    const projectId = new ProjectsRepo(db1).create({ name: 'demo', folderPath: '/tmp/demo' }).id;
    const jobId = first.engine.start(projectId, 'diagnose', {});
    await vi.waitFor(() => expect(runCount).toBe(1));

    const second = makeEngine(registry);
    second.engine.resumeAll();
    await vi.waitFor(() => expect(second.engine.getJob(jobId)?.job.status).toBe('failed'));
    expect(runCount).toBe(1);
    const errorEvent = second.events.find((e) => e.type === 'error');
    expect(errorEvent?.message).toMatch(/app closed during this step/);
  });

  it('re-asks a missing secret on resume and never writes it to the database file', async () => {
    let callCount = 0;
    const registry = new Map<JobKind, JobDef>([
      [
        'deploy_own_server',
        {
          kind: 'deploy_own_server',
          build: () => [
            stepDef({
              key: 's1',
              name: 'Needs a secret',
              idempotent: true,
              run: async (ctx) => {
                callCount++;
                if (callCount === 1) {
                  // Simulate the crash: this call never gets to finish or persist anything.
                  return new Promise<void>(() => {});
                }
                let password = ctx.secrets.get('rootPassword');
                if (!password) {
                  password = (await ctx.ask({
                    kind: 'secret',
                    title: 'Enter the server password again',
                    body: 'The app restarted and needs it once more.',
                  })) as string;
                  ctx.secrets.set('rootPassword', password);
                }
                ctx.state.usedPassword = true;
              },
            }),
          ],
        },
      ],
    ]);

    const first = makeEngine(registry);
    const db1 = openTracked();
    const projectId = new ProjectsRepo(db1).create({ name: 'demo', folderPath: '/tmp/demo' }).id;
    const secrets = new Map([['rootPassword', 'correct-horse-battery-staple']]);
    const jobId = first.engine.start(projectId, 'deploy_own_server', {}, secrets);
    await vi.waitFor(() => expect(callCount).toBe(1));
    // The process disappears before the step even gets to ask (in-memory secrets go with it).

    const second = makeEngine(registry);
    second.engine.resumeAll();
    await vi.waitFor(() => expect(second.engine.getJob(jobId)?.job.status).toBe('waiting_user'));
    const question = second.engine.getJob(jobId)?.pendingQuestion;
    expect(question?.kind).toBe('secret');

    second.engine.answer(jobId, question!.questionId, 'a-brand-new-password');
    await vi.waitFor(() => expect(second.engine.getJob(jobId)?.job.status).toBe('succeeded'));

    const bytes = readFileSync(dbFile, 'latin1');
    expect(bytes).not.toContain('correct-horse-battery-staple');
    expect(bytes).not.toContain('a-brand-new-password');
  });

  it('resumes a queued job that never got to start', async () => {
    let ran = false;
    const registry = new Map<JobKind, JobDef>([
      [
        'diagnose',
        {
          kind: 'diagnose',
          build: () => [
            stepDef({
              key: 's1',
              name: 'Step',
              run: async () => {
                await Promise.resolve();
                ran = true;
              },
            }),
          ],
        },
      ],
    ]);

    const db1 = openTracked();
    const projectId = new ProjectsRepo(db1).create({ name: 'demo', folderPath: '/tmp/demo' }).id;
    // Insert a job directly as 'queued' without ever calling engine.start(), simulating a job that
    // was persisted just before the app closed.
    db1
      .prepare('INSERT INTO jobs (id, project_id, kind, status, started_at) VALUES (?, ?, ?, ?, ?)')
      .run('job-queued-1', projectId, 'diagnose', 'queued', new Date().toISOString());
    db1
      .prepare(
        "INSERT INTO job_steps (id, job_id, idx, step_key, name, kind, status, attempt) VALUES ('step-1', 'job-queued-1', 0, 's1', 'Step', 'script', 'pending', 1)",
      )
      .run();

    const second = makeEngine(registry);
    second.engine.resumeAll();
    await vi.waitFor(() => expect(second.engine.getJob('job-queued-1')?.job.status).toBe('succeeded'));
    expect(ran).toBe(true);
  });
});
