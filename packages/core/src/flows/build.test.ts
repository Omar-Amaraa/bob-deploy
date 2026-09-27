import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StackInfo } from '@bob-deploy/contracts';
import { createStaging, FakeRunner, editAt, type FakeRunnerScript } from '@bob-deploy/agent';
import { openInMemory } from '../db/db.js';
import { ProjectsRepo } from '../db/repos/projects.js';
import { SnapshotsRepo } from '../db/repos/snapshots.js';
import { FakeClock } from '../testing/fake-clock.js';
import { StepError, type StepContext, type FileChange, type CommandChange } from '../jobs/types.js';
import { buildWithFixes } from './build.js';

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
  logs: { message: string; data?: Record<string, unknown> }[];
  changes: (FileChange | CommandChange)[];
}

function fakeCtx(): FakeCtx {
  const logs: FakeCtx['logs'] = [];
  const changes: FakeCtx['changes'] = [];
  return {
    jobId: 'job1',
    projectId: 'proj1',
    stepId: 'build',
    attempt: 1,
    signal: new AbortController().signal,
    inputs: {},
    secrets: new Map(),
    state: {},
    shared: {},
    logs,
    changes,
    log: (message, data) => logs.push({ message, data }),
    change: (change) => changes.push(change),
    ask: () => Promise.reject(new Error('ask() not expected in buildWithFixes tests')),
    fail: (code, message) => {
      throw new StepError(code, message);
    },
  };
}

// A real node check, run with no shell (runAllowed spawns argv directly): exits 0 once a `FIXED`
// marker file exists in the staging copy, 1 otherwise — standing in for a real build command that
// starts failing and gets fixed by an accepted Bob edit.
const CHECK_JS = "process.exit(require('fs').existsSync('FIXED') ? 0 : 1);\n";

async function makeProject(): Promise<{ projectDir: string; dataDir: string; stagingRoot: string }> {
  const projectDir = await makeTempDir('bd-project-');
  const dataDir = await makeTempDir('bd-data-');
  const stagingRoot = await makeTempDir('bd-staging-');
  await writeFile(join(projectDir, 'check.js'), CHECK_JS);
  await writeFile(join(projectDir, 'index.js'), 'console.log("hi");\n');
  return { projectDir, dataDir, stagingRoot };
}

const stack: StackInfo = {
  type: 'node',
  buildCmd: 'node check.js',
  needsBackend: false,
};

function seedProject(db: ReturnType<typeof openInMemory>, folderPath: string): string {
  return new ProjectsRepo(db).create({ name: 'demo', folderPath }).id;
}

describe('buildWithFixes', () => {
  it('succeeds after Bob fixes the build on the second attempt, snapshotting first and syncing only the accepted files', async () => {
    const { projectDir, dataDir, stagingRoot } = await makeProject();
    const staging = await createStaging(projectDir, stagingRoot);
    const db = openInMemory();
    const projectId = seedProject(db, projectDir);
    const snapshotsRepo = new SnapshotsRepo(db);
    const clock = new FakeClock();
    const ctx = fakeCtx();

    const script: FakeRunnerScript = {
      fix_build: [
        { events: [{ type: 'result', ok: false, summary: "couldn't figure it out" }] },
        {
          events: [
            {
              type: 'result',
              ok: true,
              summary: 'fixed',
              data: { fixed: true, summary: 'fixed', changedFiles: ['FIXED'], requestedCommands: [] },
            },
          ],
          edits: { [editAt(staging.dir, 'FIXED')]: '' },
        },
      ],
    };
    const runner = new FakeRunner(script);

    const result = await buildWithFixes({
      ctx,
      staging,
      projectDir,
      projectId,
      dataDir,
      stack,
      runner,
      redactor: { redact: (s) => s },
      snapshotsRepo,
      clock,
    });

    expect(result).toEqual({ ok: true, fixApplied: true, attempts: 2 });

    // Synced back: FIXED now lives in the real project folder.
    expect(await readFile(join(projectDir, 'FIXED'), 'utf8')).toBe('');
    // Only the gated/accepted file was synced — nothing else appeared.
    const entries = (await readdir(projectDir)).sort();
    expect(entries).toEqual(['FIXED', 'check.js', 'index.js']);

    // A snapshot of the pre-fix folder was taken before syncing back.
    const snapshots = snapshotsRepo.listForProject(projectId);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.reason).toBe('before Bob fixes');

    expect(ctx.changes).toContainEqual({ kind: 'file', path: 'FIXED', action: 'added' });

    db.close();
  });

  it('fails after exactly 3 attempts when Bob never fixes the build, leaving the project folder byte-identical', async () => {
    const { projectDir, dataDir, stagingRoot } = await makeProject();
    const originalIndexJs = await readFile(join(projectDir, 'index.js'), 'utf8');
    const staging = await createStaging(projectDir, stagingRoot);
    const db = openInMemory();
    const projectId = seedProject(db, projectDir);
    const snapshotsRepo = new SnapshotsRepo(db);
    const clock = new FakeClock();
    const ctx = fakeCtx();

    const neverFixes = { events: [{ type: 'result' as const, ok: false, summary: 'still broken' }] };
    const runner = new FakeRunner({ fix_build: [neverFixes, neverFixes, neverFixes] });

    const result = await buildWithFixes({
      ctx,
      staging,
      projectDir,
      projectId,
      dataDir,
      stack,
      runner,
      redactor: { redact: (s) => s },
      snapshotsRepo,
      clock,
    });

    expect(result).toEqual({ ok: false, fixApplied: false, attempts: 3 });

    // The project folder was never touched — no syncBack ever runs on the failure path.
    const entries = (await readdir(projectDir)).sort();
    expect(entries).toEqual(['check.js', 'index.js']);
    expect(await readFile(join(projectDir, 'index.js'), 'utf8')).toBe(originalIndexJs);
    expect(snapshotsRepo.listForProject(projectId)).toHaveLength(0);

    db.close();
  });

  it('reverts a malicious edit to .env while still accepting and syncing the legitimate fix, counted as one attempt', async () => {
    const { projectDir, dataDir, stagingRoot } = await makeProject();
    const staging = await createStaging(projectDir, stagingRoot);
    const db = openInMemory();
    const projectId = seedProject(db, projectDir);
    const snapshotsRepo = new SnapshotsRepo(db);
    const clock = new FakeClock();
    const ctx = fakeCtx();

    const runner = new FakeRunner({
      fix_build: [
        {
          events: [
            {
              type: 'result',
              ok: true,
              summary: 'fixed, and helpfully "cleaned up" your env file',
              data: { fixed: true, summary: 'fixed', changedFiles: ['FIXED', '.env'], requestedCommands: [] },
            },
          ],
          edits: {
            [editAt(staging.dir, 'FIXED')]: '',
            [editAt(staging.dir, '.env')]: 'STOLEN=1',
          },
        },
      ],
    });

    const result = await buildWithFixes({
      ctx,
      staging,
      projectDir,
      projectId,
      dataDir,
      stack,
      runner,
      redactor: { redact: (s) => s },
      snapshotsRepo,
      clock,
    });

    expect(result).toEqual({ ok: true, fixApplied: true, attempts: 1 });
    // The legitimate fix made it into the project...
    expect(await readFile(join(projectDir, 'FIXED'), 'utf8')).toBe('');
    // ...but the malicious .env write never did.
    const entries = (await readdir(projectDir)).sort();
    expect(entries).not.toContain('.env');
    expect(entries).toEqual(['FIXED', 'check.js', 'index.js']);
    // The malicious write never even enters the diff — walkFiles excludes .env* the same way
    // createStaging does, so there's nothing for the gate to see or reject in the first place,
    // which is a stronger guarantee than "rejected": it's structurally invisible to sync.
    expect(cumulativeDiffContainsEnv(ctx)).toBe(false);

    db.close();
  });
});

function cumulativeDiffContainsEnv(ctx: FakeCtx): boolean {
  return ctx.changes.some((c) => c.kind === 'file' && c.path === '.env');
}
