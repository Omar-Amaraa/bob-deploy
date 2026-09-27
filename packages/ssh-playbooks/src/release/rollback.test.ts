import { describe, it, expect } from 'vitest';
import type { Clock } from '@bob-deploy/contracts';
import { rollbackTo } from './rollback.js';
import { FakeReleaseStore } from './types.js';
import { FakeHttpProbe } from './http-probe.js';
import { fakeRemoteExec, bdSuccess, execResult } from './testing/fake-remote-exec.js';

const instantClock: Clock = {
  now: () => new Date('2026-09-25T12:00:00Z'),
  setTimeout: (fn) => {
    fn();
    return 0;
  },
  clearTimeout: () => undefined,
};

function handlers(app: string, port: number, healthy = true) {
  return [
    { when: (c: string) => c.includes('test -d'), result: execResult({ code: 0 }) },
    { when: (c: string) => c.includes(`run/${port}.release`), result: execResult({ code: 0 }) },
    { when: (c: string) => c.includes(`/bd-service '${app}' '${port}' 'restart'`), result: bdSuccess({ app, port, action: 'restart', active: true }) },
    { when: (c: string) => c.includes('curl'), result: execResult({ stdout: healthy ? '200' : '000' }) },
    { when: (c: string) => c.includes("'auto'"), result: bdSuccess({ app, domain: 'example.com', tlsMode: 'auto' }) },
    { when: (c: string) => c.includes('ln -sfn'), result: execResult({ code: 0 }) },
    { when: (c: string) => c.includes(`/bd-service '${app}' '${port}' 'stop'`), result: bdSuccess({ app, port, action: 'stop', active: false }) },
    { when: () => true, result: execResult({ code: 0 }) },
  ];
}

describe('S11: rollbackTo — needs no Bob/AgentRunner call', () => {
  it('defaults to the newest previous release still on disk, and never touches Bob/AgentRunner (no such param exists)', async () => {
    const store = new FakeReleaseStore();
    await store.recordRelease('myapp', { id: '20260101T000000Z', status: 'previous', createdAt: '2026-01-01' });
    await store.recordRelease('myapp', { id: '20260201T000000Z', status: 'previous', createdAt: '2026-02-01' });
    await store.recordRelease('myapp', { id: '20260301T000000Z', status: 'live', createdAt: '2026-03-01' });
    const probe = new FakeHttpProbe({ 'example.com': [{ ok: true, status: 200 }] });
    const exec = fakeRemoteExec(handlers('myapp', 3101));

    const outcome = await rollbackTo({
      session: exec,
      app: 'myapp',
      domain: 'example.com',
      isStatic: false,
      portA: 3100,
      portB: 3101,
      currentLivePort: 3100,
      tlsMode: 'auto',
      releaseStore: store,
      httpProbe: probe,
      clock: instantClock,
      healthCheckIntervalMs: 0,
      publicCheckIntervalMs: 0,
    });

    expect(outcome).toMatchObject({ ok: true, data: { status: 'live', releaseId: '20260201T000000Z' } });
    expect(exec.calls.some((c) => c.cmd.includes(`'myapp' '3100' 'stop'`))).toBe(true);
  });

  it('static rollback only swaps the symlink, no health check or Caddy call', async () => {
    const store = new FakeReleaseStore();
    await store.recordRelease('myapp', { id: '20260101T000000Z', status: 'previous', createdAt: '2026-01-01' });
    const exec = fakeRemoteExec([{ when: (c: string) => c.includes('test -d'), result: execResult({ code: 0 }) }, { when: () => true, result: execResult({ code: 0 }) }]);

    const outcome = await rollbackTo({
      session: exec,
      app: 'myapp',
      domain: 'example.com',
      isStatic: true,
      portA: 3100,
      portB: 3101,
      tlsMode: 'auto',
      releaseStore: store,
      clock: instantClock,
    });

    expect(outcome).toMatchObject({ ok: true, data: { status: 'live', releaseId: '20260101T000000Z' } });
    expect(exec.calls.some((c) => c.cmd.includes('curl'))).toBe(false);
    expect(exec.calls.some((c) => c.cmd.includes('caddy'))).toBe(false);
  });

  it('fails when no previous release is available at all', async () => {
    const store = new FakeReleaseStore();
    const exec = fakeRemoteExec();
    const outcome = await rollbackTo({
      session: exec,
      app: 'myapp',
      domain: 'example.com',
      isStatic: false,
      portA: 3100,
      portB: 3101,
      tlsMode: 'auto',
      releaseStore: store,
      clock: instantClock,
    });
    expect(outcome).toMatchObject({ ok: false, code: 'BUILD_FAILED' });
  });

  it('skips a previous release whose directory no longer exists on disk and uses the next one', async () => {
    const store = new FakeReleaseStore();
    await store.recordRelease('myapp', { id: '20260101T000000Z', status: 'previous', createdAt: '2026-01-01' });
    await store.recordRelease('myapp', { id: '20260201T000000Z', status: 'previous', createdAt: '2026-02-01' });
    const exec = fakeRemoteExec([
      { when: (c: string) => c.includes(`test -d`) && c.includes('20260201T000000Z'), result: execResult({ code: 1 }) },
      { when: (c: string) => c.includes(`test -d`) && c.includes('20260101T000000Z'), result: execResult({ code: 0 }) },
      ...handlers('myapp', 3100, true),
    ]);

    const outcome = await rollbackTo({
      session: exec,
      app: 'myapp',
      domain: 'example.com',
      isStatic: false,
      portA: 3100,
      portB: 3101,
      tlsMode: 'auto',
      releaseStore: store,
      httpProbe: new FakeHttpProbe({ 'example.com': [{ ok: true, status: 200 }] }),
      clock: instantClock,
      healthCheckIntervalMs: 0,
      publicCheckIntervalMs: 0,
    });

    expect(outcome).toMatchObject({ ok: true, data: { releaseId: '20260101T000000Z' } });
  });

  it('does not promote to live when the restarted instance never becomes healthy', async () => {
    const store = new FakeReleaseStore();
    await store.recordRelease('myapp', { id: '20260101T000000Z', status: 'previous', createdAt: '2026-01-01' });
    const exec = fakeRemoteExec(handlers('myapp', 3100, false));

    const outcome = await rollbackTo({
      session: exec,
      app: 'myapp',
      domain: 'example.com',
      isStatic: false,
      portA: 3100,
      portB: 3101,
      tlsMode: 'auto',
      releaseStore: store,
      clock: instantClock,
      healthCheckTries: 2,
      healthCheckIntervalMs: 0,
    });

    expect(outcome).toMatchObject({ ok: true, data: { status: 'rolled_back' } });
    const releases = await store.listReleases('myapp');
    expect(releases[0]?.status).toBe('previous'); // never promoted to live
  });
});
