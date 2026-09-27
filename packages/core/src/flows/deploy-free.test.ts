import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FreeHostInputs } from '@bob-deploy/contracts';
import { FakeHttpProbe } from '@bob-deploy/ssh-playbooks';
import { FakeRunner } from '@bob-deploy/agent';
import { openInMemory } from '../db/db.js';
import { ProjectsRepo } from '../db/repos/projects.js';
import { TargetsRepo } from '../db/repos/targets.js';
import { SnapshotsRepo } from '../db/repos/snapshots.js';
import { StepError, type StepContext } from '../jobs/types.js';
import { InMemoryVault } from './vault.js';
import { SECRET_NETLIFY_TOKEN } from '../account/secret-keys.js';
import { FakeHostProvider } from '../fakes/host-provider.js';
import { buildDeployFreeJobDef, type DeployFreeDeps } from './deploy-free.js';

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

function fakeCtx(inputs: unknown, projectId: string, answers: (string | boolean)[] = []): FakeCtx {
  const logs: string[] = [];
  const answerQueue = [...answers];
  return {
    jobId: 'job1',
    projectId,
    stepId: 'deploy',
    attempt: 1,
    signal: new AbortController().signal,
    inputs,
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

/** A built site like Vite's dist/: index.html at the root, scripts/styles/images under assets/. */
async function makeProjectWithAssets(): Promise<string> {
  const dir = await makeTempDir('bd-project-');
  await writeFile(join(dir, 'index.html'), '<html><head><script src="/assets/app.js"></script></head></html>');
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'assets', 'app.js'), 'document.body.textContent = "hi";');
  await writeFile(join(dir, 'assets', 'style.css'), 'body { color: red; }');
  return dir;
}

async function makeStaticProject(): Promise<string> {
  const dir = await makeTempDir('bd-project-');
  await writeFile(join(dir, 'index.html'), '<html><body>hi</body></html>');
  return dir;
}

/** A plain index.html-only project is only a 0.5-confidence heuristic match (below the 0.9
 * threshold), so detectStackStep always consults Bob for it — this fake answers with the obvious
 * static classification, matching what a real Bob call would confirm anyway. */
function staticDetectRunner(): FakeRunner {
  return new FakeRunner({
    detect_stack: [
      {
        events: [
          {
            type: 'result',
            ok: true,
            summary: 'static site',
            data: { type: 'static', outputDir: '.', needsBackend: false },
          },
        ],
      },
    ],
  });
}

function makeDeps(db: ReturnType<typeof openInMemory>, overrides: Partial<DeployFreeDeps> = {}): DeployFreeDeps {
  return {
    projectsRepo: new ProjectsRepo(db),
    targetsRepo: new TargetsRepo(db),
    snapshotsRepo: new SnapshotsRepo(db),
    vault: new InMemoryVault(),
    redactor: { redact: (s) => s },
    agentRunner: staticDetectRunner(),
    dataDir: '/tmp/bd-data',
    providers: { netlify: new FakeHostProvider('netlify'), vercel: new FakeHostProvider('vercel') },
    httpProbe: new FakeHttpProbe({ 'fake.dev': [{ ok: true, status: 200 }] }),
    ...overrides,
  };
}

const inputs: FreeHostInputs = { host: 'netlify', siteName: 'my-app', env: {} };

describe('deploy_free', () => {
  it('deploys a static site end to end: detects the stack, deploys, health-checks, and marks the project live', async () => {
    const db = openInMemory();
    const folderPath = await makeStaticProject();
    const projectId = new ProjectsRepo(db).create({ name: 'demo', folderPath }).id;
    const vault = new InMemoryVault();
    vault.setSecret(SECRET_NETLIFY_TOKEN, 'tok_abc');
    const deps = makeDeps(db, { vault });

    const jobDef = buildDeployFreeJobDef(deps);
    const deployStep = jobDef.build({}).find((step) => step.key === 'deploy');
    const ctx = fakeCtx(inputs, projectId);
    await deployStep!.run(ctx);

    const target = deps.targetsRepo.getByProjectId(projectId);
    expect(target).toMatchObject({ kind: 'netlify', siteUrl: 'https://my-app.fake.dev' });
    expect(deps.projectsRepo.get(projectId)?.status).toBe('live');
    expect(ctx.logs.some((l) => l.includes('Deployed successfully'))).toBe(true);

    db.close();
  });

  it('builds a static framework project before uploading its output', async () => {
    const db = openInMemory();
    const folderPath = await makeStaticProject();
    // A build script with no recognised framework is below the heuristic threshold, so the stack
    // (and its build command) comes from Bob's answer below.
    await writeFile(join(folderPath, 'package.json'), JSON.stringify({ name: 'built-demo', scripts: { build: 'node --version' } }));
    const projectId = new ProjectsRepo(db).create({ name: 'built-demo', folderPath }).id;
    const vault = new InMemoryVault();
    vault.setSecret(SECRET_NETLIFY_TOKEN, 'tok_abc');
    const runner = new FakeRunner({
      detect_stack: [
        {
          events: [
            {
              type: 'result',
              ok: true,
              summary: 'static project with build',
              data: {
                type: 'static',
                framework: 'test',
                buildCmd: 'node --version',
                outputDir: '.',
                needsBackend: false,
              },
            },
          ],
        },
      ],
    });
    const deps = makeDeps(db, { vault, agentRunner: runner });

    const deployStep = buildDeployFreeJobDef(deps).build({}).find((step) => step.key === 'deploy');
    const ctx = fakeCtx(inputs, projectId);
    await deployStep!.run(ctx);

    expect(ctx.logs).toContain('Running node --version.');
    expect(ctx.logs).toContain('Build output is ready in the project root.');
    expect(deps.projectsRepo.get(projectId)?.status).toBe('live');
    db.close();
  });

  it('fails with HOST_AUTH_FAILED when no token has been connected for the host', async () => {
    const db = openInMemory();
    const folderPath = await makeStaticProject();
    const projectId = new ProjectsRepo(db).create({ name: 'demo', folderPath }).id;
    const deps = makeDeps(db); // no token set in the vault

    const jobDef = buildDeployFreeJobDef(deps);
    const deployStep = jobDef.build({}).find((step) => step.key === 'deploy');
    const ctx = fakeCtx(inputs, projectId);

    await expect(deployStep!.run(ctx)).rejects.toMatchObject({ code: 'HOST_AUTH_FAILED' });
    expect(deps.projectsRepo.get(projectId)?.status).not.toBe('live');

    db.close();
  });

  it('asks to redirect to own_server and cancels when the detected stack needsBackend', async () => {
    const db = openInMemory();
    const dir = await makeTempDir('bd-project-');
    // A Next.js app (non-static-export) is a 0.9-confidence heuristic match with needsBackend:true
    // — high enough that detectStackStep never consults Bob, keeping this deterministic without a
    // scripted agentRunner.
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: { next: '^14.0.0' }, scripts: { build: 'next build', start: 'next start' } }),
    );
    const projectId = new ProjectsRepo(db).create({ name: 'demo', folderPath: dir }).id;
    const vault = new InMemoryVault();
    vault.setSecret(SECRET_NETLIFY_TOKEN, 'tok_abc');
    const deps = makeDeps(db, { vault });

    const jobDef = buildDeployFreeJobDef(deps);
    const deployStep = jobDef.build({}).find((step) => step.key === 'deploy');
    const ctx = fakeCtx(inputs, projectId, ['own_server']);

    await expect(deployStep!.run(ctx)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(deps.projectsRepo.get(projectId)?.status).not.toBe('live');
    expect(deps.targetsRepo.getByProjectId(projectId)).toBeUndefined();

    db.close();
  });

  it('fails instead of reporting success when the host serves the page but dropped the assets/ folder', async () => {
    const db = openInMemory();
    const folderPath = await makeProjectWithAssets();
    const projectId = new ProjectsRepo(db).create({ name: 'blank', folderPath }).id;
    const vault = new InMemoryVault();
    vault.setSecret(SECRET_NETLIFY_TOKEN, 'tok_abc');
    // Order matters: FakeHttpProbe matches the first pattern the URL contains.
    const httpProbe = new FakeHttpProbe({
      'fake.dev/assets/': [
        { ok: false, status: 404 },
        { ok: false, status: 404 },
      ],
      'fake.dev': [{ ok: true, status: 200 }],
    });
    const deps = makeDeps(db, { vault, httpProbe });

    const deployStep = buildDeployFreeJobDef(deps).build({}).find((step) => step.key === 'deploy');
    const ctx = fakeCtx(inputs, projectId);

    await expect(deployStep!.run(ctx)).rejects.toMatchObject({
      code: 'HEALTHCHECK_FAILED',
      message: expect.stringContaining('assets/app.js') as unknown,
    });
    expect(deps.projectsRepo.get(projectId)?.status).not.toBe('live');
    expect(httpProbe.callLog).toEqual(
      expect.arrayContaining(['https://my-app.fake.dev/assets/app.js', 'https://my-app.fake.dev/assets/style.css']),
    );

    db.close();
  });

  it('marks the site live once the built assets are confirmed online', async () => {
    const db = openInMemory();
    const folderPath = await makeProjectWithAssets();
    const projectId = new ProjectsRepo(db).create({ name: 'full', folderPath }).id;
    const vault = new InMemoryVault();
    vault.setSecret(SECRET_NETLIFY_TOKEN, 'tok_abc');
    const httpProbe = new FakeHttpProbe({
      'fake.dev/assets/': [
        { ok: true, status: 200 },
        { ok: true, status: 200 },
      ],
      'fake.dev': [{ ok: true, status: 200 }],
    });
    const deps = makeDeps(db, { vault, httpProbe });

    const deployStep = buildDeployFreeJobDef(deps).build({}).find((step) => step.key === 'deploy');
    const ctx = fakeCtx(inputs, projectId);
    await deployStep!.run(ctx);

    expect(deps.projectsRepo.get(projectId)?.status).toBe('live');
    expect(ctx.logs).toContain('Checked 2 built files online; all are being served.');

    db.close();
  });
});
