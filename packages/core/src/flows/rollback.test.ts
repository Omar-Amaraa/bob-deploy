import { describe, it, expect } from 'vitest';
import type { ExecResult, RemoteExec } from '@bob-deploy/ssh-playbooks';
import { openInMemory } from '../db/db.js';
import { ProjectsRepo } from '../db/repos/projects.js';
import { TargetsRepo } from '../db/repos/targets.js';
import { ReleasesRepo } from '../db/repos/releases.js';
import { StepError, type StepContext } from '../jobs/types.js';
import { InMemoryVault } from './vault.js';
import { buildRollbackJobDef, type RollbackDeps } from './rollback.js';

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, ...overrides };
}

/** Matches deploy-own-server.test.ts's convention: a small, fixed, known sequence of exec() calls
 * per already-tested ssh-playbooks primitive (here, rollbackTo's static-site branch, which only
 * does a disk-existence check and a symlink swap — no service restart or health checks at all). */
function queuedRemoteExec(responses: ExecResult[]): RemoteExec & { closed: boolean } {
  const queue = [...responses];
  const handle = {
    closed: false,
    exec(): Promise<ExecResult> {
      const next = queue.shift();
      return Promise.resolve(next ?? execResult());
    },
    upload(): Promise<void> {
      return Promise.resolve();
    },
    close(): void {
      handle.closed = true;
    },
  };
  return handle;
}

interface FakeCtx extends StepContext {
  logs: string[];
}

function fakeCtx(inputs: unknown, projectId: string): FakeCtx {
  const logs: string[] = [];
  return {
    jobId: 'job1',
    projectId,
    stepId: 'rollback',
    attempt: 1,
    signal: new AbortController().signal,
    inputs,
    secrets: new Map(),
    state: {},
    shared: {},
    logs,
    log: (message) => logs.push(message),
    change: () => undefined,
    ask: () => Promise.resolve(true),
    fail: (code, message) => {
      throw new StepError(code, message);
    },
  };
}

function makeDeps(db: ReturnType<typeof openInMemory>, overrides: Partial<RollbackDeps> = {}): RollbackDeps {
  return {
    projectsRepo: new ProjectsRepo(db),
    targetsRepo: new TargetsRepo(db),
    releasesRepo: new ReleasesRepo(db),
    vault: new InMemoryVault(),
    redact: (s) => s,
    ...overrides,
  };
}

describe('rollback', () => {
  it('fails with NOT_FOUND when the project has never been deployed', async () => {
    const db = openInMemory();
    const projectId = new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/whatever' }).id;
    const deps = makeDeps(db);
    const jobDef = buildRollbackJobDef(deps);
    const [rollbackStep] = jobDef.build({});
    const ctx = fakeCtx({}, projectId);

    await expect(rollbackStep!.run(ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    db.close();
  });

  it('fails with HOST_UNSUPPORTED and points at the dashboard for a free-host target', async () => {
    const db = openInMemory();
    const projectsRepo = new ProjectsRepo(db);
    const projectId = projectsRepo.create({ name: 'demo', folderPath: '/tmp/whatever' }).id;
    const targetsRepo = new TargetsRepo(db);
    targetsRepo.upsert({ projectId, kind: 'netlify', appName: 'demo', siteUrl: 'https://demo.netlify.app' });
    const deps = makeDeps(db, { projectsRepo, targetsRepo });
    const jobDef = buildRollbackJobDef(deps);
    const [rollbackStep] = jobDef.build({});
    const ctx = fakeCtx({}, projectId);

    await expect(rollbackStep!.run(ctx)).rejects.toMatchObject({ code: 'HOST_UNSUPPORTED', message: expect.stringContaining('netlify.com') as unknown as string });

    db.close();
  });

  it('fails with INTERNAL when an own_server target has no recorded ports yet', async () => {
    const db = openInMemory();
    const projectsRepo = new ProjectsRepo(db);
    const projectId = projectsRepo.create({ name: 'demo', folderPath: '/tmp/whatever' }).id;
    const targetsRepo = new TargetsRepo(db);
    targetsRepo.upsert({ projectId, kind: 'own_server', appName: 'demo', domain: 'demo.example.com', ip: '203.0.113.10', adminUser: 'deploy', sshPort: 22 });
    const deps = makeDeps(db, { projectsRepo, targetsRepo });
    const jobDef = buildRollbackJobDef(deps);
    const [rollbackStep] = jobDef.build({});
    const ctx = fakeCtx({}, projectId);

    await expect(rollbackStep!.run(ctx)).rejects.toMatchObject({ code: 'INTERNAL' });

    db.close();
  });

  it('rolls a static site back to a named release, closes the session, and demotes the old live release', async () => {
    const db = openInMemory();
    const projectsRepo = new ProjectsRepo(db);
    const projectId = projectsRepo.create({ name: 'demo', folderPath: '/tmp/whatever' }).id;
    projectsRepo.setStack(projectId, { type: 'static', outputDir: '.', needsBackend: false });
    const targetsRepo = new TargetsRepo(db);
    const target = targetsRepo.upsert({
      projectId,
      kind: 'own_server',
      appName: 'demo',
      domain: 'demo.example.com',
      ip: '203.0.113.10',
      adminUser: 'deploy',
      sshPort: 22,
      portA: 3001,
      portB: 3002,
    });
    const releasesRepo = new ReleasesRepo(db);
    const oldLive = releasesRepo.create({ projectId, targetId: target.id, releaseId: '20260101T000000Z', folderHash: 'hash-old' });
    releasesRepo.setStatus(oldLive.id, 'live');
    const previous = releasesRepo.create({ projectId, targetId: target.id, releaseId: '20260102T000000Z', folderHash: 'hash-prev' });
    releasesRepo.setStatus(previous.id, 'previous');

    // rollbackTo's static branch: 1) test -d (releaseStillOnDisk), 2) the symlink swap.
    const session = queuedRemoteExec([execResult({ code: 0 }), execResult({ code: 0 })]);
    const deps = makeDeps(db, {
      projectsRepo,
      targetsRepo,
      releasesRepo,
      connectAsAdmin: () => Promise.resolve(session),
    });
    const jobDef = buildRollbackJobDef(deps);
    const [rollbackStep] = jobDef.build({});
    const ctx = fakeCtx({ releaseId: '20260102T000000Z' }, projectId);

    await rollbackStep!.run(ctx);

    expect(session.closed).toBe(true);
    expect(releasesRepo.getByReleaseId(projectId, '20260102T000000Z')?.status).toBe('live');
    expect(releasesRepo.get(oldLive.id)?.status).toBe('previous');
    expect(projectsRepo.get(projectId)?.status).toBe('live');
    expect(ctx.logs.some((l) => l.includes('Rolled back to release'))).toBe(true);

    db.close();
  });
});
