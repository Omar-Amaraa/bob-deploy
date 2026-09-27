import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, AgentRunner, AgentTask } from '@bob-deploy/contracts';
import { openInMemory } from '../db/db.js';
import { ProjectsRepo } from '../db/repos/projects.js';
import { StepError, type CommandChange, type FileChange, type StepContext } from '../jobs/types.js';
import { buildAnalyseStep, describeStack, sharedStack } from './analyse.js';
import { buildDeployOwnServerJobDef, type DeployOwnServerDeps } from './deploy-own-server.js';

const VITE_SAMPLE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'agent',
  'src',
  'detect',
  '__samples__',
  'vite',
);

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface RecordingCtx extends StepContext {
  logs: string[];
  changes: (FileChange | CommandChange)[];
}

function recordingCtx(projectId: string): RecordingCtx {
  const logs: string[] = [];
  const changes: (FileChange | CommandChange)[] = [];
  return {
    jobId: 'job1',
    projectId,
    stepId: 'analyse',
    attempt: 1,
    signal: new AbortController().signal,
    inputs: {},
    secrets: new Map(),
    state: {},
    shared: {},
    logs,
    changes,
    log: (message) => logs.push(message),
    change: (change) => changes.push(change),
    ask: () => Promise.resolve(true),
    fail: (code, message) => {
      throw new StepError(code, message);
    },
  };
}

function bobRunner(events: AgentEvent[], seen: AgentTask[] = []): AgentRunner {
  return {
    async *run(task: AgentTask): AsyncIterable<AgentEvent> {
      await Promise.resolve();
      seen.push(task);
      for (const event of events) yield event;
    },
    cancel: () => Promise.resolve(),
  };
}

async function setup() {
  const db = openInMemory();
  const projectsRepo = new ProjectsRepo(db);
  const projectId = projectsRepo.create({ name: 'demo', folderPath: VITE_SAMPLE }).id;
  const dataDir = await mkdtemp(join(tmpdir(), 'bd-analyse-'));
  tempDirs.push(dataDir);
  return { projectsRepo, projectId, dataDir };
}

describe('analyse step (DEC-021)', () => {
  it('has Bob review even a confidently-detected project and shows his work live', async () => {
    const { projectsRepo, projectId, dataDir } = await setup();
    const tasks: AgentTask[] = [];
    const runner = bobRunner(
      [
        { type: 'message', text: 'Bob is reading `package.json`' },
        { type: 'command', cmd: 'ls', code: 0 },
        { type: 'message', text: 'This is a Vite site built into dist/.' },
        {
          type: 'result',
          ok: true,
          summary: 'ok',
          data: {
            type: 'static',
            framework: 'vite',
            buildCmd: 'npm run build',
            outputDir: 'dist',
            needsBackend: false,
          },
        },
      ],
      tasks,
    );
    const step = buildAnalyseStep({ projectsRepo, agentRunner: runner, dataDir, askBob: () => true });
    expect(step).toMatchObject({ key: 'analyse', kind: 'agent', name: 'Bob analyses your project' });

    const ctx = recordingCtx(projectId);
    await step.run(ctx);

    expect(tasks.map((t) => t.kind)).toEqual(['detect_stack']);
    expect(ctx.logs).toContain('Bob is reading `package.json`');
    expect(ctx.logs).toContain('This is a Vite site built into dist/.');
    expect(ctx.logs.at(-1)).toBe(
      "Bob's conclusion: this is a static website (vite): build with `npm run build`, serve the `dist` folder.",
    );
    expect(ctx.changes).toEqual([{ kind: 'command', cmd: 'ls', code: 0 }]);
    expect(sharedStack(ctx)).toMatchObject({ type: 'static', framework: 'vite' });
    expect(projectsRepo.get(projectId)?.stack).toMatchObject({ framework: 'vite' });
  });

  it('uses the built-in checks and says how to turn Bob on when Bob is not set up', async () => {
    const { projectsRepo, projectId, dataDir } = await setup();
    const tasks: AgentTask[] = [];
    const step = buildAnalyseStep({
      projectsRepo,
      agentRunner: bobRunner([], tasks),
      dataDir,
      askBob: () => false,
    });
    const ctx = recordingCtx(projectId);
    await step.run(ctx);
    expect(tasks).toHaveLength(0);
    expect(ctx.logs[0]).toMatch(/Bob isn't set up yet/);
    expect(ctx.logs.at(-1)).toMatch(/^Built-in check: this is a static website/);
    expect(sharedStack(ctx)?.type).toBe('static');
  });

  it('falls back to the built-in result and says so when Bob fails', async () => {
    const { projectsRepo, projectId, dataDir } = await setup();
    const runner = bobRunner([{ type: 'result', ok: false, summary: 'Bob ran out of credits.' }]);
    const step = buildAnalyseStep({ projectsRepo, agentRunner: runner, dataDir, askBob: () => true });
    const ctx = recordingCtx(projectId);
    await step.run(ctx);
    expect(ctx.logs).toContain(
      "Bob couldn't finish his review (Bob ran out of credits.), so the built-in result is used instead.",
    );
    expect(ctx.logs.at(-1)).toMatch(/^Built-in check:/);
  });

  it('is the first step of an own-server deploy', () => {
    const jobDef = buildDeployOwnServerJobDef({} as unknown as DeployOwnServerDeps);
    expect(jobDef.build({}).map((s) => `${s.key}:${s.kind}`)).toEqual([
      'analyse:agent',
      'bootstrap:script',
      'release:script',
    ]);
  });
});

describe('describeStack', () => {
  it('describes a node app in one sentence', () => {
    expect(
      describeStack({
        type: 'node',
        framework: 'nextjs',
        installCmd: 'npm ci',
        startCmd: 'npm start',
        runtimeVersion: '22',
        needsBackend: true,
      }),
    ).toBe('a Node.js app (nextjs): install with `npm ci`, start with `npm start`, Node.js 22');
  });
});
