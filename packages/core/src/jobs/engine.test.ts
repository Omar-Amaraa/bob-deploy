import { describe, expect, it, vi } from 'vitest';
import type { JobEvent, JobKind } from '@bob-deploy/contracts';
import { openInMemory } from '../db/db.js';
import { ProjectsRepo } from '../db/repos/projects.js';
import { FakeClock } from '../testing/fake-clock.js';
import { JobEngine } from './engine.js';
import { StepError } from './types.js';
import type { JobDef, StepDef } from './types.js';

let projectCounter = 0;
function seedProject(db: ReturnType<typeof openInMemory>): string {
  projectCounter++;
  return new ProjectsRepo(db).create({ name: 'demo', folderPath: `/tmp/demo-${projectCounter}` }).id;
}

function waitForJobDone(events: JobEvent[], jobId: string): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (events.some((e) => e.jobId === jobId && e.type === 'done')) resolve();
      else setImmediate(check);
    };
    check();
  });
}

interface TestEngine {
  db: ReturnType<typeof openInMemory>;
  clock: FakeClock;
  events: JobEvent[];
  engine: JobEngine;
  registry: Map<JobKind, JobDef>;
}

function makeTestEngine(redact: (s: string) => string = (s) => s): TestEngine {
  const db = openInMemory();
  const clock = new FakeClock();
  const events: JobEvent[] = [];
  const registry = new Map<JobKind, JobDef>();
  const engine = new JobEngine({ db, redact, clock, emit: (e) => events.push(e), registry });
  return { db, clock, events, engine, registry };
}

function stepDef(partial: Partial<StepDef> & Pick<StepDef, 'key' | 'name' | 'run'>): StepDef {
  return { kind: 'script', idempotent: true, ...partial };
}

describe('JobEngine — happy path and failures', () => {
  it('runs a job of one succeeding step through to done', async () => {
    const t = makeTestEngine();
    const projectId = seedProject(t.db);
    const ran: string[] = [];
    t.registry.set('diagnose', {
      kind: 'diagnose',
      build: () => [
        stepDef({
          key: 's1',
          name: 'Step one',
          run: async (ctx) => {
            await Promise.resolve();
            ran.push('run');
            ctx.log('doing work');
          },
          verify: async () => {
            await Promise.resolve();
            ran.push('verify');
          },
        }),
      ],
    });

    const jobId = t.engine.start(projectId, 'diagnose', {});
    await waitForJobDone(t.events, jobId);

    expect(ran).toEqual(['run', 'verify']);
    const result = t.engine.getJob(jobId);
    expect(result?.job.status).toBe('succeeded');
    expect(result?.steps[0]?.status).toBe('succeeded');
    expect(t.events.map((e) => e.type)).toEqual(['step_started', 'step_log', 'step_finished', 'done']);
  });

  it('retries a failing step up to maxAttempts, then succeeds on the last try', async () => {
    const t = makeTestEngine();
    const projectId = seedProject(t.db);
    let attempts = 0;
    t.registry.set('diagnose', {
      kind: 'diagnose',
      build: () => [
        stepDef({
          key: 's1',
          name: 'Flaky step',
          maxAttempts: 3,
          run: async (ctx) => {
            await Promise.resolve();
            attempts++;
            expect(ctx.attempt).toBe(attempts);
            if (attempts < 3) ctx.fail('INTERNAL', 'not yet');
          },
        }),
      ],
    });

    const jobId = t.engine.start(projectId, 'diagnose', {});
    await waitForJobDone(t.events, jobId);

    expect(attempts).toBe(3);
    expect(t.engine.getJob(jobId)?.job.status).toBe('succeeded');
    expect(
      t.events.filter((e) => e.type === 'step_log' && e.message.startsWith('Trying again')),
    ).toHaveLength(2);
  });

  it('fails the job once retries are exhausted, emitting an error event with the step error code', async () => {
    const t = makeTestEngine();
    const projectId = seedProject(t.db);
    t.registry.set('diagnose', {
      kind: 'diagnose',
      build: () => [
        stepDef({
          key: 's1',
          name: 'Always fails',
          maxAttempts: 2,
          run: async (ctx) => {
            await Promise.resolve();
            ctx.fail('SSH_TIMEOUT', 'could not connect');
          },
        }),
      ],
    });

    const jobId = t.engine.start(projectId, 'diagnose', {});
    await waitForJobDone(t.events, jobId);

    const result = t.engine.getJob(jobId);
    expect(result?.job.status).toBe('failed');
    const errorEvent = t.events.find((e) => e.type === 'error');
    expect(errorEvent?.data).toEqual({ code: 'SSH_TIMEOUT' });
    expect(errorEvent?.message).toBe('could not connect');
  });

  it('onFinalFailure can turn a failure into rolled_back', async () => {
    const t = makeTestEngine();
    const projectId = seedProject(t.db);
    t.registry.set('deploy_own_server', {
      kind: 'deploy_own_server',
      build: () => [
        stepDef({
          key: 's1',
          name: 'Deploy',
          run: async (ctx) => {
            await Promise.resolve();
            ctx.fail('BUILD_FAILED', 'build failed');
          },
        }),
      ],
      onFinalFailure: async () => {
        await Promise.resolve();
        return 'rolled_back';
      },
    });

    const jobId = t.engine.start(projectId, 'deploy_own_server', {});
    await waitForJobDone(t.events, jobId);

    expect(t.engine.getJob(jobId)?.job.status).toBe('rolled_back');
  });

  it('onFailure runs local recovery even though the original failure still drives the outcome', async () => {
    const t = makeTestEngine();
    const projectId = seedProject(t.db);
    let recovered = false;
    t.registry.set('diagnose', {
      kind: 'diagnose',
      build: () => [
        stepDef({
          key: 's1',
          name: 'Step',
          run: async (ctx) => {
            await Promise.resolve();
            ctx.fail('INTERNAL', 'nope');
          },
          onFailure: async () => {
            await Promise.resolve();
            recovered = true;
          },
        }),
      ],
    });
    const jobId = t.engine.start(projectId, 'diagnose', {});
    await waitForJobDone(t.events, jobId);
    expect(recovered).toBe(true);
    expect(t.engine.getJob(jobId)?.job.status).toBe('failed');
  });
});

describe('JobEngine — questions and answers', () => {
  function askJobDef(kind: JobQuestionKindTestSetup): JobDef {
    return {
      kind: 'diagnose',
      build: () => [
        stepDef({
          key: 's1',
          name: 'Ask something',
          run: async (ctx) => {
            const value = await ctx.ask({
              kind: kind.questionKind,
              title: 'Question',
              body: 'body',
            });
            ctx.state.answer = value;
          },
        }),
      ],
    };
  }
  type JobQuestionKindTestSetup = { questionKind: 'confirm' | 'choice' | 'text' | 'secret' };

  it('confirm question: waits, then resumes once answered', async () => {
    const t = makeTestEngine();
    const projectId = seedProject(t.db);
    t.registry.set('diagnose', askJobDef({ questionKind: 'confirm' }));

    const jobId = t.engine.start(projectId, 'diagnose', {});
    await vi.waitFor(() => expect(t.engine.getJob(jobId)?.job.status).toBe('waiting_user'));
    const question = t.engine.getJob(jobId)?.pendingQuestion;
    expect(question?.kind).toBe('confirm');

    t.engine.answer(jobId, question!.questionId, true);
    await waitForJobDone(t.events, jobId);
    expect(t.engine.getJob(jobId)?.job.status).toBe('succeeded');
    const answerEvent = t.events.find((e) => e.type === 'answer');
    expect(answerEvent?.data).toEqual({ questionId: question!.questionId, display: 'true' });
  });

  it('secret question: answer_display is redacted, never the raw value', async () => {
    const t = makeTestEngine();
    const projectId = seedProject(t.db);
    t.registry.set('diagnose', askJobDef({ questionKind: 'secret' }));

    const jobId = t.engine.start(projectId, 'diagnose', {});
    await vi.waitFor(() => expect(t.engine.getJob(jobId)?.job.status).toBe('waiting_user'));
    const question = t.engine.getJob(jobId)!.pendingQuestion!;

    t.engine.answer(jobId, question.questionId, 'super-secret-password');
    await waitForJobDone(t.events, jobId);

    const answerEvent = t.events.find((e) => e.type === 'answer');
    expect(answerEvent?.data).toEqual({ questionId: question.questionId, display: '••••' });
    expect(JSON.stringify(t.events)).not.toContain('super-secret-password');
  });

  it('rejects an invalid answer (wrong type for the question kind)', async () => {
    const t = makeTestEngine();
    const projectId = seedProject(t.db);
    t.registry.set('diagnose', askJobDef({ questionKind: 'confirm' }));

    const jobId = t.engine.start(projectId, 'diagnose', {});
    await vi.waitFor(() => expect(t.engine.getJob(jobId)?.job.status).toBe('waiting_user'));
    const question = t.engine.getJob(jobId)!.pendingQuestion!;

    expect(() => t.engine.answer(jobId, question.questionId, 'not-a-boolean')).toThrowError(StepError);
    expect(t.engine.getJob(jobId)?.job.status).toBe('waiting_user');
  });

  it('rejects an answer to an unknown/already-answered question id', async () => {
    const t = makeTestEngine();
    const projectId = seedProject(t.db);
    t.registry.set('diagnose', askJobDef({ questionKind: 'confirm' }));
    const jobId = t.engine.start(projectId, 'diagnose', {});
    await vi.waitFor(() => expect(t.engine.getJob(jobId)?.job.status).toBe('waiting_user'));
    expect(() => t.engine.answer(jobId, 'not-a-real-id', true)).toThrowError(/No open question/);
  });
});

describe('JobEngine — cancellation', () => {
  it('cancel() while a step is running finishes the job as cancelled', async () => {
    const t = makeTestEngine();
    const projectId = seedProject(t.db);
    let started = false;
    t.registry.set('diagnose', {
      kind: 'diagnose',
      build: () => [
        stepDef({
          key: 's1',
          name: 'Long step',
          run: (ctx) =>
            new Promise<void>((resolve, reject) => {
              started = true;
              ctx.signal.addEventListener('abort', () => reject(new StepError('CANCELLED', 'aborted')));
            }),
        }),
      ],
    });

    const jobId = t.engine.start(projectId, 'diagnose', {});
    await vi.waitFor(() => expect(started).toBe(true));
    t.engine.cancel(jobId);
    await waitForJobDone(t.events, jobId);
    expect(t.engine.getJob(jobId)?.job.status).toBe('cancelled');
  });

  it('cancel() while waiting_user rejects the pending ask() and finishes as cancelled', async () => {
    const t = makeTestEngine();
    const projectId = seedProject(t.db);
    t.registry.set('diagnose', {
      kind: 'diagnose',
      build: () => [
        stepDef({
          key: 's1',
          name: 'Ask then wait',
          run: async (ctx) => {
            await ctx.ask({ kind: 'confirm', title: 'q', body: 'b' });
          },
        }),
      ],
    });

    const jobId = t.engine.start(projectId, 'diagnose', {});
    await vi.waitFor(() => expect(t.engine.getJob(jobId)?.job.status).toBe('waiting_user'));
    t.engine.cancel(jobId);
    await waitForJobDone(t.events, jobId);
    expect(t.engine.getJob(jobId)?.job.status).toBe('cancelled');
  });
});

describe('JobEngine — concurrency and per-project locking', () => {
  it('rejects start() with JOB_RUNNING when the project already has an active job', () => {
    const t = makeTestEngine();
    const projectId = seedProject(t.db);
    t.registry.set('diagnose', {
      kind: 'diagnose',
      build: () => [stepDef({ key: 's1', name: 'slow', run: () => new Promise(() => {}) })],
    });
    t.engine.start(projectId, 'diagnose', {});
    expect(() => t.engine.start(projectId, 'diagnose', {})).toThrowError(/already running/);
  });

  it('runs at most 3 jobs concurrently; a 4th job for a different project stays queued', async () => {
    const t = makeTestEngine();
    const gate = { resolvers: [] as (() => void)[] };
    t.registry.set('diagnose', {
      kind: 'diagnose',
      build: () => [
        stepDef({
          key: 's1',
          name: 'Gated',
          run: () =>
            new Promise<void>((resolve) => {
              gate.resolvers.push(resolve);
            }),
        }),
      ],
    });

    const projectIds = [1, 2, 3, 4].map(() => seedProject(t.db));
    const jobIds = projectIds.map((pid) => t.engine.start(pid, 'diagnose', {}));

    await vi.waitFor(() => expect(gate.resolvers).toHaveLength(3));
    expect(t.engine.getJob(jobIds[3]!)?.job.status).toBe('queued');

    gate.resolvers.shift()!();
    await vi.waitFor(() => expect(gate.resolvers).toHaveLength(3));
    expect(t.engine.getJob(jobIds[3]!)?.job.status).not.toBe('queued');

    for (const resolve of gate.resolvers) resolve();
    await Promise.all(jobIds.map((id) => waitForJobDone(t.events, id)));
  });
});

describe('JobEngine — redaction', () => {
  it('applies the redactor to both the top-level message and nested data strings', async () => {
    const t = makeTestEngine((s) => s.replaceAll('hunter2', '••••'));
    const projectId = seedProject(t.db);
    t.registry.set('diagnose', {
      kind: 'diagnose',
      build: () => [
        stepDef({
          key: 's1',
          name: 'Step',
          run: async (ctx) => {
            await Promise.resolve();
            ctx.log('password is hunter2', { nested: { value: 'the password: hunter2' } });
          },
        }),
      ],
    });
    const jobId = t.engine.start(projectId, 'diagnose', {});
    await waitForJobDone(t.events, jobId);
    const logEvent = t.events.find((e) => e.type === 'step_log' && e.message.includes('password'));
    expect(logEvent?.message).toBe('password is ••••');
    expect((logEvent?.data as { nested: { value: string } }).nested.value).toBe('the password: ••••');
    expect(JSON.stringify(t.events)).not.toContain('hunter2');
  });

  it('truncates messages longer than 4000 characters with an ellipsis', async () => {
    const t = makeTestEngine();
    const projectId = seedProject(t.db);
    const long = 'x'.repeat(5000);
    t.registry.set('diagnose', {
      kind: 'diagnose',
      build: () => [
        stepDef({
          key: 's1',
          name: 'Step',
          run: async (ctx) => {
            await Promise.resolve();
            ctx.log(long);
          },
        }),
      ],
    });
    const jobId = t.engine.start(projectId, 'diagnose', {});
    await waitForJobDone(t.events, jobId);
    const logEvent = t.events.find((e) => e.type === 'step_log' && e.message.startsWith('x'));
    expect(logEvent?.message.length).toBe(4000);
    expect(logEvent?.message.endsWith('…')).toBe(true);
  });
});

describe('JobEngine — event ordering', () => {
  it('keeps seq strictly increasing across 200 rapid log() calls', async () => {
    const t = makeTestEngine();
    const projectId = seedProject(t.db);
    t.registry.set('diagnose', {
      kind: 'diagnose',
      build: () => [
        stepDef({
          key: 's1',
          name: 'Chatty step',
          run: async (ctx) => {
            await Promise.resolve();
            for (let i = 0; i < 200; i++) ctx.log(`line ${i}`);
          },
        }),
      ],
    });
    const jobId = t.engine.start(projectId, 'diagnose', {});
    await waitForJobDone(t.events, jobId);
    const seqs = t.events.filter((e) => e.jobId === jobId).map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1]! + 1);
  });
});

describe('JobEngine — subscribe', () => {
  it('replays past events then streams live ones', async () => {
    const t = makeTestEngine();
    const projectId = seedProject(t.db);
    t.registry.set('diagnose', {
      kind: 'diagnose',
      build: () => [
        stepDef({
          key: 's1',
          name: 'Step',
          run: async (ctx) => {
            await Promise.resolve();
            ctx.log('one');
            ctx.log('two');
          },
        }),
      ],
    });
    const jobId = t.engine.start(projectId, 'diagnose', {});
    await waitForJobDone(t.events, jobId);

    const seen: string[] = [];
    const unsubscribe = t.engine.subscribe(jobId, 0, (e) => seen.push(e.type));
    expect(seen).toEqual(['step_started', 'step_log', 'step_log', 'step_finished', 'done']);
    unsubscribe();
  });
});
