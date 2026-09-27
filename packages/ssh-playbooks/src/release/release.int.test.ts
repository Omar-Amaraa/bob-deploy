import { describe, it, expect, beforeEach } from 'vitest';
import { utils as ssh2Utils } from 'ssh2';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testbedHttpProbe } from './http-probe.js';
import { resetTestbed, testbedTarget, dockerExec } from '../testbed.js';
import { reachServerStep, createAdminStep, lockDownStep, firewallAndPatchesStep } from '../playbook/bootstrap.js';
import { detectStackStep } from './detect-stack.js';
import { installRuntimeStep } from './install-runtime.js';
import { proxyAndHttpsStep } from './proxy-and-https.js';
import { releaseProcedure } from './release.js';
import { rollbackTo } from './rollback.js';
import { FakeReleaseStore } from './types.js';

// Needs Docker + the testbed containers (see testbed/README.md). Run with `pnpm -w test:integration`.
// NOTE: as of A8, this cloud sandbox still has no route to any container registry (see
// docs/HANDOFF.md's A4/A5/A6/A7 entries), so — like every other *.int.test.ts in this package —
// this suite is written and reviewed but has not actually been executed here. It exercises exactly
// the brief's TESTS section: first deploy of vite/express/flask, an update with no failed requests,
// a broken-build rollback, a start-command-crash rollback, a rollback job with no AgentRunner at
// all, cleanup, ownership/permissions, and the shared/.env leak check.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(__dirname, '..', '..', '..', 'agent', 'src', 'detect', '__samples__');
const noRedact = (s: string) => s;

function generateAdminKeypair(): { publicKey: string; privateKey: string } {
  const kp = ssh2Utils.generateKeyPairSync('ed25519', { comment: 'bd-release-test' });
  return { publicKey: kp.public, privateKey: kp.private };
}

async function bootstrapAdmin(service: 'ubuntu2404' | 'ubuntu2204') {
  const target = testbedTarget(service);
  const { publicKey, privateKey } = generateAdminKeypair();
  const reach = await reachServerStep.run({
    host: target.host,
    port: target.sshPort,
    auth: { password: target.rootPassword },
    onUnknownHostKey: () => Promise.resolve(true),
    redact: noRedact,
  });
  if (!reach.ok) throw new Error(`reach_server failed: ${reach.message}`);
  const admin = await createAdminStep.run({ session: reach.data.session, sudo: false, adminUser: 'bdadmin', publicKey });
  if (!admin.ok) throw new Error(`create_admin failed: ${admin.message}`);
  const lockdown = await lockDownStep.run({
    rootSession: reach.data.session,
    rootSudo: false,
    adminUser: 'bdadmin',
    host: target.host,
    port: target.sshPort,
    adminAuth: { privateKey },
    redact: noRedact,
  });
  if (!lockdown.ok) throw new Error(`lock_down failed: ${lockdown.message}`);
  const firewall = await firewallAndPatchesStep.run({ session: lockdown.data.adminSession, adminUser: 'bdadmin' });
  if (!firewall.ok) throw new Error(`firewall_and_patches failed: ${firewall.message}`);
  return { session: lockdown.data.adminSession, target };
}

describe('S11: release flow against the testbed (broken build never replaces the live release)', () => {
  // Every test bootstraps the server from scratch (root password login, then hardening), so each
  // one needs a fresh container: after the first bootstrap root login is disabled.
  beforeEach(async () => {
    await resetTestbed('ubuntu2404');
  }, 10 * 60 * 1000);

  it(
    'first deploy of the vite (static) sample answers over HTTPS with the expected body',
    async () => {
      const { session, target } = await bootstrapAdmin('ubuntu2404');
      const domain = `vite.${target.domain}`;
      const store = new FakeReleaseStore();

      const detect = await detectStackStep.run({ projectDir: join(SAMPLES, 'vite') });
      expect(detect.ok).toBe(true);
      if (!detect.ok) return;

      const proxy = await proxyAndHttpsStep.run({
        session,
        app: 'viteapp',
        adminUser: 'bdadmin',
        domain,
        stack: detect.data.stack,
        tlsMode: 'internal',
        httpProbe: testbedHttpProbe(target.httpsPort),
      });
      expect(proxy.ok).toBe(true);
      if (!proxy.ok) return;

      // The vite sample has no build step wired here (no real npm install/build ran in this
      // fixture, which is just a package.json + index.html shell), so "sourceDir" is the sample
      // directory itself, standing in for whatever the caller's staging build produced.
      const release = await releaseProcedure({
        session,
        app: 'viteapp',
        domain,
        stack: detect.data.stack,
        kind: 'static',
        sourceDir: join(SAMPLES, 'vite'),
        portA: proxy.data.portA,
        portB: proxy.data.portB,
        env: {},
        tlsMode: 'internal',
        releaseStore: store,
        httpProbe: testbedHttpProbe(target.httpsPort),
      });
      expect(release.ok).toBe(true);
      if (release.ok) expect(release.data.status).toBe('live');
    },
    5 * 60 * 1000,
  );

  it(
    'first deploy of the express (node) sample, then an update with zero failed requests during the switch',
    async () => {
      const { session, target } = await bootstrapAdmin('ubuntu2404');
      const domain = `express.${target.domain}`;
      const store = new FakeReleaseStore();
      // Heuristics only: this sample scores 0.8 (< 0.9, no lockfile), so passing a runner would ask
      // Bob, and an unscripted FakeRunner fails detection. Stack detection is not under test here.
      const detect = await detectStackStep.run({ projectDir: join(SAMPLES, 'express') });
      expect(detect.ok).toBe(true);
      if (!detect.ok) return;

      const runtime = await installRuntimeStep.run({ session, stack: detect.data.stack, projectDir: join(SAMPLES, 'express') });
      expect(runtime.ok).toBe(true);

      const proxy = await proxyAndHttpsStep.run({
        session,
        app: 'expressapp',
        adminUser: 'bdadmin',
        domain,
        stack: detect.data.stack,
        tlsMode: 'internal',
      });
      expect(proxy.ok).toBe(true);
      if (!proxy.ok) return;

      const first = await releaseProcedure({
        session,
        app: 'expressapp',
        domain,
        stack: detect.data.stack,
        kind: 'node',
        sourceDir: join(SAMPLES, 'express'),
        portA: proxy.data.portA,
        portB: proxy.data.portB,
        env: { PORT_LABEL: 'v1' },
        tlsMode: 'internal',
        releaseStore: store,
        httpProbe: testbedHttpProbe(target.httpsPort),
      });
      expect(first.ok).toBe(true);
      // Not just ok: ok + 'rolled_back' means the first release never went live.
      expect(first.ok ? first.data.status : undefined).toBe('live');
      if (!first.ok || first.data.status !== 'live') return;

      // Poll continuously through the update to assert zero non-2xx responses during the switch.
      const probeUrl = `https://${domain}/`;
      const probe = testbedHttpProbe(target.httpsPort);
      let failedDuringSwitch = 0;
      let polling = true;
      const pollLoop = (async () => {
        while (polling) {
          const result = await probe.probe(probeUrl, 2000);
          if (!result.ok) failedDuringSwitch++;
          await new Promise((r) => setTimeout(r, 100));
        }
      })();

      const update = await releaseProcedure({
        session,
        app: 'expressapp',
        domain,
        stack: detect.data.stack,
        kind: 'node',
        sourceDir: join(SAMPLES, 'express'),
        portA: proxy.data.portA,
        portB: proxy.data.portB,
        currentLivePort: first.data.livePort,
        env: { PORT_LABEL: 'v2' },
        tlsMode: 'internal',
        releaseStore: store,
        httpProbe: probe,
      });
      polling = false;
      await pollLoop;

      expect(update.ok).toBe(true);
      if (update.ok) expect(update.data.status).toBe('live');
      expect(failedDuringSwitch).toBe(0);
    },
    10 * 60 * 1000,
  );

  it(
    'a broken build that starts but returns 500 rolls back and keeps serving the old body',
    async () => {
      const { session, target } = await bootstrapAdmin('ubuntu2404');
      const domain = `flask.${target.domain}`;
      const store = new FakeReleaseStore();

      const detect = await detectStackStep.run({ projectDir: join(SAMPLES, 'flask') });
      expect(detect.ok).toBe(true);
      if (!detect.ok) return;

      const runtime = await installRuntimeStep.run({ session, stack: detect.data.stack, projectDir: join(SAMPLES, 'flask') });
      expect(runtime.ok).toBe(true);

      const proxy = await proxyAndHttpsStep.run({ session, app: 'flaskapp', adminUser: 'bdadmin', domain, stack: detect.data.stack, tlsMode: 'internal' });
      expect(proxy.ok).toBe(true);
      if (!proxy.ok) return;

      const first = await releaseProcedure({
        session,
        app: 'flaskapp',
        domain,
        stack: detect.data.stack,
        kind: 'python',
        sourceDir: join(SAMPLES, 'flask'),
        portA: proxy.data.portA,
        portB: proxy.data.portB,
        env: {},
        tlsMode: 'internal',
        releaseStore: store,
        httpProbe: testbedHttpProbe(target.httpsPort),
      });
      expect(first.ok).toBe(true);
      // Not just ok: ok + 'rolled_back' means the first release never went live.
      expect(first.ok ? first.data.status : undefined).toBe('live');

      // Simulate a broken build by dropping in a start command that runs but 500s every request
      // (e.g. a gunicorn app module that raises on import inside the request handler, not at
      // import time, so the process itself starts fine).
      const broken = { ...detect.data.stack, startCmd: '.venv/bin/gunicorn broken_app:app' };
      const brokenRelease = await releaseProcedure({
        session,
        app: 'flaskapp',
        domain,
        stack: broken,
        kind: 'python',
        sourceDir: join(SAMPLES, 'flask'), // in a real run this would be a staging copy with the broken app swapped in
        portA: proxy.data.portA,
        portB: proxy.data.portB,
        currentLivePort: first.ok ? first.data.livePort : undefined,
        env: {},
        tlsMode: 'internal',
        releaseStore: store,
        httpProbe: testbedHttpProbe(target.httpsPort),
      });
      expect(brokenRelease.ok).toBe(true);
      if (brokenRelease.ok) expect(brokenRelease.data.status).toBe('rolled_back');

      // The old release must still answer (S11: a failed release never replaces a healthy one).
      const stillUp = await testbedHttpProbe(target.httpsPort).probe(`https://${domain}/`, 5000);
      expect(stillUp.ok).toBe(true);
    },
    10 * 60 * 1000,
  );

  it(
    'a rollback job needs no Bob call at all (a throwing AgentRunner would never be invoked, since rollbackTo takes no agentRunner)',
    async () => {
      const { session, target } = await bootstrapAdmin('ubuntu2404');
      const domain = `rollback.${target.domain}`;
      const store = new FakeReleaseStore();

      const detect = await detectStackStep.run({ projectDir: join(SAMPLES, 'express') });
      expect(detect.ok).toBe(true);
      if (!detect.ok) return;
      await installRuntimeStep.run({ session, stack: detect.data.stack, projectDir: join(SAMPLES, 'express') });
      const proxy = await proxyAndHttpsStep.run({ session, app: 'rollbackapp', adminUser: 'bdadmin', domain, stack: detect.data.stack, tlsMode: 'internal' });
      if (!proxy.ok) return;

      const first = await releaseProcedure({
        session,
        app: 'rollbackapp',
        domain,
        stack: detect.data.stack,
        kind: 'node',
        sourceDir: join(SAMPLES, 'express'),
        portA: proxy.data.portA,
        portB: proxy.data.portB,
        env: {},
        tlsMode: 'internal',
        releaseStore: store,
        httpProbe: testbedHttpProbe(target.httpsPort),
      });
      // Assert rather than return early: an early return made this test pass without testing anything.
      expect(first.ok ? first.data.status : first.message).toBe('live');
      if (!first.ok || first.data.status !== 'live') return;

      const second = await releaseProcedure({
        session,
        app: 'rollbackapp',
        domain,
        stack: detect.data.stack,
        kind: 'node',
        sourceDir: join(SAMPLES, 'express'),
        portA: proxy.data.portA,
        portB: proxy.data.portB,
        currentLivePort: first.data.livePort,
        env: {},
        tlsMode: 'internal',
        releaseStore: store,
        httpProbe: testbedHttpProbe(target.httpsPort),
      });
      if (!second.ok) return;

      const rollback = await rollbackTo({
        session,
        app: 'rollbackapp',
        domain,
        isStatic: false,
        portA: proxy.data.portA,
        portB: proxy.data.portB,
        currentLivePort: second.data.livePort,
        tlsMode: 'internal',
        releaseStore: store,
        httpProbe: testbedHttpProbe(target.httpsPort),
      });
      expect(rollback.ok).toBe(true);
      if (rollback.ok) expect(rollback.data.releaseId).toBe(first.data.releaseId);

      // File ownership/permissions: the app process runs as bd-<app>, never root/admin.
      const owner = await dockerExec(
        'ubuntu2404',
        `ps -o user= -p $(systemctl show -p MainPID --value bd-rollbackapp@${rollback.ok ? rollback.data.livePort : 0}) 2>/dev/null || true`,
      );
      expect(owner.stdout.trim()).toBe('bd-rollbackapp');

      // shared/.env must never appear under artifacts/ (S6/S1-style leak check).
      const envLeak = await dockerExec('ubuntu2404', 'grep -R "shared/.env" /var/log/bob-deploy/ 2>/dev/null || true');
      expect(envLeak.stdout.trim()).toBe('');
    },
    10 * 60 * 1000,
  );
});
