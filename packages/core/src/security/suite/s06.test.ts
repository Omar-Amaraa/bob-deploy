/**
 * S6 — "No secret appears in a Bob prompt, job event, log or crash report."
 *
 * The full live-testbed scan (all six testbed/test-secrets.json values, real SSH session output)
 * is s06.int.test.ts (needs Docker; not executed in this sandbox). This file is the Docker-free
 * proof of the same claim at the JobEngine level: every one of the six fixed test secrets, when a
 * step logs it or attaches it as change data (exactly what a careless step implementation might
 * do), never survives JobEngine.appendAndEmit's redact/redactDeep pass — neither in the event handed
 * to `emit` (what a log/crash-report sink would see) nor in what ends up persisted to job_events.
 * The agent-adapter half (no secret reaches a Bob prompt) is covered separately, Docker-free, by
 * packages/agent/src/prompts/builder.test.ts and security.test.ts (both S9-tagged and asserting
 * redactor.assertNoSecrets is enforced on every built prompt).
 */
import { describe, it, expect } from 'vitest';
import { openInMemory } from '../../db/db.js';
import { ProjectsRepo } from '../../db/repos/projects.js';
import { JobEngine } from '../../jobs/engine.js';
import type { JobDef, StepContext } from '../../jobs/types.js';
import { Redactor } from '../redactor.js';
import { allTestSecretValues, findSecretsInText } from './fixtures/secrets.js';

function fakeClock() {
  return {
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    setTimeout: (fn: () => void) => setTimeout(fn, 0),
    clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
  };
}

describe('S6: every fixed test secret is scrubbed from every job event JobEngine emits/persists', () => {
  it('a step that carelessly logs and attaches all six secrets never leaks any of them past redaction', async () => {
    const db = openInMemory();
    const projectId = new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/bd-s6-demo' }).id;
    const secrets = allTestSecretValues();
    const redactor = new Redactor();
    for (const s of secrets) redactor.add(s);

    const emitted: unknown[] = [];
    const jobDef: JobDef = {
      kind: 'deploy_own_server',
      build: () => [
        {
          key: 'careless-step',
          name: 'logs and attaches every secret, as if by mistake',
          kind: 'script',
          idempotent: true,
          run: (ctx: StepContext) => {
            for (const secret of secrets) {
              ctx.log(`about to use secret: ${secret}`, { secret });
              ctx.change({ kind: 'command', cmd: `some-cmd --token ${secret}`, code: 0 });
            }
            return Promise.resolve();
          },
        },
      ],
    };

    const engine = new JobEngine({
      db,
      redact: (s) => redactor.redact(s),
      clock: fakeClock(),
      emit: (e) => emitted.push(e),
      registry: new Map([['deploy_own_server' as const, jobDef]]),
    });

    engine.start(projectId, 'deploy_own_server', {});
    await new Promise((r) => setTimeout(r, 20));

    // What any log/crash-report sink downstream of `emit` would actually see.
    expect(findSecretsInText(JSON.stringify(emitted), secrets)).toEqual([]);

    // What's actually persisted to job_events (a DB dump scan would see exactly this).
    const rows = db.prepare('SELECT message, data_json FROM job_events').all() as { message: string; data_json: string | null }[];
    const persistedText = JSON.stringify(rows);
    expect(findSecretsInText(persistedText, secrets)).toEqual([]);
    expect(rows.length).toBeGreaterThan(0); // sanity: the careless step really did produce events

    db.close();
  });
});
