import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, AgentRunner, AgentTask } from '@bob-deploy/contracts';
import { detectStackStep, deriveSafeStartCmd } from './detect-stack.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(__dirname, '..', '..', '..', 'agent', 'src', 'detect', '__samples__');

function neverCalledRunner(): AgentRunner {
  return {
    run(): AsyncIterable<AgentEvent> {
      throw new Error('AgentRunner.run should not have been called for a confident heuristic match.');
    },
    cancel: () => Promise.resolve(),
  };
}

function scriptedRunner(events: AgentEvent[]): AgentRunner {
  return {
    async *run(_task: AgentTask): AsyncIterable<AgentEvent> {
      await Promise.resolve();
      for (const e of events) yield e;
    },
    cancel: () => Promise.resolve(),
  };
}

describe('deriveSafeStartCmd', () => {
  it('leaves an already-valid command untouched', () => {
    expect(deriveSafeStartCmd({ type: 'node', startCmd: 'npm start' })).toBe('npm start');
    expect(deriveSafeStartCmd({ type: 'python', startCmd: '.venv/bin/gunicorn app:app' })).toBe('.venv/bin/gunicorn app:app');
  });

  it('derives a .venv-prefixed gunicorn command for flask', () => {
    expect(deriveSafeStartCmd({ type: 'python', framework: 'flask', startCmd: 'gunicorn app:app' })).toBe(
      '.venv/bin/gunicorn app:app --bind 127.0.0.1:$PORT',
    );
  });

  it('derives a .venv-prefixed uvicorn command for fastapi', () => {
    expect(deriveSafeStartCmd({ type: 'python', framework: 'fastapi', startCmd: 'uvicorn main:app --host 0.0.0.0' })).toBe(
      '.venv/bin/uvicorn main:app --host 127.0.0.1 --port $PORT',
    );
  });

  it('gives up on django (needs a project-specific WSGI path it cannot guess)', () => {
    expect(deriveSafeStartCmd({ type: 'python', framework: 'django' })).toBeUndefined();
  });

  it('falls back to "npm start" for a node app with some start script but an unrecognised command', () => {
    expect(deriveSafeStartCmd({ type: 'node', startCmd: 'node ./bin/www.js --port 4000' })).toBe('npm start');
  });

  it('gives up on a node app with no start command at all', () => {
    expect(deriveSafeStartCmd({ type: 'node' })).toBeUndefined();
  });
});

describe('detectStackStep', () => {
  it('trusts a confident heuristic (vite) and never calls Bob', async () => {
    const outcome = await detectStackStep.run({ projectDir: join(SAMPLES, 'vite'), agentRunner: neverCalledRunner() });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.usedBob).toBe(false);
      expect(outcome.data.stack.type).toBe('static');
    }
  });

  it('falls back to Bob when the heuristic is not confident, passing the heuristic as a hint', async () => {
    // plain-html/astro/etc. are confident; use a runner that would fail the test if uncalled by
    // forcing low confidence via an empty temp dir instead of a real sample.
    const runner = scriptedRunner([
      { type: 'result', ok: true, summary: 'detected', data: { type: 'node', needsBackend: true, startCmd: 'npm start' } },
    ]);
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const emptyDir = await fs.mkdtemp(join(os.tmpdir(), 'bd-detect-empty-'));
    try {
      const outcome = await detectStackStep.run({ projectDir: emptyDir, agentRunner: runner });
      expect(outcome).toMatchObject({ ok: true, data: { usedBob: true, stack: { type: 'node' } } });
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('asks Bob even for a confident heuristic when alwaysAskBob is set, and passes the guess as heuristicStack', async () => {
    const tasks: AgentTask[] = [];
    const runner: AgentRunner = {
      async *run(task: AgentTask): AsyncIterable<AgentEvent> {
        await Promise.resolve();
        tasks.push(task);
        yield { type: 'message', text: 'Bob is reading `package.json`' };
        yield { type: 'result', ok: true, summary: 'detected', data: { type: 'static', framework: 'vite', buildCmd: 'npm run build', outputDir: 'dist', needsBackend: false } };
      },
      cancel: () => Promise.resolve(),
    };
    const seen: AgentEvent[] = [];
    const outcome = await detectStackStep.run({
      projectDir: join(SAMPLES, 'vite'),
      agentRunner: runner,
      alwaysAskBob: true,
      onAgentEvent: (event) => seen.push(event),
    });
    expect(outcome).toMatchObject({ ok: true, data: { usedBob: true, stack: { type: 'static', framework: 'vite' } } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.context.hints).toHaveProperty('heuristicStack');
    expect(seen.map((e) => e.type)).toEqual(['message', 'result']);
  });

  it('keeps the confident heuristic result when Bob fails under alwaysAskBob', async () => {
    const runner = scriptedRunner([{ type: 'result', ok: false, summary: 'Bob Shell is not installed.' }]);
    const outcome = await detectStackStep.run({ projectDir: join(SAMPLES, 'vite'), agentRunner: runner, alwaysAskBob: true });
    expect(outcome).toMatchObject({
      ok: true,
      data: { usedBob: true, bobError: 'Bob Shell is not installed.', stack: { type: 'static' } },
    });
  });

  it('derives a safe python start command for a flask sample detected via heuristics alone (no Bob)', async () => {
    const outcome = await detectStackStep.run({ projectDir: join(SAMPLES, 'flask') });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.stack.type).toBe('python');
      expect(outcome.data.stack.startCmd).toMatch(/^\.venv\/bin\//);
    }
  });

  it('fails UNSUPPORTED_STACK when nothing safe can be derived and Bob is unavailable', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const emptyDir = await fs.mkdtemp(join(os.tmpdir(), 'bd-detect-empty-'));
    try {
      const outcome = await detectStackStep.run({ projectDir: emptyDir });
      expect(outcome).toMatchObject({ ok: false, code: 'UNSUPPORTED_STACK' });
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('fails UNSUPPORTED_STACK when Bob returns a result that fails schema validation', async () => {
    const runner = scriptedRunner([{ type: 'result', ok: true, summary: 'detected', data: { bogus: true } }]);
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const emptyDir = await fs.mkdtemp(join(os.tmpdir(), 'bd-detect-empty-'));
    try {
      const outcome = await detectStackStep.run({ projectDir: emptyDir, agentRunner: runner });
      expect(outcome).toMatchObject({ ok: false, code: 'UNSUPPORTED_STACK' });
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });
});
