import { describe, it, expect } from 'vitest';
import type { StackInfo } from '@bob-deploy/contracts';
import { proxyAndHttpsStep } from './proxy-and-https.js';
import { fakeRemoteExec, bdSuccess, bdFailure, execResult } from './testing/fake-remote-exec.js';
import { FakeHttpProbe } from './http-probe.js';

const STATIC_STACK: StackInfo = { type: 'static', needsBackend: false };
const NODE_STACK: StackInfo = { type: 'node', needsBackend: true, startCmd: 'npm start' };

function baseHandlers() {
  return [
    { when: (c: string) => c === '/usr/local/lib/bob-deploy/bin/bd-install-caddy', result: bdSuccess({ version: '2.8.4' }) }, // bd-install-caddy
    { when: (c: string) => c.includes("'myapp'") && c.includes("'deployer'"), result: bdSuccess({ app: 'myapp', appDir: '/srv/bob-deploy/apps/myapp' }) },
    { when: (c: string) => c === 'ss -ltnH', result: execResult({ stdout: '' }) },
  ];
}

describe('proxyAndHttpsStep', () => {
  it('static apps: configures Caddy for static serving and verifies HTTPS immediately', async () => {
    const probe = new FakeHttpProbe({ 'myapp.example.com': [{ ok: true, status: 200 }] });
    const exec = fakeRemoteExec([
      ...baseHandlers(),
      { when: (c: string) => c.includes("'static'"), result: bdSuccess({ app: 'myapp', domain: 'myapp.example.com', tlsMode: 'auto' }) },
    ]);
    const outcome = await proxyAndHttpsStep.run({
      session: exec,
      app: 'myapp',
      adminUser: 'deployer',
      domain: 'myapp.example.com',
      stack: STATIC_STACK,
      tlsMode: 'auto',
      httpProbe: probe,
    });
    expect(outcome).toMatchObject({ ok: true, data: { caddySiteConfigured: true } });
    expect(probe.callLog).toEqual(['https://myapp.example.com/']);
  });

  it('static apps: fails HEALTHCHECK_FAILED when the HTTPS probe does not come back healthy', async () => {
    const probe = new FakeHttpProbe({ 'myapp.example.com': [{ ok: false, status: 502 }] });
    const exec = fakeRemoteExec([
      ...baseHandlers(),
      { when: (c: string) => c.includes("'static'"), result: bdSuccess({ app: 'myapp', domain: 'myapp.example.com', tlsMode: 'auto' }) },
    ]);
    const outcome = await proxyAndHttpsStep.run({
      session: exec,
      app: 'myapp',
      adminUser: 'deployer',
      domain: 'myapp.example.com',
      stack: STATIC_STACK,
      tlsMode: 'auto',
      httpProbe: probe,
      probeIntervalMs: 0,
    });
    expect(outcome).toMatchObject({ ok: false, code: 'HEALTHCHECK_FAILED' });
  });

  it('static apps: retries while Caddy is still starting, then passes', async () => {
    const probe = new FakeHttpProbe({
      'myapp.example.com': [
        { ok: false, error: 'Client network socket disconnected before secure TLS connection was established' },
        { ok: false, status: 404 },
      ],
    });
    const exec = fakeRemoteExec([
      ...baseHandlers(),
      { when: (c: string) => c.includes("'static'"), result: bdSuccess({ app: 'myapp', domain: 'myapp.example.com', tlsMode: 'auto' }) },
    ]);
    const outcome = await proxyAndHttpsStep.run({
      session: exec,
      app: 'myapp',
      adminUser: 'deployer',
      domain: 'myapp.example.com',
      stack: STATIC_STACK,
      tlsMode: 'auto',
      httpProbe: probe,
      probeIntervalMs: 0,
    });
    expect(outcome).toMatchObject({ ok: true, data: { caddySiteConfigured: true } });
    expect(probe.callLog.length).toBe(2);
  });

  it('static apps: a 404/403 before the first release still proves HTTPS works', async () => {
    const probe = new FakeHttpProbe({ 'myapp.example.com': [{ ok: false, status: 403 }] });
    const exec = fakeRemoteExec([
      ...baseHandlers(),
      { when: (c: string) => c.includes("'static'"), result: bdSuccess({ app: 'myapp', domain: 'myapp.example.com', tlsMode: 'auto' }) },
    ]);
    const outcome = await proxyAndHttpsStep.run({
      session: exec,
      app: 'myapp',
      adminUser: 'deployer',
      domain: 'myapp.example.com',
      stack: STATIC_STACK,
      tlsMode: 'auto',
      httpProbe: probe,
    });
    expect(outcome).toMatchObject({ ok: true, data: { caddySiteConfigured: true } });
  });

  it('proxy apps (node/python): does not configure Caddy yet, just allocates ports', async () => {
    const exec = fakeRemoteExec(baseHandlers());
    const outcome = await proxyAndHttpsStep.run({
      session: exec,
      app: 'myapp',
      adminUser: 'deployer',
      domain: 'myapp.example.com',
      stack: NODE_STACK,
      tlsMode: 'auto',
    });
    expect(outcome).toMatchObject({ ok: true, data: { portA: 3100, portB: 3101, caddySiteConfigured: false } });
    expect(exec.calls.some((c) => c.cmd.includes("'static'"))).toBe(false);
  });

  it('fails when no free port pair can be found', async () => {
    const busy = Array.from({ length: 1000 }, (_, i) => `LISTEN 0 1 0.0.0.0:${3100 + i} 0.0.0.0:*`).join('\n');
    const exec = fakeRemoteExec([
      { when: (c: string) => c === '/usr/local/lib/bob-deploy/bin/bd-install-caddy', result: bdSuccess({ version: '2.8.4' }) },
      {
        when: (c: string) => c.includes("'myapp'") && c.includes("'deployer'"),
        result: bdSuccess({ app: 'myapp', appDir: '/srv/bob-deploy/apps/myapp' }),
      },
      { when: (c: string) => c === 'ss -ltnH', result: execResult({ stdout: busy }) },
    ]);
    const outcome = await proxyAndHttpsStep.run({
      session: exec,
      app: 'myapp',
      adminUser: 'deployer',
      domain: 'myapp.example.com',
      stack: NODE_STACK,
      tlsMode: 'auto',
    });
    expect(outcome).toMatchObject({ ok: false, code: 'INTERNAL' });
  });

  it('maps a bd-install-caddy failure through mapBdErrorCode', async () => {
    const exec = fakeRemoteExec([{ when: (c: string) => c === '/usr/local/lib/bob-deploy/bin/bd-install-caddy', result: bdFailure('BD_APT_INSTALL_FAILED', 'nope') }]);
    const outcome = await proxyAndHttpsStep.run({
      session: exec,
      app: 'myapp',
      adminUser: 'deployer',
      domain: 'myapp.example.com',
      stack: NODE_STACK,
      tlsMode: 'auto',
    });
    expect(outcome).toMatchObject({ ok: false, code: 'HARDENING_FAILED' });
  });
});
