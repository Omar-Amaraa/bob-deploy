import { describe, it, expect, beforeAll } from 'vitest';
import { utils as ssh2Utils } from 'ssh2';
import { resetTestbed, testbedTarget } from '../testbed.js';
import { reachServerStep, checkDnsStep, createAdminStep, lockDownStep, firewallAndPatchesStep } from './bootstrap.js';
import { testbedDnsResolver } from './dns.js';
import { dockerExec } from '../testbed.js';
import { HELPERS_ALLOWLIST } from '../generated/scripts.js';

// Needs Docker + the testbed containers (see testbed/README.md). Run with `pnpm -w test:integration`.
// NOTE: as of A6, this cloud sandbox has no route to any container registry (see docs/HANDOFF.md's
// A5/A4/A6 entries), so this suite is written and reviewed but has not actually been executed here.

const noRedact = (s: string) => s;

function generateAdminKeypair(): { publicKey: string; privateKey: string } {
  const kp = ssh2Utils.generateKeyPairSync('ed25519', { comment: 'bd-bootstrap-test' });
  return { publicKey: kp.public, privateKey: kp.private };
}

describe('S3/S7: bootstrap flow against the testbed (hardening, firewall, sudoers scoping)', () => {
  beforeAll(async () => {
    await resetTestbed('ubuntu2404');
  }, 10 * 60 * 1000);

  it(
    'runs reach_server -> check_dns -> create_admin -> lock_down -> firewall_and_patches end to end',
    async () => {
      const target = testbedTarget('ubuntu2404');
      const adminUser = 'bdadmin';
      const { publicKey, privateKey } = generateAdminKeypair();

      // Step 1: reach_server.
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
      expect(reach.data.os).toContain('ubuntu');
      expect(['x86_64', 'aarch64']).toContain(reach.data.arch);

      try {
        // Step 2: check_dns, using DEC-020's *.bd.test fake resolver against the testbed's own
        // domain (there is no real DNS record for it, and no real public IP to check against).
        const dnsOutcome = await checkDnsStep.run({
          domain: target.domain,
          serverIp: '127.0.0.1',
          dns: testbedDnsResolver(),
          useSslipFallback: false,
        });
        expect(dnsOutcome).toEqual({ ok: true, data: { domain: target.domain, usedFallback: false } });

        // Step 3: create_admin.
        const createAdmin = await createAdminStep.run({
          session: rootSession,
          sudo: false,
          adminUser,
          publicKey,
        });
        expect(createAdmin).toEqual({ ok: true, data: { user: adminUser, created: true } });

        // Re-running create_admin is idempotent: same user, created: false the second time.
        const createAdminAgain = await createAdminStep.run({
          session: rootSession,
          sudo: false,
          adminUser,
          publicKey,
        });
        expect(createAdminAgain).toEqual({ ok: true, data: { user: adminUser, created: false } });

        // Step 4: lock_down. Verifies a second session as the admin user before trusting it.
        const lockDown = await lockDownStep.run({
          rootSession,
          rootSudo: false,
          adminUser,
          host: target.host,
          port: target.sshPort,
          adminAuth: { privateKey },
          redact: noRedact,
        });
        expect(lockDown.ok).toBe(true);
        if (!lockDown.ok) return;
        const { adminSession } = lockDown.data;
        expect(adminSession.fingerprint).toBe(fingerprint);
        expect(adminSession.username).toBe(adminUser);

        try {
          // S3: verify the actual sshd config, not just the script's self-reported success.
          const sshdT = await dockerExec('ubuntu2404', 'sshd -T');
          expect(sshdT.stdout).toMatch(/^permitrootlogin no$/m);
          expect(sshdT.stdout).toMatch(/^passwordauthentication no$/m);
          expect(sshdT.stdout).toMatch(new RegExp(`^allowusers ${adminUser}$`, 'm'));

          // Root password login must now be rejected.
          await expect(
            (async () => {
              const { connectSsh } = await import('../ssh/session.js');
              return connectSsh({
                host: target.host,
                port: target.sshPort,
                username: 'root',
                auth: { password: target.rootPassword },
                onUnknownHostKey: () => Promise.resolve(true),
                redact: noRedact,
                readyTimeoutMs: 5000,
              });
            })(),
          ).rejects.toMatchObject({ code: 'SSH_AUTH_FAILED' });

          // Step 5: firewall_and_patches.
          const firewall = await firewallAndPatchesStep.run({ session: adminSession, adminUser });
          expect(firewall.ok).toBe(true);
          if (!firewall.ok) return;
          expect(firewall.data.ufw).toBe('active');
          expect(firewall.data.fail2ban).toBe('active');
          // One per allowlist.txt entry (derived, so adding a helper doesn't silently break this).
          expect(firewall.data.helperCount).toBe(
            HELPERS_ALLOWLIST.content.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#')).length,
          );

          // Out-of-band checks against the container directly (not through our own SSH client).
          const bootstrapped = await dockerExec('ubuntu2404', 'cat /etc/bob-deploy/bootstrapped');
          expect(bootstrapped.code).toBe(0);
          expect(bootstrapped.stdout.trim().length).toBeGreaterThan(0);

          const sudoersCheck = await dockerExec('ubuntu2404', `test -f /etc/sudoers.d/91-bob-deploy-helpers-${adminUser} && echo present`);
          expect(sudoersCheck.stdout.trim()).toBe('present');

          // S3: ufw allows only 22/tcp, 80/tcp, 443/tcp, 443/udp.
          const ufwStatus = await dockerExec('ubuntu2404', 'ufw status verbose');
          expect(ufwStatus.stdout).toMatch(/22\/tcp(?: \(OpenSSH\))?\s+ALLOW/); // ufw labels the OpenSSH app rule
          expect(ufwStatus.stdout).toMatch(/80\/tcp\s+ALLOW/);
          expect(ufwStatus.stdout).toMatch(/443\/tcp\s+ALLOW/);
          expect(ufwStatus.stdout).toMatch(/443\/udp\s+ALLOW/);

          // S7: the admin user has no general sudo — only the allowlisted bd-* helpers, NOPASSWD.
          const sudoList = await dockerExec('ubuntu2404', `sudo -n -l -U ${adminUser}`);
          expect(sudoList.stdout).toContain('/usr/local/lib/bob-deploy/bin/bd-service');
          expect(sudoList.stdout).not.toContain('ALL : ALL');
          const sudoApt = await dockerExec('ubuntu2404', `su - ${adminUser} -c 'sudo -n apt-get update'`);
          expect(sudoApt.code).not.toBe(0);

          // Re-running reach_server (now as the admin user, since root login is disabled) reports
          // the server as already bootstrapped.
          const reachAgain = await reachServerStep.run({
            host: target.host,
            port: target.sshPort,
            rootUser: adminUser,
            auth: { privateKey },
            expectedFingerprint: fingerprint,
            redact: noRedact,
          });
          expect(reachAgain).toMatchObject({ ok: false, code: 'SERVER_NOT_FRESH' });
        } finally {
          adminSession.close();
        }
      } finally {
        rootSession.close();
      }
    },
    5 * 60 * 1000,
  );
});
