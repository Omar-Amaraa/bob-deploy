import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Diagnosis } from '@bob-deploy/contracts';
import { FakeHttpProbe, type ExecResult, type RemoteExec } from '@bob-deploy/ssh-playbooks';
import { FakeRunner } from '@bob-deploy/agent';
import { openInMemory } from '../db/db.js';
import { ProjectsRepo } from '../db/repos/projects.js';
import { TargetsRepo } from '../db/repos/targets.js';
import { ReleasesRepo } from '../db/repos/releases.js';
import { SnapshotsRepo } from '../db/repos/snapshots.js';
import { JobsRepo } from '../db/repos/jobs.js';
import { ProblemsRepo } from '../db/repos/problems.js';
import { StepError, type StepContext } from '../jobs/types.js';
import { InMemoryVault } from './vault.js';
import { SECRET_NETLIFY_TOKEN } from '../account/secret-keys.js';
import { FakeHostProvider } from '../fakes/host-provider.js';
import { buildDiagnoseJobDef, type DiagnoseDeps } from './diagnose.js';

const tempDirs: string[] = [];
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface FakeCtx extends StepContext {
  logs: string[];
}

function fakeCtx(projectId: string, jobId: string, answers: (string | boolean)[] = []): FakeCtx {
  const logs: string[] = [];
  const answerQueue = [...answers];
  return {
    jobId,
    projectId,
    stepId: 'diagnose',
    attempt: 1,
    signal: new AbortController().signal,
    inputs: { note: 'The site looks down.' },
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

function diagnoseRunner(data: Diagnosis): FakeRunner {
  return new FakeRunner({
    diagnose: [{ events: [{ type: 'result', ok: true, summary: data.summary, data }] }],
  });
}

function makeDeps(db: ReturnType<typeof openInMemory>, overrides: Partial<DiagnoseDeps> = {}): DiagnoseDeps {
  return {
    projectsRepo: new ProjectsRepo(db),
    targetsRepo: new TargetsRepo(db),
    releasesRepo: new ReleasesRepo(db),
    snapshotsRepo: new SnapshotsRepo(db),
    jobsRepo: new JobsRepo(db),
    problemsRepo: new ProblemsRepo(db),
    vault: new InMemoryVault(),
    redactor: { redact: (s) => s },
    redact: (s) => s,
    agentRunner: diagnoseRunner({
      summary: 'unknown',
      likelyCause: 'unknown',
      userMessage: 'Something went wrong.',
      proposedAction: 'none',
    }),
    dataDir: '/tmp/bd-data',
    providers: { netlify: new FakeHostProvider('netlify'), vercel: new FakeHostProvider('vercel') },
    httpProbe: new FakeHttpProbe({ 'fake.dev': [{ ok: true, status: 200 }] }),
    ...overrides,
  };
}

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, ...overrides };
}
function queuedRemoteExec(responses: ExecResult[]): RemoteExec & { closed: boolean } {
  const queue = [...responses];
  const handle = {
    closed: false,
    exec(): Promise<ExecResult> {
      return Promise.resolve(queue.shift() ?? execResult());
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

async function makeStaticProject(): Promise<string> {
  const dir = await makeTempDir('bd-project-');
  await writeFile(join(dir, 'index.html'), '<html>v1</html>');
  return dir;
}

/** problems.job_id is a real FK against jobs(id), so every test needs an actual job row behind
 * the diagnose ctx.jobId it uses — this creates one the same way JobEngine.start() would. */
function makeDiagnoseJob(db: ReturnType<typeof openInMemory>, projectId: string): string {
  return new JobsRepo(db).create({ projectId, kind: 'diagnose' }, []).job.id;
}

describe('diagnose', () => {
  it('fails with BOB_BAD_OUTPUT when the diagnosis does not parse', async () => {
    const db = openInMemory();
    const projectId = new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/whatever' }).id;
    const deps = makeDeps(db, { agentRunner: new FakeRunner({ diagnose: [{ events: [{ type: 'result', ok: true, summary: 'x', data: { bogus: true } }] }] }) });
    const jobId = makeDiagnoseJob(db, projectId);
    const [step] = buildDiagnoseJobDef(deps).build({});
    const ctx = fakeCtx(projectId, jobId);

    await expect(step!.run(ctx)).rejects.toMatchObject({ code: 'BOB_BAD_OUTPUT' });
    db.close();
  });

  it('logs the message and leaves the problem unresolved when Bob proposes nothing actionable', async () => {
    const db = openInMemory();
    const problemsRepo = new ProblemsRepo(db);
    const projectId = new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/whatever' }).id;
    const deps = makeDeps(db, {
      problemsRepo,
      agentRunner: diagnoseRunner({
        summary: 'Nothing found', likelyCause: 'n/a', userMessage: 'Everything looks fine.', proposedAction: 'none',
      }),
    });
    const jobId = makeDiagnoseJob(db, projectId);
    const [step] = buildDiagnoseJobDef(deps).build({});
    const ctx = fakeCtx(projectId, jobId);
    await step!.run(ctx);

    expect(ctx.logs.some((l) => l.includes('Everything looks fine'))).toBe(true);
    expect(problemsRepo.listForProject(projectId)[0]?.resolvedAt).toBeUndefined();
    db.close();
  });

  it('does not run anything and leaves the problem open when the user declines the suggested fix', async () => {
    const db = openInMemory();
    const problemsRepo = new ProblemsRepo(db);
    const projectId = new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/whatever' }).id;
    const deps = makeDeps(db, {
      problemsRepo,
      agentRunner: diagnoseRunner({
        summary: 'A typo in the config', likelyCause: 'bad config', userMessage: 'Found a fixable issue.',
        proposedAction: 'update_with_fix', fixInstructions: 'Fix the typo.',
      }),
    });
    const jobId = makeDiagnoseJob(db, projectId);
    const [step] = buildDiagnoseJobDef(deps).build({});
    const ctx = fakeCtx(projectId, jobId, [false]);
    await step!.run(ctx);

    expect(problemsRepo.listForProject(projectId)[0]?.resolvedAt).toBeUndefined();
    db.close();
  });

  it('runs the update flow inline and resolves the problem when the user accepts the suggested fix', async () => {
    const db = openInMemory();
    const problemsRepo = new ProblemsRepo(db);
    const projectsRepo = new ProjectsRepo(db);
    const folderPath = await makeStaticProject();
    const projectId = projectsRepo.create({ name: 'demo', folderPath }).id;
    const targetsRepo = new TargetsRepo(db);
    targetsRepo.upsert({ projectId, kind: 'netlify', appName: 'demo', siteUrl: 'https://demo.fake.dev', siteId: 'site1' });
    const vault = new InMemoryVault();
    vault.setSecret(SECRET_NETLIFY_TOKEN, 'tok_abc');

    const staticDetectRunner = new FakeRunner({
      diagnose: [{
        events: [{
          type: 'result', ok: true, summary: 'fix',
          data: { summary: 'A typo', likelyCause: 'bad config', userMessage: 'Found it.', proposedAction: 'update_with_fix', fixInstructions: 'Fix it.' },
        }],
      }],
      detect_stack: [{ events: [{ type: 'result', ok: true, summary: 'static', data: { type: 'static', outputDir: '.', needsBackend: false } }] }],
    });

    const deps = makeDeps(db, { problemsRepo, projectsRepo, targetsRepo, vault, agentRunner: staticDetectRunner });
    const jobId = makeDiagnoseJob(db, projectId);
    const [step] = buildDiagnoseJobDef(deps).build({});
    const ctx = fakeCtx(projectId, jobId, [true]);
    await step!.run(ctx);

    expect(problemsRepo.listForProject(projectId)[0]?.resolvedAt).toBeDefined();
    expect(projectsRepo.get(projectId)?.status).toBe('live');
    db.close();
  });

  it('rolls back inline and resolves the problem when the user accepts a rollback suggestion', async () => {
    const db = openInMemory();
    const problemsRepo = new ProblemsRepo(db);
    const projectsRepo = new ProjectsRepo(db);
    const projectId = projectsRepo.create({ name: 'demo', folderPath: '/tmp/whatever' }).id;
    projectsRepo.setStack(projectId, { type: 'static', outputDir: '.', needsBackend: false });
    const targetsRepo = new TargetsRepo(db);
    const target = targetsRepo.upsert({ projectId, kind: 'own_server', appName: 'demo', domain: 'demo.example.com', ip: '203.0.113.10', adminUser: 'deploy', sshPort: 22, portA: 3001, portB: 3002 });
    const releasesRepo = new ReleasesRepo(db);
    const oldLive = releasesRepo.create({ projectId, targetId: target.id, releaseId: '20260101T000000Z', folderHash: 'a' });
    releasesRepo.setStatus(oldLive.id, 'live');
    const previous = releasesRepo.create({ projectId, targetId: target.id, releaseId: '20260102T000000Z', folderHash: 'b' });
    releasesRepo.setStatus(previous.id, 'previous');

    // Relies on queuedRemoteExec's success-by-default fallback (same convention as
    // maintenance.test.ts's clean_old_releases case) since this session serves both the
    // diagnose step's own journal/log-tail gathering AND rollbackTo's static-site calls.
    const session = queuedRemoteExec([]);
    const deps = makeDeps(db, {
      problemsRepo,
      projectsRepo,
      targetsRepo,
      releasesRepo,
      connectAsAdmin: () => Promise.resolve(session),
      agentRunner: diagnoseRunner({
        summary: 'Bad release', likelyCause: 'broken deploy', userMessage: 'This release looks broken.', proposedAction: 'rollback',
      }),
    });
    const jobId = makeDiagnoseJob(db, projectId);
    const [step] = buildDiagnoseJobDef(deps).build({});
    const ctx = fakeCtx(projectId, jobId, [true]);
    await step!.run(ctx);

    expect(session.closed).toBe(true);
    expect(problemsRepo.listForProject(projectId)[0]?.resolvedAt).toBeDefined();
    db.close();
  });
});
