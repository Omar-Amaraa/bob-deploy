import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunner, OwnServerInputs } from '@bob-deploy/contracts';
import { FakeDnsResolver, type ExecResult, type RemoteExec } from '@bob-deploy/ssh-playbooks';
import { openInMemory } from '../db/db.js';
import { ProjectsRepo } from '../db/repos/projects.js';
import { TargetsRepo } from '../db/repos/targets.js';
import { ReleasesRepo } from '../db/repos/releases.js';
import { SnapshotsRepo } from '../db/repos/snapshots.js';
import { StepError, type StepContext } from '../jobs/types.js';
import { JOB_SECRET_ENV_JSON, JOB_SECRET_ROOT_PASSWORD } from '../jobs/job-secret-keys.js';
import { InMemoryVault } from './vault.js';
import { sshPrivateKeySecretKey, projectEnvSecretKey } from '../account/secret-keys.js';
import { buildDeployOwnServerJobDef, type DeployOwnServerDeps } from './deploy-own-server.js';

const tempDirs: string[] = [];
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, ...overrides };
}
function bdSuccess(fields: Record<string, string>): ExecResult {
  return execResult({ stdout: `BD_RESULT ${JSON.stringify({ ok: true, ...fields })}\n` });
}

/** A minimal ordered-response RemoteExec, matching bootstrap.steps.test.ts's own convention:
 * each step run against it makes a small, fixed, known sequence of exec() calls. */
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
  answers: (string | boolean)[];
}

function fakeCtx(inputs: unknown, projectId = 'proj1', answers: (string | boolean)[] = []): FakeCtx {
  const logs: string[] = [];
  const answerQueue = [...answers];
  const ownServerInputs = inputs as Partial<OwnServerInputs>;
  const rootPassword = ownServerInputs.rootAuth?.method === 'password' ? ownServerInputs.rootAuth.password : '';
  // Matches what the deploy:start IPC handler does: strips secret fields out of the persisted
  // inputs and hands them over here instead (see jobs/job-secret-keys.ts).
  const secrets: Map<string, string> = new Map([
    [JOB_SECRET_ROOT_PASSWORD, rootPassword],
    [JOB_SECRET_ENV_JSON, JSON.stringify(ownServerInputs.env ?? {})],
  ]);
  return {
    jobId: 'job1',
    projectId,
    stepId: 'step',
    attempt: 1,
    signal: new AbortController().signal,
    inputs,
    secrets,
    state: {},
    shared: {},
    logs,
    answers,
    log: (message) => logs.push(message),
    change: () => undefined,
    ask: () => Promise.resolve(answerQueue.shift() ?? true),
    fail: (code, message) => {
      throw new StepError(code, message);
    },
  };
}

function makeDeps(db: ReturnType<typeof openInMemory>, overrides: Partial<DeployOwnServerDeps> = {}): DeployOwnServerDeps {
  return {
    projectsRepo: new ProjectsRepo(db),
    targetsRepo: new TargetsRepo(db),
    releasesRepo: new ReleasesRepo(db),
    snapshotsRepo: new SnapshotsRepo(db),
    vault: new InMemoryVault(),
    redactor: { redact: (s) => s },
    agentRunner: {} as AgentRunner, // unused by bootstrapStep
    dataDir: '/tmp/bd-data',
    redact: (s) => s,
    ...overrides,
  };
}

const baseInputs: OwnServerInputs = {
  domain: 'example.com',
  useSslipFallback: true,
  serverIp: '203.0.113.10',
  sshPort: 22,
  rootUser: 'root',
  rootAuth: { method: 'password', password: 'root-pw' },
  adminUser: 'deploy',
  acmeEmail: 'me@example.com',
  env: { NODE_ENV: 'production' },
};

describe('deploy_own_server — bootstrap step', () => {
  it('hardens the server, stores the admin key and env in the vault, and records the target', async () => {
    const db = openInMemory();
    const projectId = new ProjectsRepo(db).create({ name: 'demo', folderPath: await makeTempDir('bd-project-') }).id;
    // create_admin makes exactly one exec() call on the still-open rootSession.
    const rootSession = queuedRemoteExec([bdSuccess({ user: 'deploy', created: 'true' })]);
    const adminSession = queuedRemoteExec([
      bdSuccess({ ufw: 'active', fail2ban: 'active' }), // 30-firewall.sh
      execResult({ stdout: '/tmp/bd-helpers.Tt55Uu66\n' }), // mktemp (uploadHelpers)
      execResult(), // sudo install into /usr/local/lib/bob-deploy/bin
      execResult(), // rm -rf the temp dir
      bdSuccess({ helperCount: '5' }), // 40-install-helpers.sh
    ]);

    const deps = makeDeps(db, {
      reachServer: () =>
        Promise.resolve({
          ok: true,
          data: { session: rootSession as never, fingerprint: 'SHA256:abc', rootUser: 'root', os: 'linux', arch: 'x86_64' },
        }),
      lockDown: () => Promise.resolve({ ok: true, data: { adminSession: adminSession as never, backupDir: '/root/.bd-backup' } }),
      dns: new FakeDnsResolver({ 'example.com': ['203.0.113.10'] }),
    });

    const jobDef = buildDeployOwnServerJobDef(deps);
    const bootstrapStep = jobDef.build({}).find((step) => step.key === 'bootstrap');
    const ctx = fakeCtx(baseInputs, projectId);
    await bootstrapStep!.run(ctx);

    expect(ctx.shared.bootstrapped).toBe(true);
    expect(ctx.shared.domain).toBe('example.com');
    expect(rootSession.closed).toBe(true);
    expect(adminSession.closed).toBe(true);

    const target = deps.targetsRepo.getByProjectId(projectId);
    expect(target).toMatchObject({
      kind: 'own_server',
      domain: 'example.com',
      ip: '203.0.113.10',
      adminUser: 'deploy',
      hostKeyFingerprint: 'SHA256:abc',
    });
    // From the project's name ('demo'), not its UUID.
    expect(target?.appName).toBe('demo');
    expect(deps.vault.getSecret(sshPrivateKeySecretKey(target!.id))).toContain('PRIVATE KEY');
    expect(deps.vault.getSecret(projectEnvSecretKey(projectId))).toBe(JSON.stringify(baseInputs.env));

    db.close();
  });

  it('fails with DNS_MISMATCH and closes the session when the domain does not point at the server', async () => {
    const db = openInMemory();
    new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/whatever' });
    const rootSession = queuedRemoteExec([]);
    const deps = makeDeps(db, {
      reachServer: () =>
        Promise.resolve({
          ok: true,
          data: { session: rootSession as never, fingerprint: 'SHA256:abc', rootUser: 'root', os: 'linux', arch: 'x86_64' },
        }),
      dns: new FakeDnsResolver({ 'not-pointed-here.example.com': ['198.51.100.1'] }),
    });
    const jobDef = buildDeployOwnServerJobDef(deps);
    const bootstrapStep = jobDef.build({}).find((step) => step.key === 'bootstrap');
    const ctx = fakeCtx({ ...baseInputs, useSslipFallback: false, domain: 'not-pointed-here.example.com' });

    await expect(bootstrapStep!.run(ctx)).rejects.toMatchObject({ code: 'DNS_MISMATCH' });
    expect(rootSession.closed).toBe(true);
    expect(deps.targetsRepo.getByProjectId('proj1')).toBeUndefined();

    db.close();
  });

  it('asks the user to verify an unrecognized host key and aborts the connection if they decline', async () => {
    const db = openInMemory();
    new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/whatever' });
    let onUnknownHostKeyCb: ((fp: string) => Promise<boolean>) | undefined;
    const deps = makeDeps(db, {
      reachServer: (input) => {
        onUnknownHostKeyCb = input.onUnknownHostKey;
        return Promise.resolve({ ok: false, code: 'SSH_HOSTKEY_REJECTED', message: 'rejected' });
      },
    });
    const jobDef = buildDeployOwnServerJobDef(deps);
    const bootstrapStep = jobDef.build({}).find((step) => step.key === 'bootstrap');
    const ctx = fakeCtx(baseInputs, 'proj1', [false]);

    await expect(bootstrapStep!.run(ctx)).rejects.toMatchObject({ code: 'SSH_HOSTKEY_REJECTED' });
    expect(await onUnknownHostKeyCb?.('SHA256:zzz')).toBe(false);

    db.close();
  });
});

describe('deploy_own_server — release step guards', () => {
  it('fails with NOT_FOUND if the bootstrap target is missing (job state got corrupted)', async () => {
    const db = openInMemory();
    new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/whatever' });
    const deps = makeDeps(db);
    const jobDef = buildDeployOwnServerJobDef(deps);
    const releaseStep = jobDef.build({}).find((step) => step.key === 'release');
    const ctx = fakeCtx(baseInputs);
    ctx.shared.targetId = 'does-not-exist';

    await expect(releaseStep!.run(ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    db.close();
  });
});

describe('deploy_own_server — onFinalFailure', () => {
  it('always reports "failed" — a first deploy never has a previous release to roll back to', async () => {
    const db = openInMemory();
    const deps = makeDeps(db);
    const jobDef = buildDeployOwnServerJobDef(deps);
    const status = await jobDef.onFinalFailure?.({ jobId: 'j1', projectId: 'proj1', inputs: baseInputs });
    expect(status).toBe('failed');
    db.close();
  });
});
