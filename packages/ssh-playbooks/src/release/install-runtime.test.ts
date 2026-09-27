import { describe, it, expect } from 'vitest';
import type { AgentEvent, AgentRunner, StackInfo } from '@bob-deploy/contracts';
import { installRuntimeStep } from './install-runtime.js';
import { fakeRemoteExec, bdSuccess, bdFailure } from './testing/fake-remote-exec.js';

function scriptedRunner(events: AgentEvent[]): AgentRunner {
  return {
    async *run(): AsyncIterable<AgentEvent> {
      await Promise.resolve();
      for (const e of events) yield e;
    },
    cancel: () => Promise.resolve(),
  };
}

const NODE_STACK: StackInfo = { type: 'node', needsBackend: true, runtimeVersion: '20', startCmd: 'npm start' };
const STATIC_STACK: StackInfo = { type: 'static', needsBackend: false };

describe('installRuntimeStep', () => {
  it('is a no-op for static apps (no Bob call, no bd-install-runtime)', async () => {
    const exec = fakeRemoteExec();
    const outcome = await installRuntimeStep.run({ session: exec, stack: STATIC_STACK, projectDir: '/tmp/x' });
    expect(outcome).toEqual({ ok: true, data: { installedAptPackages: [], droppedAptPackages: [] } });
    expect(exec.calls.length).toBe(0);
  });

  it('installs the runtime at the stack-declared version when Bob is not consulted', async () => {
    const exec = fakeRemoteExec([{ when: () => true, result: bdSuccess({ runtime: 'node', version: 'v20.11.0' }) }]);
    const outcome = await installRuntimeStep.run({ session: exec, stack: NODE_STACK, projectDir: '/tmp/x' });
    expect(outcome).toMatchObject({ ok: true, data: { runtime: { name: 'node', version: 'v20.11.0' } } });
  });

  it('filters aptPackages from a Bob plan against the allowlist and installs only the allowed ones', async () => {
    const runner = scriptedRunner([
      {
        type: 'result',
        ok: true,
        summary: 'planned',
        data: { runtime: { name: 'python', version: '3.11' }, aptPackages: ['libssl-dev', 'nmap'], notes: [] },
      },
    ]);
    const exec = fakeRemoteExec([
      { when: (c) => c.includes('/usr/local/lib/bob-deploy/bin/bd-install-'), result: bdSuccess({ runtime: 'python', version: '3.11.2' }) },
    ]);
    const outcome = await installRuntimeStep.run({
      session: exec,
      stack: { type: 'python', needsBackend: true, framework: 'flask' },
      agentRunner: runner,
      projectDir: '/tmp/x',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.installedAptPackages).toEqual(['libssl-dev']);
      expect(outcome.data.droppedAptPackages).toEqual(['nmap']);
    }
    // Second call: bd-install-apt-packages, base64-encoded newline-separated list.
    const b64 = Buffer.from('libssl-dev', 'utf8').toString('base64');
    expect(exec.calls[1]?.cmd).toContain(b64);
  });

  it('fails BUILD_FAILED on a runtime major-version mismatch', async () => {
    const exec = fakeRemoteExec([{ when: () => true, result: bdSuccess({ runtime: 'node', version: 'v18.19.0' }) }]);
    const outcome = await installRuntimeStep.run({ session: exec, stack: NODE_STACK, projectDir: '/tmp/x' });
    expect(outcome).toMatchObject({ ok: false, code: 'BUILD_FAILED' });
  });

  it('maps a bd-install-runtime failure through mapBdErrorCode', async () => {
    const exec = fakeRemoteExec([{ when: () => true, result: bdFailure('BD_APT_INSTALL_FAILED', 'apt failed') }]);
    const outcome = await installRuntimeStep.run({ session: exec, stack: NODE_STACK, projectDir: '/tmp/x' });
    expect(outcome).toMatchObject({ ok: false, code: 'HARDENING_FAILED', message: 'apt failed' });
  });
});
