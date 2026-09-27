import { describe, it, expect } from 'vitest';
import type { ExecResult, RemoteExec } from '@bob-deploy/ssh-playbooks';
import { openInMemory } from '../db/db.js';
import { ProjectsRepo } from '../db/repos/projects.js';
import { TargetsRepo } from '../db/repos/targets.js';
import { ReleasesRepo } from '../db/repos/releases.js';
import { StepError, type StepContext } from '../jobs/types.js';
import { InMemoryVault } from './vault.js';
import { buildMaintenanceJobDef, type MaintenanceDeps, type MaintenanceInputs } from './maintenance.js';

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, ...overrides };
}
function bdSuccess(fields: Record<string, string>): ExecResult {
  return execResult({ stdout: `BD_RESULT ${JSON.stringify({ ok: true, ...fields })}\n` });
}

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

function fakeCtx(actionId: MaintenanceInputs['actionId'], projectId: string, answers: (string | boolean)[] = []): FakeCtx {
  const logs: string[] = [];
  const answerQueue = [...answers];
  return {
    jobId: 'job1',
    projectId,
    stepId: 'maintenance',
    attempt: 1,
    signal: new AbortController().signal,
    inputs: { actionId },
    secrets: new Map(),
    state: {},
    shared: {},
    logs,
    log: (message) => logs.push(message),
    change: () => undefined,
    ask: () => Promise.resolve(answerQueue.shift() ?? true),
    fail: (code, message) => {
      throw new StepError(code, message);
    },
  };
}

function makeDeps(db: ReturnType<typeof openInMemory>, overrides: Partial<MaintenanceDeps> = {}): MaintenanceDeps {
  return {
    projectsRepo: new ProjectsRepo(db),
    targetsRepo: new TargetsRepo(db),
    releasesRepo: new ReleasesRepo(db),
    vault: new InMemoryVault(),
    redact: (s) => s,
    ...overrides,
  };
}

describe('maintenance', () => {
  it('fails with NOT_FOUND when the project has no deployed target', async () => {
    const db = openInMemory();
    const projectId = new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/whatever' }).id;
    const deps = makeDeps(db);
    const [step] = buildMaintenanceJobDef(deps).build({});
    const ctx = fakeCtx('clean_disk', projectId);

    await expect(step!.run(ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    db.close();
  });

  it('fails with HOST_UNSUPPORTED for a free-host target', async () => {
    const db = openInMemory();
    const projectsRepo = new ProjectsRepo(db);
    const projectId = projectsRepo.create({ name: 'demo', folderPath: '/tmp/whatever' }).id;
    const targetsRepo = new TargetsRepo(db);
    targetsRepo.upsert({ projectId, kind: 'netlify', appName: 'demo' });
    const deps = makeDeps(db, { projectsRepo, targetsRepo });
    const [step] = buildMaintenanceJobDef(deps).build({});
    const ctx = fakeCtx('clean_disk', projectId);

    await expect(step!.run(ctx)).rejects.toMatchObject({ code: 'HOST_UNSUPPORTED' });
    db.close();
  });

  it('applies security updates and triggers a maintenance re-check', async () => {
    const db = openInMemory();
    const projectsRepo = new ProjectsRepo(db);
    const projectId = projectsRepo.create({ name: 'demo', folderPath: '/tmp/whatever' }).id;
    const targetsRepo = new TargetsRepo(db);
    targetsRepo.upsert({ projectId, kind: 'own_server', appName: 'demo', domain: 'demo.example.com', ip: '203.0.113.10', adminUser: 'deploy', sshPort: 22 });
    const session = queuedRemoteExec([bdSuccess({ rebootRequired: 'false' })]);
    let rechecked: string | undefined;
    const deps = makeDeps(db, {
      projectsRepo,
      targetsRepo,
      connectAsAdmin: () => Promise.resolve(session),
      runMaintenanceCheck: (pid) => {
        rechecked = pid;
        return Promise.resolve();
      },
    });
    const ctx = fakeCtx('apply_security_updates', projectId);
    const [step] = buildMaintenanceJobDef(deps).build({});
    await step!.run(ctx);

    expect(session.closed).toBe(true);
    expect(rechecked).toBe(projectId);
    expect(ctx.logs.some((l) => l.includes('Security updates applied'))).toBe(true);
    db.close();
  });

  it('cleans old releases, keeping the live one', async () => {
    const db = openInMemory();
    const projectsRepo = new ProjectsRepo(db);
    const projectId = projectsRepo.create({ name: 'demo', folderPath: '/tmp/whatever' }).id;
    const targetsRepo = new TargetsRepo(db);
    const target = targetsRepo.upsert({ projectId, kind: 'own_server', appName: 'demo', domain: 'demo.example.com', ip: '203.0.113.10', adminUser: 'deploy', sshPort: 22 });
    const releasesRepo = new ReleasesRepo(db);
    const live = releasesRepo.create({ projectId, targetId: target.id, releaseId: '20260101T000000Z', folderHash: 'h' });
    releasesRepo.setStatus(live.id, 'live');
    const session = queuedRemoteExec([]);
    const deps = makeDeps(db, { projectsRepo, targetsRepo, releasesRepo, connectAsAdmin: () => Promise.resolve(session) });
    const ctx = fakeCtx('clean_old_releases', projectId);
    const [step] = buildMaintenanceJobDef(deps).build({});
    await step!.run(ctx);

    expect(session.closed).toBe(true);
    expect(ctx.logs.some((l) => l.includes('Old releases cleaned up'))).toBe(true);
    db.close();
  });

  it('cancels the reboot when the user declines the confirmation', async () => {
    const db = openInMemory();
    const projectsRepo = new ProjectsRepo(db);
    const projectId = projectsRepo.create({ name: 'demo', folderPath: '/tmp/whatever' }).id;
    const targetsRepo = new TargetsRepo(db);
    targetsRepo.upsert({ projectId, kind: 'own_server', appName: 'demo', domain: 'demo.example.com', ip: '203.0.113.10', adminUser: 'deploy', sshPort: 22 });
    const session = queuedRemoteExec([]);
    const deps = makeDeps(db, { projectsRepo, targetsRepo, connectAsAdmin: () => Promise.resolve(session) });
    const ctx = fakeCtx('reboot_server', projectId, [false]);
    const [step] = buildMaintenanceJobDef(deps).build({});

    await expect(step!.run(ctx)).rejects.toMatchObject({ code: 'CANCELLED' });
    db.close();
  });

  it('reboots, waits for SSH to come back, and health-checks the site', async () => {
    const db = openInMemory();
    const projectsRepo = new ProjectsRepo(db);
    const projectId = projectsRepo.create({ name: 'demo', folderPath: '/tmp/whatever' }).id;
    const targetsRepo = new TargetsRepo(db);
    targetsRepo.upsert({
      projectId, kind: 'own_server', appName: 'demo', domain: 'demo.example.com', ip: '203.0.113.10',
      adminUser: 'deploy', sshPort: 22, siteUrl: 'https://demo.example.com',
    });
    const rebootSession = queuedRemoteExec([bdSuccess({ scheduledFor: '+1 minute' })]);
    const backUpSession = queuedRemoteExec([]);
    let calls = 0;
    let rechecked: string | undefined;
    const deps = makeDeps(db, {
      projectsRepo,
      targetsRepo,
      rebootPollMs: 1,
      rebootTimeoutMs: 50,
      connectAsAdmin: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve(rebootSession) : Promise.resolve(backUpSession);
      },
      httpProbe: { probe: () => Promise.resolve({ ok: true, status: 200 }) },
      runMaintenanceCheck: (pid) => {
        rechecked = pid;
        return Promise.resolve();
      },
    });
    const ctx = fakeCtx('reboot_server', projectId, [true]);
    const [step] = buildMaintenanceJobDef(deps).build({});
    await step!.run(ctx);

    expect(rebootSession.closed).toBe(true);
    expect(backUpSession.closed).toBe(true);
    expect(rechecked).toBe(projectId);
    expect(ctx.logs.some((l) => l.includes('back up'))).toBe(true);
    db.close();
  });
});
