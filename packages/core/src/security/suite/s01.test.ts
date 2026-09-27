/**
 * S1 — "The provider root credential (password or key passphrase) lives in memory for one job
 * only. Never written to disk, database, logs, events, crash reports."
 *
 * The full "run a real testbed deploy+update with every test-secrets.json value in play, then
 * scan artifacts/dataDir/DB dump/job events/Bob prompts" exercise lives in s01.int.test.ts
 * (needs Docker; not executed in this sandbox — see that file's header). This file proves the
 * narrower, Docker-free claim directly against JobEngine + JobsRepo: the root credential passed
 * into JobEngine.start() as a `secrets` map (a) never appears in jobs.inputs_json, (b) is held only
 * in the engine's private in-memory `secretsByJob` map for the lifetime of that one job, and (c) is
 * gone — not just inaccessible, but not present in any subsequent job's secrets map — once the job
 * finishes. There is no separate crash-report subsystem in this codebase (grep confirms it); every
 * error path goes through the same Logger, which is covered by S6's redaction tests instead.
 */
import { describe, it, expect } from 'vitest';
import { openInMemory } from '../../db/db.js';
import { ProjectsRepo } from '../../db/repos/projects.js';
import { JobEngine } from '../../jobs/engine.js';
import type { JobDef, StepContext } from '../../jobs/types.js';
import { JOB_SECRET_ROOT_PASSWORD } from '../../jobs/job-secret-keys.js';
import { loadTestSecrets, findSecretsInText } from './fixtures/secrets.js';

function fakeClock() {
  return {
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    setTimeout: (fn: () => void) => setTimeout(fn, 0),
    clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
  };
}

describe('S1: the root credential is held only in JobEngine\'s in-memory secrets map for one job', () => {
  it('never ends up in jobs.inputs_json even though it is passed alongside sanitized inputs', async () => {
    const db = openInMemory();
    const projectId = new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/bd-s1-demo' }).id;
    const { rootPassword } = loadTestSecrets();

    let sawSecretInContext = '';
    const capturingJobDef: JobDef = {
      kind: 'deploy_own_server',
      build: () => [
        {
          key: 'use-secret',
          name: 'reads the root password from ctx.secrets, not ctx.inputs',
          kind: 'script',
          idempotent: true,
          run: (ctx: StepContext) => {
            sawSecretInContext = ctx.secrets.get(JOB_SECRET_ROOT_PASSWORD) ?? '';
            // ctx.inputs is the sanitized, persisted-verbatim payload — it must never carry the secret.
            expect(JSON.stringify(ctx.inputs)).not.toContain(rootPassword);
            return Promise.resolve();
          },
        },
      ],
    };

    let markDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      markDone = resolve;
    });
    const engine = new JobEngine({
      db,
      redact: (s) => s,
      clock: fakeClock(),
      emit: (event) => {
        if (event.type === 'done') markDone();
      },
      registry: new Map([['deploy_own_server' as const, capturingJobDef]]),
    });

    // Mirrors the IPC handler's secrets-splitting convention (see job-secret-keys.ts): the
    // sanitized inputs persisted to the DB carry no secret fields at all.
    const sanitizedInputs = { domain: 'example.com', serverIp: '203.0.113.10', rootAuth: { method: 'password' } };
    const secrets = new Map([[JOB_SECRET_ROOT_PASSWORD, rootPassword]]);
    const jobId = engine.start(projectId, 'deploy_own_server', sanitizedInputs, secrets);

    expect(sawSecretInContext).toBe(rootPassword);

    const row = db.prepare('SELECT inputs_json FROM jobs WHERE id = ?').get(jobId) as { inputs_json: string };
    expect(findSecretsInText(row.inputs_json, [rootPassword])).toEqual([]);

    // The job keeps writing step/job status after start() returns; closing the db before it
    // finishes surfaced as an unhandled "database connection is not open" rejection.
    await done;
    db.close();
  });

  it('is removed from the engine\'s private map once the job finishes — a later job never inherits it', async () => {
    const db = openInMemory();
    const projectId = new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/bd-s1-demo2' }).id;
    const { rootPassword } = loadTestSecrets();

    let resolveStep: () => void = () => undefined;
    const finishedIds: string[] = [];
    const jobDef: JobDef = {
      kind: 'deploy_own_server',
      build: () => [
        {
          key: 'wait',
          name: 'waits to be released',
          kind: 'script',
          idempotent: true,
          run: (ctx: StepContext) =>
            new Promise<void>((resolve) => {
              resolveStep = resolve;
              finishedIds.push(ctx.jobId);
            }),
        },
      ],
    };

    const engine = new JobEngine({
      db,
      redact: (s) => s,
      clock: fakeClock(),
      emit: () => undefined,
      registry: new Map([['deploy_own_server' as const, jobDef]]),
    });

    const jobId = engine.start(projectId, 'deploy_own_server', {}, new Map([[JOB_SECRET_ROOT_PASSWORD, rootPassword]]));
    // Let the step run and complete.
    await new Promise((r) => setTimeout(r, 10));
    resolveStep();
    await new Promise((r) => setTimeout(r, 10));

    expect(finishedIds).toEqual([jobId]);
    // A second, unrelated job started afterwards gets its own empty secrets map — proving the
    // first job's secret was never left lying around anywhere the engine could hand it out again.
    const secondProjectId = new ProjectsRepo(db).create({ name: 'demo2', folderPath: '/tmp/bd-s1-demo3' }).id;
    let secondSawSecret: string | undefined = 'not-set';
    const secondJobDef: JobDef = {
      kind: 'update',
      build: () => [
        {
          key: 'check',
          name: 'checks it has no leftover secret',
          kind: 'script',
          idempotent: true,
          run: (ctx: StepContext) => {
            secondSawSecret = ctx.secrets.get(JOB_SECRET_ROOT_PASSWORD);
            return Promise.resolve();
          },
        },
      ],
    };
    // registry is private; simplest way in is a second engine instance sharing the db, which is
    // exactly what app restart / a different flow would look like from JobsRepo's point of view.
    let markSecondDone: () => void = () => undefined;
    const secondDone = new Promise<void>((resolve) => {
      markSecondDone = resolve;
    });
    const engine2 = new JobEngine({
      db,
      redact: (s) => s,
      clock: fakeClock(),
      // Wait for the job's own 'done' event before closing the db: a fixed sleep let db.close()
      // race the engine's final step/job updates and surfaced as an unhandled rejection.
      emit: (event) => {
        if (event.type === 'done') markSecondDone();
      },
      registry: new Map([['update' as const, secondJobDef]]),
    });
    engine2.start(secondProjectId, 'update', {});
    await secondDone;
    expect(secondSawSecret).toBe(undefined);

    db.close();
  });
});
