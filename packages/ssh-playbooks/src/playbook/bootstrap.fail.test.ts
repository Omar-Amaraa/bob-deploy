import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { utils as ssh2Utils } from 'ssh2';
import { resetTestbed, testbedTarget } from '../testbed.js';
import { reachServerStep, createAdminStep, lockDownStep } from './bootstrap.js';
import { readLibBody, inlineLib } from '../../scripts-gen/build-scripts.mjs';
import type { GeneratedScript } from '../generated/scripts.js';

// Needs Docker + the testbed containers (see testbed/README.md). Run with `pnpm -w test:failure`.
// NOTE: as of A6, this cloud sandbox has no route to any container registry (see docs/HANDOFF.md's
// A5/A4/A6 entries), so this suite is written and reviewed but has not actually been executed here.

const noRedact = (s: string) => s;

/** Loads scripts/testing/20-sshd-harden.bd-inject-broken.sh (see its README) and inlines lib.sh
 * into it exactly the way scripts-gen/build-scripts.mjs does for the real scripts — this file is
 * never read by that generator, so it can never end up in src/generated/scripts.ts. */
function loadBrokenHardenScript(): GeneratedScript {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const path = join(__dirname, '..', '..', 'scripts', 'testing', '20-sshd-harden.bd-inject-broken.sh');
  const raw = readFileSync(path, 'utf8');
  const libBody = readLibBody();
  const content = inlineLib(raw, libBody, path) as string;
  return { name: '20-sshd-harden.bd-inject-broken.sh', content, sha256: createHash('sha256').update(content).digest('hex') };
}

function generateAdminKeypair(): { publicKey: string; privateKey: string } {
  const kp = ssh2Utils.generateKeyPairSync('ed25519', { comment: 'bd-bootstrap-fail-test' });
  return { publicKey: kp.public, privateKey: kp.private };
}

describe('S4: lockDownStep failure injection (admin key verified before root session closes; failure restores config)', () => {
  beforeAll(async () => {
    await resetTestbed('ubuntu2404');
  }, 10 * 60 * 1000);

  it(
    'restores the previous sshd config and fails HARDENING_FAILED when hardening locks the admin user out',
    async () => {
      const target = testbedTarget('ubuntu2404');
      const adminUser = 'bdadmin';
      const { publicKey, privateKey } = generateAdminKeypair();

      const reach = await reachServerStep.run({
        host: target.host,
        port: target.sshPort,
        auth: { password: target.rootPassword },
        onUnknownHostKey: () => Promise.resolve(true),
        redact: noRedact,
      });
      expect(reach.ok).toBe(true);
      if (!reach.ok) return;
      const { session: rootSession, fingerprint } = reach.data;

      try {
        const createAdmin = await createAdminStep.run({ session: rootSession, sudo: false, adminUser, publicKey });
        expect(createAdmin.ok).toBe(true);

        const lockDown = await lockDownStep.run({
          rootSession,
          rootSudo: false,
          adminUser,
          host: target.host,
          port: target.sshPort,
          adminAuth: { privateKey },
          redact: noRedact,
          hardenScript: loadBrokenHardenScript(),
        });

        expect(lockDown.ok).toBe(false);
        if (lockDown.ok) return;
        expect(lockDown.code).toBe('HARDENING_FAILED');
        expect(lockDown.message).toContain('restored');

        // The restore actually worked: the ROOT session (never closed) can still run commands,
        // and — the real proof — a brand new connection as root with the original password
        // succeeds again, meaning 21-sshd-restore.sh genuinely undid the broken AllowUsers line
        // rather than leaving the server locked out.
        const stillRoot = await rootSession.exec('whoami');
        expect(stillRoot.stdout.trim()).toBe('root');

        const { connectSsh } = await import('../ssh/session.js');
        const freshRoot = await connectSsh({
          host: target.host,
          port: target.sshPort,
          username: 'root',
          auth: { password: target.rootPassword },
          expectedFingerprint: fingerprint,
          redact: noRedact,
        });
        try {
          const whoami = await freshRoot.exec('whoami');
          expect(whoami.stdout.trim()).toBe('root');
        } finally {
          freshRoot.close();
        }
      } finally {
        rootSession.close();
      }
    },
    5 * 60 * 1000,
  );
});
