import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTask } from '@bob-deploy/contracts';
import { BobShellRunner, type BobRedactor } from './runner.js';
import { makeFakeSpawn } from './test-fake-spawn.js';
import { RESULT_BEGIN, RESULT_END } from '../prompts/output-contract.js';
import { BOB_KEY_ENV_VARS } from './env.js';

const cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeStagingDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bd-agent-bobrunner-'));
  cleanupDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(join(dir, rel), content);
  }
  return dir;
}

/** resolveBobBinary fs.access-checks a configured binaryPath, so tests need a real executable file
 * on disk (its contents are never run — the fake spawn intercepts the actual invocation). */
async function makeFakeBobBinary(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bd-agent-bobbin-'));
  cleanupDirs.push(dir);
  const path = join(dir, 'bob');
  await writeFile(path, '#!/bin/sh\necho unused\n');
  await chmod(path, 0o755);
  return path;
}

function passthroughRedactor(): BobRedactor {
  return {
    redact: (t) => t,
    assertNoSecrets: () => undefined,
  };
}

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    kind: 'detect_stack',
    cwd: '/tmp/unused',
    instructions: '',
    context: {},
    allowedCommands: [],
    maxTurns: 1,
    timeoutMs: 5000,
    ...overrides,
  };
}

async function collect(iterable: AsyncIterable<unknown>) {
  const out = [];
  for await (const e of iterable) out.push(e);
  return out;
}

const validStackResult = `${RESULT_BEGIN}\n${JSON.stringify({ type: 'static', needsBackend: false })}\n${RESULT_END}`;

describe('BobShellRunner', () => {
  it('spawns with exactly the scrubbed env keys, the api key only under BOB_KEY_ENV_VARS, and cwd = staging', async () => {
    const { spawnFn, calls } = makeFakeSpawn([{ stdout: validStackResult, code: 0 }]);
    const cwd = await makeStagingDir();
    const binaryPath = await makeFakeBobBinary();
    const runner = new BobShellRunner({
      getApiKey: () => Promise.resolve('sk-runner-secret'),
      config: { keyType: 'inference', licenseAccepted: true, binaryPath },
      bobHome: '/tmp/bobhome',
      redactor: passthroughRedactor(),
      clock: { now: () => 0 },
      spawnFn,
    });
    await collect(runner.run(task({ cwd })));

    // binaryPath is configured, so resolveBobBinary resolves it via fs.access without spawning
    // anything (see resolve.test.ts) — the one fake spawn call recorded here is the real bob
    // invocation itself.
    const bobCall = calls[calls.length - 1];
    expect(bobCall.options.cwd).toBe(cwd);
    expect(bobCall.args).toEqual(
      expect.arrayContaining(['run', '--format', 'stream-json', '--workspace', cwd, '--trust']),
    );
    expect(bobCall.stdinWritten).toContain('Determine this project');
    expect(Object.keys(bobCall.options.env ?? {}).sort()).toEqual(expect.arrayContaining(['PATH', 'HOME', ...BOB_KEY_ENV_VARS]));
    for (const key of BOB_KEY_ENV_VARS) {
      expect((bobCall.options.env as Record<string, string>)[key]).toBe('sk-runner-secret');
    }
    const nonKeyValues = Object.entries(bobCall.options.env ?? {})
      .filter(([k]) => !BOB_KEY_ENV_VARS.includes(k))
      .map(([, v]) => v);
    expect(nonKeyValues.every((v) => v !== 'sk-runner-secret')).toBe(true);
  });

  it('yields a result event with the parsed data on a valid response', async () => {
    const { spawnFn } = makeFakeSpawn([{ stdout: validStackResult, code: 0 }]);
    const cwd = await makeStagingDir();
    const binaryPath = await makeFakeBobBinary();
    const runner = new BobShellRunner({
      getApiKey: () => Promise.resolve('sk-x'),
      config: { keyType: 'inference', licenseAccepted: true, binaryPath },
      bobHome: '/tmp/bobhome',
      redactor: passthroughRedactor(),
      clock: { now: () => 0 },
      spawnFn,
    });
    const events = await collect(runner.run(task({ cwd })));
    const result = events[events.length - 1] as { type: string; ok: boolean; data: unknown };
    expect(result.type).toBe('result');
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ type: 'static', needsBackend: false });
  });

  it('retries once on invalid output, then succeeds if the retry parses', async () => {
    const badOutput = `${RESULT_BEGIN}\nnot json\n${RESULT_END}`;
    const { spawnFn, calls } = makeFakeSpawn([
      { stdout: badOutput, code: 0 },
      { stdout: validStackResult, code: 0 },
    ]);
    const cwd = await makeStagingDir();
    const binaryPath = await makeFakeBobBinary();
    const runner = new BobShellRunner({
      getApiKey: () => Promise.resolve('sk-x'),
      config: { keyType: 'inference', licenseAccepted: true, binaryPath },
      bobHome: '/tmp/bobhome',
      redactor: passthroughRedactor(),
      clock: { now: () => 0 },
      spawnFn,
    });
    const events = await collect(runner.run(task({ cwd })));
    const result = events[events.length - 1] as { type: string; ok: boolean };
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].stdinWritten).toContain('did not match the format');
  });

  it('fails with BOB_BAD_OUTPUT after a second invalid response', async () => {
    const badOutput = `${RESULT_BEGIN}\nnot json\n${RESULT_END}`;
    const { spawnFn, calls } = makeFakeSpawn([
      { stdout: badOutput, code: 0 },
      { stdout: badOutput, code: 0 },
    ]);
    const cwd = await makeStagingDir();
    const binaryPath = await makeFakeBobBinary();
    const runner = new BobShellRunner({
      getApiKey: () => Promise.resolve('sk-x'),
      config: { keyType: 'inference', licenseAccepted: true, binaryPath },
      bobHome: '/tmp/bobhome',
      redactor: passthroughRedactor(),
      clock: { now: () => 0 },
      spawnFn,
    });
    const events = await collect(runner.run(task({ cwd })));
    const result = events[events.length - 1] as { type: string; ok: boolean; data: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.data.code).toBe('BOB_BAD_OUTPUT');
    expect(calls).toHaveLength(2);
  });

  it('classifies and reports a non-zero exit as a failed result', async () => {
    const { spawnFn } = makeFakeSpawn([{ stdout: '', stderr: 'unauthorized', code: 1 }]);
    const cwd = await makeStagingDir();
    const binaryPath = await makeFakeBobBinary();
    const runner = new BobShellRunner({
      getApiKey: () => Promise.resolve('sk-x'),
      config: { keyType: 'inference', licenseAccepted: true, binaryPath },
      bobHome: '/tmp/bobhome',
      redactor: passthroughRedactor(),
      clock: { now: () => 0 },
      spawnFn,
    });
    const events = await collect(runner.run(task({ cwd })));
    const result = events[events.length - 1] as { type: string; ok: boolean; data: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.data.code).toBe('BOB_AUTH_FAILED');
  });

  it('sources fix_build file_changed events from our own diff, not from FixResult.changedFiles', async () => {
    const cwd = await makeStagingDir({ 'app.js': 'old' });
    // Bob's own claim says nothing changed, but it actually wrote a new file to staging — the
    // runner's file_changed events must reflect that real change, not the (empty) claim.
    const fixResult = `${RESULT_BEGIN}\n${JSON.stringify({ fixed: true, summary: 'ok', changedFiles: [], requestedCommands: [] })}\n${RESULT_END}`;
    // The runner snapshots staging (computeManifest) before spawning bob, then diffs again after it
    // exits — so simulate Bob's edit via onInvoke, which fires exactly when the fake process is
    // "spawned", guaranteeing it happens after that initial snapshot rather than before it.
    const { spawnFn } = makeFakeSpawn([
      { stdout: fixResult, code: 0, onInvoke: () => writeFile(join(cwd, 'app.js'), 'new content') },
    ]);
    const binaryPath = await makeFakeBobBinary();
    const runner = new BobShellRunner({
      getApiKey: () => Promise.resolve('sk-x'),
      config: { keyType: 'inference', licenseAccepted: true, binaryPath },
      bobHome: '/tmp/bobhome',
      redactor: passthroughRedactor(),
      clock: { now: () => 0 },
      spawnFn,
    });
    const events = await collect(runner.run(task({ kind: 'fix_build', cwd, context: { command: 'npm run build', output: 'boom' } })));
    const fileEvents = events.filter((e): e is { type: 'file_changed'; path: string; action: string } => (e as { type: string }).type === 'file_changed');
    expect(fileEvents).toEqual([{ type: 'file_changed', path: 'app.js', action: 'modified' }]);
  });

  it('cancel() kills an in-flight run, which then settles as a failed (null-code) result', async () => {
    const { spawnFn } = makeFakeSpawn([{ hang: true }]);
    const cwd = await makeStagingDir();
    const binaryPath = await makeFakeBobBinary();
    const runner = new BobShellRunner({
      getApiKey: () => Promise.resolve('sk-x'),
      config: { keyType: 'inference', licenseAccepted: true, binaryPath },
      bobHome: '/tmp/bobhome',
      redactor: passthroughRedactor(),
      clock: { now: () => 0 },
      spawnFn,
    });
    const runPromise = collect(runner.run(task({ cwd, timeoutMs: 60000 })));
    setTimeout(() => void runner.cancel(), 20);
    const events = await runPromise;
    const result = events[events.length - 1] as { type: string; ok: boolean };
    expect(result.type).toBe('result');
    expect(result.ok).toBe(false);
  }, 2000);

  it('a hard timeout kills the process and reports BOB_TIMEOUT without waiting for cancel()', async () => {
    const { spawnFn } = makeFakeSpawn([{ hang: true }]);
    const cwd = await makeStagingDir();
    const binaryPath = await makeFakeBobBinary();
    const runner = new BobShellRunner({
      getApiKey: () => Promise.resolve('sk-x'),
      config: { keyType: 'inference', licenseAccepted: true, binaryPath },
      bobHome: '/tmp/bobhome',
      redactor: passthroughRedactor(),
      clock: { now: () => 0 },
      spawnFn,
    });
    const events = await collect(runner.run(task({ cwd, timeoutMs: 50 })));
    const result = events[events.length - 1] as { type: string; ok: boolean; data: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.data.code).toBe('BOB_TIMEOUT');
  }, 2000);

  it('streams Bob\'s activity as whole readable lines, hides the RESULT block, and reports shell commands', async () => {
    const cwd = await makeStagingDir();
    const json = JSON.stringify({ type: 'static', needsBackend: false });
    const stream = [
      { type: 'init', session_id: 'x' },
      { type: 'tool_use', tool_name: 'read_file', tool_id: 'a', parameters: { absolute_path: join(cwd, 'package.json') } },
      { type: 'tool_result', tool_id: 'a', status: 'success', output: '{}' },
      { type: 'tool_use', tool_name: 'run_shell_command', tool_id: 'b', parameters: { command: 'ls dist' } },
      { type: 'tool_result', tool_id: 'b', status: 'error', error: { message: 'No such file' } },
      { type: 'message', role: 'assistant', content: 'This is a Vite ', delta: true },
      { type: 'message', role: 'assistant', content: 'site.\n', delta: true },
      { type: 'message', role: 'assistant', content: `${RESULT_BEGIN}\n${json}\n${RESULT_END}`, delta: true },
      { type: 'result', status: 'success', last_message: 'done' },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    const { spawnFn } = makeFakeSpawn([{ stdout: stream, code: 0 }]);
    const runner = new BobShellRunner({
      getApiKey: () => Promise.resolve('k'),
      config: { keyType: 'inference', licenseAccepted: true, binaryPath: await makeFakeBobBinary() },
      bobHome: '/tmp/bobhome',
      redactor: passthroughRedactor(),
      clock: { now: () => 0 },
      spawnFn,
    });
    const events = await collect(runner.run(task({ cwd })));
    expect(events).toEqual([
      { type: 'message', text: 'Bob is reading `package.json`' },
      { type: 'message', text: 'Bob is running `ls dist`' },
      { type: 'message', text: "That step didn't work: No such file" },
      { type: 'command', cmd: 'ls dist', code: 1 },
      { type: 'message', text: 'This is a Vite site.' },
      { type: 'result', ok: true, summary: 'Bob completed "detect_stack"', data: { type: 'static', needsBackend: false } },
    ]);
  });

  it('parses a RESULT block streamed as fragments without delta flags (Bob Shell 2.x), on the first try', async () => {
    const cwd = await makeStagingDir();
    // Exactly how the real CLI split a plain-HTML analysis on 2026-09-26: no `delta`, markers and
    // JSON strings cut mid-token. Joining these with newlines used to yield "invalid-json".
    const fragments = [
      'This',
      ' is a plain',
      ' static HTML site.',
      '\nBO',
      'B_DEPLOY_RESULT_',
      'BEGIN\n',
      '{"',
      'type":"',
      'static","outputDir":',
      '".","needsBackend":false',
      '}\n',
      'BOB_DEPLOY_',
      'RESULT_END',
    ];
    const stream = [
      { type: 'init', session_id: 'x' },
      ...fragments.map((content) => ({ type: 'message', role: 'assistant', content })),
      { type: 'result', status: 'success', last_message: 'RESULT_END' },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    const { spawnFn, calls } = makeFakeSpawn([{ stdout: stream, code: 0 }]);
    const runner = new BobShellRunner({
      getApiKey: () => Promise.resolve('k'),
      config: { keyType: 'inference', licenseAccepted: true, binaryPath: await makeFakeBobBinary() },
      bobHome: '/tmp/bobhome',
      redactor: passthroughRedactor(),
      clock: { now: () => 0 },
      spawnFn,
    });
    const events = await collect(runner.run(task({ cwd })));
    expect(events).toEqual([
      { type: 'message', text: 'This is a plain static HTML site.' },
      { type: 'result', ok: true, summary: 'Bob completed "detect_stack"', data: { type: 'static', outputDir: '.', needsBackend: false } },
    ]);
    expect(calls).toHaveLength(1); // no costly retry
  });
});
