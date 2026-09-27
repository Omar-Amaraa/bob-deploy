import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StackInfo, Clock } from '@bob-deploy/contracts';
import { releaseProcedure, generateReleaseId } from './release.js';
import { FakeReleaseStore } from './types.js';
import { FakeHttpProbe } from './http-probe.js';
import { fakeRemoteExec, bdSuccess, execResult } from './testing/fake-remote-exec.js';

const tempDirs: string[] = [];
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const instantClock: Clock = {
  now: () => new Date('2026-09-25T12:00:00Z'),
  setTimeout: (fn) => {
    fn();
    return 0;
  },
  clearTimeout: () => undefined,
};

async function staticSourceDir(): Promise<string> {
  const dir = await makeTempDir('bd-release-static-src-');
  await writeFile(join(dir, 'index.html'), '<html>hi</html>');
  return dir;
}

async function nodeSourceDir(): Promise<string> {
  const dir = await makeTempDir('bd-release-node-src-');
  await writeFile(join(dir, 'package.json'), '{"name":"app"}');
  await mkdir(join(dir, 'dist'));
  await writeFile(join(dir, 'dist', 'server.js'), 'console.log(1)');
  return dir;
}

const NODE_STACK: StackInfo = { type: 'node', needsBackend: true, startCmd: 'npm start', healthPath: '/' };
const STATIC_STACK: StackInfo = { type: 'static', needsBackend: false, healthPath: '/' };

describe('generateReleaseId', () => {
  it('formats as UTC YYYYMMDDTHHMMSSZ', () => {
    expect(generateReleaseId(instantClock)).toBe('20260925T120000Z');
  });
});

describe('S11: releaseProcedure (static) — a failed release never replaces a healthy one', () => {
  it('first deploy: packages, swaps the symlink, passes the public check, and marks the release live', async () => {
    const sourceDir = await staticSourceDir();
    const store = new FakeReleaseStore();
    const probe = new FakeHttpProbe({ 'example.com': [{ ok: true, status: 200 }] });
    const exec = fakeRemoteExec();

    const outcome = await releaseProcedure({
      session: exec,
      app: 'myapp',
      domain: 'example.com',
      stack: STATIC_STACK,
      kind: 'static',
      sourceDir,
      portA: 3100,
      portB: 3101,
      env: { API_KEY: 'super-secret-value' },
      tlsMode: 'auto',
      releaseStore: store,
      httpProbe: probe,
      clock: instantClock,
    });

    expect(outcome).toMatchObject({ ok: true, data: { status: 'live', releaseId: '20260925T120000Z' } });
    const releases = await store.listReleases('myapp');
    expect(releases.length).toBe(1);
    expect(releases[0]?.id).toBe('20260925T120000Z');
    expect(releases[0]?.status).toBe('live');
    expect(typeof releases[0]?.createdAt).toBe('string');

    // The symlink swap ran, and no process-related steps (no bd-service, no bd-caddy-site) fired.
    expect(exec.calls.some((c) => c.cmd.includes('ln -sfn'))).toBe(true);
    expect(exec.calls.some((c) => c.cmd.includes("'restart'"))).toBe(false);

    // The secret env value never appears in any command string (it only ever moves as a file).
    for (const call of exec.calls) expect(call.cmd).not.toContain('super-secret-value');
  });

  it('rolls back (no swap kept) when the public HTTPS check fails', async () => {
    const sourceDir = await staticSourceDir();
    const store = new FakeReleaseStore();
    const probe = new FakeHttpProbe({ 'example.com': [{ ok: false, status: 502 }] });
    const exec = fakeRemoteExec();

    const outcome = await releaseProcedure({
      session: exec,
      app: 'myapp',
      domain: 'example.com',
      stack: STATIC_STACK,
      kind: 'static',
      sourceDir,
      portA: 3100,
      portB: 3101,
      env: {},
      tlsMode: 'auto',
      releaseStore: store,
      httpProbe: probe,
      clock: instantClock,
      publicCheckTries: 2,
      publicCheckIntervalMs: 0,
    });

    expect(outcome).toMatchObject({ ok: true, data: { status: 'rolled_back' } });
    const releases = await store.listReleases('myapp');
    expect(releases[0]?.status).toBe('failed');
  });
});

describe('S11: releaseProcedure (node) — blue/green, health-checked before switching', () => {
  function nodeHandlers(app: string, port: number, _releaseId: string, opts: { healthy: boolean } = { healthy: true }) {
    return [
      { when: (c: string) => c.includes('tar -xzf'), result: execResult({ code: 0 }) },
      { when: (c: string) => c.startsWith('mv -f') || c.includes("mv -f '"), result: execResult({ code: 0 }) },
      { when: (c: string) => c.includes('package-lock.json'), result: execResult({ code: 1 }) }, // no lockfile -> npm install
      { when: (c: string) => c.includes('npm install --omit=dev'), result: execResult({ code: 0 }) },
      { when: (c: string) => c.includes('.bd-start'), result: execResult({ code: 0 }) },
      { when: (c: string) => c.includes(`run/${port}.release`), result: execResult({ code: 0 }) },
      {
        when: (c: string) => c.includes(`/bd-service '${app}' '${port}' 'restart'`),
        result: bdSuccess({ app, port, action: 'restart', active: true }),
      },
      {
        when: (c: string) => c.includes('curl') && c.includes(`127.0.0.1:${port}`),
        result: execResult({ stdout: opts.healthy ? '200' : '000' }),
      },
      {
        when: (c: string) => c.includes('/bd-caddy-site ') && c.includes(`'${port}'`) && c.includes("'auto'"),
        result: bdSuccess({ app, domain: 'example.com', tlsMode: 'auto' }),
      },
      { when: (c: string) => c.includes('ln -sfn'), result: execResult({ code: 0 }) },
      {
        when: (c: string) => c.includes(`/bd-service '${app}' '${port}' 'stop'`),
        result: bdSuccess({ app, port, action: 'stop', active: false }),
      },
      {
        when: (c: string) => c.includes('journalctl') || c.includes(`/bd-read-journal '${app}' '${port}' '100'`),
        result: bdSuccess({ app, port, content: Buffer.from('boom').toString('base64') }),
      },
      { when: (c: string) => c.includes('rm -rf') && c.includes('/releases/'), result: execResult({ code: 0 }) },
      { when: () => true, result: execResult({ code: 0 }) },
    ];
  }

  it('first deploy: goes through install, health check, switch, public check, and marks live', async () => {
    const sourceDir = await nodeSourceDir();
    const store = new FakeReleaseStore();
    const probe = new FakeHttpProbe({ 'example.com': [{ ok: true, status: 200 }] });
    const exec = fakeRemoteExec(nodeHandlers('myapp', 3100, '20260925T120000Z'));

    const outcome = await releaseProcedure({
      session: exec,
      app: 'myapp',
      domain: 'example.com',
      stack: NODE_STACK,
      kind: 'node',
      sourceDir,
      portA: 3100,
      portB: 3101,
      env: { SECRET: 'do-not-leak' },
      tlsMode: 'auto',
      releaseStore: store,
      httpProbe: probe,
      clock: instantClock,
      healthCheckIntervalMs: 0,
      publicCheckIntervalMs: 0,
    });

    expect(outcome).toMatchObject({ ok: true, data: { status: 'live', livePort: 3100 } });
    const releases = await store.listReleases('myapp');
    expect(releases[0]?.status).toBe('live');
    for (const call of exec.calls) expect(call.cmd).not.toContain('do-not-leak');
  });

  it('broken build that starts but never answers healthily -> rolled_back, journal captured, instance stopped', async () => {
    const sourceDir = await nodeSourceDir();
    const store = new FakeReleaseStore();
    const exec = fakeRemoteExec(nodeHandlers('myapp', 3100, '20260925T120000Z', { healthy: false }));

    const outcome = await releaseProcedure({
      session: exec,
      app: 'myapp',
      domain: 'example.com',
      stack: NODE_STACK,
      kind: 'node',
      sourceDir,
      portA: 3100,
      portB: 3101,
      env: {},
      tlsMode: 'auto',
      releaseStore: store,
      clock: instantClock,
      healthCheckTries: 3,
      healthCheckIntervalMs: 0,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.status).toBe('rolled_back');
      expect(outcome.data.journalTail).toBe('boom');
    }
    expect(exec.calls.some((c) => c.cmd.includes(`'myapp' '3100' 'stop'`))).toBe(true);
    const releases = await store.listReleases('myapp');
    expect(releases[0]?.status).toBe('failed');
  });

  it('an update starts the new release on the other port from the currently-live one', async () => {
    const sourceDir = await nodeSourceDir();
    const store = new FakeReleaseStore();
    await store.recordRelease('myapp', { id: '20260101T000000Z', status: 'live', createdAt: '2026-01-01T00:00:00Z' });
    const probe = new FakeHttpProbe({ 'example.com': [{ ok: true, status: 200 }] });
    const exec = fakeRemoteExec(nodeHandlers('myapp', 3101, '20260925T120000Z'));

    const outcome = await releaseProcedure({
      session: exec,
      app: 'myapp',
      domain: 'example.com',
      stack: NODE_STACK,
      kind: 'node',
      sourceDir,
      portA: 3100,
      portB: 3101,
      currentLivePort: 3100,
      env: {},
      tlsMode: 'auto',
      releaseStore: store,
      httpProbe: probe,
      clock: instantClock,
      healthCheckIntervalMs: 0,
      publicCheckIntervalMs: 0,
    });

    expect(outcome).toMatchObject({ ok: true, data: { livePort: 3101 } });
    // The old instance (port 3100) was stopped once the new one (3101) was confirmed healthy.
    expect(exec.calls.some((c) => c.cmd.includes(`'myapp' '3100' 'stop'`))).toBe(true);
    const releases = await store.listReleases('myapp');
    expect(releases.find((r) => r.id === '20260101T000000Z')?.status).toBe('previous');
    expect(releases.find((r) => r.id === '20260925T120000Z')?.status).toBe('live');
  });

  it('cleanup keeps exactly the 3 newest releases plus the live one', async () => {
    const sourceDir = await nodeSourceDir();
    const store = new FakeReleaseStore();
    for (const id of ['20260101T000000Z', '20260102T000000Z', '20260103T000000Z', '20260104T000000Z']) {
      await store.recordRelease('myapp', { id, status: 'previous', createdAt: id });
    }
    const probe = new FakeHttpProbe({ 'example.com': [{ ok: true, status: 200 }] });
    const exec = fakeRemoteExec(nodeHandlers('myapp', 3100, '20260925T120000Z'));

    await releaseProcedure({
      session: exec,
      app: 'myapp',
      domain: 'example.com',
      stack: NODE_STACK,
      kind: 'node',
      sourceDir,
      portA: 3100,
      portB: 3101,
      env: {},
      tlsMode: 'auto',
      releaseStore: store,
      httpProbe: probe,
      clock: instantClock,
      healthCheckIntervalMs: 0,
      publicCheckIntervalMs: 0,
    });

    const releases = await store.listReleases('myapp');
    const notDeleted = releases.filter((r) => r.status !== 'deleted');
    // The brand new release is itself the newest, so "3 newest" already includes it: 3 kept, 2 deleted.
    expect(notDeleted.length).toBe(3);
    expect(releases.find((r) => r.id === '20260101T000000Z')?.status).toBe('deleted');
    expect(releases.find((r) => r.id === '20260102T000000Z')?.status).toBe('deleted');
  });
});
