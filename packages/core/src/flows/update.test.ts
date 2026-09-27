import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeHttpProbe } from '@bob-deploy/ssh-playbooks';
import { FakeRunner } from '@bob-deploy/agent';
import { openInMemory } from '../db/db.js';
import { ProjectsRepo } from '../db/repos/projects.js';
import { TargetsRepo } from '../db/repos/targets.js';
import { ReleasesRepo } from '../db/repos/releases.js';
import { SnapshotsRepo } from '../db/repos/snapshots.js';
import { StepError, type StepContext } from '../jobs/types.js';
import { InMemoryVault } from './vault.js';
import { SECRET_NETLIFY_TOKEN } from '../account/secret-keys.js';
import { FakeHostProvider } from '../fakes/host-provider.js';
import { buildUpdateJobDef, type UpdateDeps } from './update.js';

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

function fakeCtx(projectId: string, answers: (string | boolean)[] = []): FakeCtx {
  const logs: string[] = [];
  const answerQueue = [...answers];
  return {
    jobId: 'job1',
    projectId,
    stepId: 'update',
    attempt: 1,
    signal: new AbortController().signal,
    inputs: { projectId },
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

function staticDetectRunner(): FakeRunner {
  return new FakeRunner({
    detect_stack: Array.from({ length: 5 }, () => ({
      events: [{ type: 'result' as const, ok: true, summary: 'static', data: { type: 'static', outputDir: '.', needsBackend: false } }],
    })),
  });
}

function makeDeps(db: ReturnType<typeof openInMemory>, overrides: Partial<UpdateDeps> = {}): UpdateDeps {
  return {
    projectsRepo: new ProjectsRepo(db),
    targetsRepo: new TargetsRepo(db),
    releasesRepo: new ReleasesRepo(db),
    snapshotsRepo: new SnapshotsRepo(db),
    vault: new InMemoryVault(),
    redactor: { redact: (s) => s },
    agentRunner: staticDetectRunner(),
    dataDir: '/tmp/bd-data',
    redact: (s) => s,
    providers: { netlify: new FakeHostProvider('netlify'), vercel: new FakeHostProvider('vercel') },
    httpProbe: new FakeHttpProbe({ 'fake.dev': [{ ok: true, status: 200 }] }),
    ...overrides,
  };
}

async function makeStaticProject(): Promise<string> {
  const dir = await makeTempDir('bd-project-');
  await writeFile(join(dir, 'index.html'), '<html>v1</html>');
  return dir;
}

describe('update', () => {
  it('fails with NOT_FOUND when the project has never been deployed', async () => {
    const db = openInMemory();
    const folderPath = await makeStaticProject();
    const projectId = new ProjectsRepo(db).create({ name: 'demo', folderPath }).id;
    const deps = makeDeps(db);
    const jobDef = buildUpdateJobDef(deps);
    const updateStep = jobDef.build({}).find((step) => step.key === 'update');
    const ctx = fakeCtx(projectId);

    await expect(updateStep!.run(ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    db.close();
  });

  it('asks to confirm and cancels when nothing changed since the last (identical) release', async () => {
    const db = openInMemory();
    const folderPath = await makeStaticProject();
    const projectsRepo = new ProjectsRepo(db);
    const projectId = projectsRepo.create({ name: 'demo', folderPath }).id;
    const targetsRepo = new TargetsRepo(db);
    const target = targetsRepo.upsert({ projectId, kind: 'netlify', appName: 'demo', siteUrl: 'https://demo.fake.dev', siteId: 'site1' });
    const releasesRepo = new ReleasesRepo(db);
    // Package the identical static folder up front to get the exact folderHash update.ts will compute.
    const { packageRelease } = await import('@bob-deploy/ssh-playbooks');
    const tmpTar = await makeTempDir('bd-hash-');
    const { folderHash } = await packageRelease(folderPath, 'static', join(tmpTar, 'x.tar.gz'));
    const r = releasesRepo.create({ projectId, targetId: target.id, releaseId: '20260101T000000Z', folderHash });
    releasesRepo.promoteToLive(projectId, r.id);

    const vault = new InMemoryVault();
    vault.setSecret(SECRET_NETLIFY_TOKEN, 'tok_abc');
    const deps = makeDeps(db, { projectsRepo, targetsRepo, releasesRepo, vault });
    const jobDef = buildUpdateJobDef(deps);
    const updateStep = jobDef.build({}).find((step) => step.key === 'update');
    const ctx = fakeCtx(projectId, [false]); // decline "release again anyway?"

    await expect(updateStep!.run(ctx)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(deps.projectsRepo.get(projectId)?.status).not.toBe('live');

    db.close();
  });

  it('proceeds with a redeploy when the user confirms releasing again despite no changes', async () => {
    const db = openInMemory();
    const folderPath = await makeStaticProject();
    const projectsRepo = new ProjectsRepo(db);
    const projectId = projectsRepo.create({ name: 'demo', folderPath }).id;
    const targetsRepo = new TargetsRepo(db);
    const target = targetsRepo.upsert({ projectId, kind: 'netlify', appName: 'demo', siteUrl: 'https://demo.fake.dev', siteId: 'site1' });
    const releasesRepo = new ReleasesRepo(db);
    const { packageRelease } = await import('@bob-deploy/ssh-playbooks');
    const tmpTar = await makeTempDir('bd-hash-');
    const { folderHash } = await packageRelease(folderPath, 'static', join(tmpTar, 'x.tar.gz'));
    const r = releasesRepo.create({ projectId, targetId: target.id, releaseId: '20260101T000000Z', folderHash });
    releasesRepo.promoteToLive(projectId, r.id);

    const vault = new InMemoryVault();
    vault.setSecret(SECRET_NETLIFY_TOKEN, 'tok_abc');
    const deps = makeDeps(db, { projectsRepo, targetsRepo, releasesRepo, vault });
    const jobDef = buildUpdateJobDef(deps);
    const updateStep = jobDef.build({}).find((step) => step.key === 'update');
    const ctx = fakeCtx(projectId, [true]); // confirm "release again anyway?"

    await updateStep!.run(ctx);
    expect(deps.projectsRepo.get(projectId)?.status).toBe('live');

    db.close();
  });
});
