import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectSsh } from '../ssh/session.js';
import { SshError } from '../ssh/errors.js';
import type { SshConnectOptions, SshSession, RemoteExec } from '../ssh/types.js';
import { BOOTSTRAP_SCRIPTS, HELPER_SCRIPTS, HELPERS_ALLOWLIST, type GeneratedScript } from '../generated/scripts.js';
import { runScript } from './run-script.js';
import { mapBdErrorCode } from './error-mapping.js';
import { sslipDomainFor, type DnsResolver } from './dns.js';
import { stepFail, stepOk, type PlaybookStep, type PlaybookStepOutcome } from './types.js';

function scriptByName(name: string): GeneratedScript {
  const found = BOOTSTRAP_SCRIPTS.find((s) => s.name === name);
  if (!found) throw new Error(`No generated bootstrap script named "${name}" (this is a bug).`);
  return found;
}

// ---------------------------------------------------------------------------------------------
// Step 1: reach_server
// ---------------------------------------------------------------------------------------------

export interface ReachServerInput {
  host: string;
  port: number;
  /** The account used to bootstrap the box before the admin user exists. Almost always "root";
   * some providers (e.g. some AWS/Ubuntu AMIs) instead give a sudo-capable non-root user such as
   * "ubuntu" — in that case every script run in this flow is prefixed with `sudo -n`. */
  rootUser?: string;
  auth: SshConnectOptions['auth'];
  expectedFingerprint?: string;
  onUnknownHostKey?: (fingerprint: string) => Promise<boolean>;
  readyTimeoutMs?: number;
  redact: (s: string) => string;
}

export interface ReachServerOutput {
  session: SshSession;
  fingerprint: string;
  rootUser: string;
  os: string;
  arch: string;
}

export const reachServerStep: PlaybookStep<ReachServerInput, ReachServerOutput> = {
  id: 'reach_server',
  title: 'Connect to the server',
  async run(input): Promise<PlaybookStepOutcome<ReachServerOutput>> {
    const rootUser = input.rootUser ?? 'root';
    const needsSudo = rootUser !== 'root';

    let session: SshSession;
    try {
      session = await connectSsh({
        host: input.host,
        port: input.port,
        username: rootUser,
        auth: input.auth,
        expectedFingerprint: input.expectedFingerprint,
        onUnknownHostKey: input.onUnknownHostKey,
        readyTimeoutMs: input.readyTimeoutMs,
        redact: input.redact,
      });
    } catch (err) {
      if (err instanceof SshError) return stepFail(err.code, err.message, err.details);
      return stepFail('SSH_UNREACHABLE', err instanceof Error ? err.message : 'Failed to connect to the server.');
    }

    // Checked before (and without) sudo: once bootstrapped, the admin user may only sudo the bd-*
    // helpers, so 00-preflight.sh itself would be refused ("a password is required") and the user
    // would see a confusing INTERNAL error instead of "already set up". The marker is world-readable.
    const marker = await session.exec('test -f /etc/bob-deploy/bootstrapped');
    if (marker.code === 0) {
      session.close();
      return stepFail('SERVER_NOT_FRESH', 'This server has already been bootstrapped by Bob Deploy.');
    }

    const preflight = await runScript(session, scriptByName('00-preflight.sh'), [], { sudo: needsSudo });
    if (!preflight.outcome.ok) {
      session.close();
      return stepFail(mapBdErrorCode(preflight.outcome.code), preflight.outcome.message, {
        stderr: preflight.exec.stderr,
      });
    }

    if (preflight.outcome.data['alreadyBootstrapped'] === 'true') {
      session.close();
      return stepFail('SERVER_NOT_FRESH', 'This server has already been bootstrapped by Bob Deploy.');
    }

    return stepOk({
      session,
      fingerprint: session.fingerprint,
      rootUser,
      os: preflight.outcome.data['os'] ?? '',
      arch: preflight.outcome.data['arch'] ?? '',
    });
  },
};

// ---------------------------------------------------------------------------------------------
// Step 2: check_dns
// ---------------------------------------------------------------------------------------------

export interface CheckDnsInput {
  /** The domain the user wants to use, if any. Undefined means "no domain yet — use the fallback". */
  domain?: string;
  serverIp: string;
  dns: DnsResolver;
  /** Whether falling back to a sslip.io wildcard domain is acceptable when `domain` is missing or
   * doesn't yet resolve to `serverIp`. */
  useSslipFallback: boolean;
}

export interface CheckDnsOutput {
  domain: string;
  usedFallback: boolean;
}

export const checkDnsStep: PlaybookStep<CheckDnsInput, CheckDnsOutput> = {
  id: 'check_dns',
  title: 'Check DNS',
  async run(input): Promise<PlaybookStepOutcome<CheckDnsOutput>> {
    if (input.domain) {
      const addresses = await input.dns.resolveA(input.domain);
      if (addresses.includes(input.serverIp)) {
        return stepOk({ domain: input.domain, usedFallback: false });
      }
      if (!input.useSslipFallback) {
        return stepFail(
          'DNS_MISMATCH',
          addresses.length === 0
            ? `${input.domain} does not have an A record yet. Point it at ${input.serverIp} and try again.`
            : `${input.domain} points at ${addresses.join(', ')}, not ${input.serverIp}.`,
        );
      }
    } else if (!input.useSslipFallback) {
      return stepFail('DNS_MISMATCH', 'No domain was given and the sslip.io fallback is disabled.');
    }

    return stepOk({ domain: sslipDomainFor(input.serverIp), usedFallback: true });
  },
};

// ---------------------------------------------------------------------------------------------
// Step 3: create_admin
// ---------------------------------------------------------------------------------------------

export interface CreateAdminInput {
  session: RemoteExec;
  sudo: boolean;
  adminUser: string;
  /** A single "ssh-<type> <key> [comment]" OpenSSH public key line. */
  publicKey: string;
}

export interface CreateAdminOutput {
  user: string;
  created: boolean;
}

export const createAdminStep: PlaybookStep<CreateAdminInput, CreateAdminOutput> = {
  id: 'create_admin',
  title: 'Create the admin user',
  async run(input): Promise<PlaybookStepOutcome<CreateAdminOutput>> {
    const pubkeyB64 = Buffer.from(input.publicKey, 'utf8').toString('base64');
    const { outcome, exec } = await runScript(
      input.session,
      scriptByName('10-create-admin.sh'),
      [input.adminUser, pubkeyB64],
      { sudo: input.sudo },
    );
    if (!outcome.ok) {
      return stepFail(mapBdErrorCode(outcome.code), outcome.message, { stderr: exec.stderr });
    }
    return stepOk({ user: outcome.data['user'] ?? input.adminUser, created: outcome.data['created'] === 'true' });
  },
};

// ---------------------------------------------------------------------------------------------
// Step 4: lock_down
// ---------------------------------------------------------------------------------------------

export interface LockDownInput {
  /** The still-open connection used to bootstrap so far (root, or a sudo-capable rootUser). */
  rootSession: SshSession;
  rootSudo: boolean;
  adminUser: string;
  host: string;
  port: number;
  adminAuth: SshConnectOptions['auth'];
  redact: (s: string) => string;
  /** Test seam only (mirrors connectSsh's ConnectSshDeps): overrides which script runs the
   * hardening step. Production code never sets this — it's how src/**\/*.fail.test.ts exercises
   * the restore-on-failure path below with a script that deliberately locks the admin user out.
   * See scripts/testing/README.md. */
  hardenScript?: GeneratedScript;
}

export interface LockDownOutput {
  /** A fresh connection as the admin user, proven to work before sshd's old config was discarded. */
  adminSession: SshSession;
  backupDir: string;
}

export const lockDownStep: PlaybookStep<LockDownInput, LockDownOutput> = {
  id: 'lock_down',
  title: 'Lock down SSH access',
  async run(input): Promise<PlaybookStepOutcome<LockDownOutput>> {
    const harden = await runScript(
      input.rootSession,
      input.hardenScript ?? scriptByName('20-sshd-harden.sh'),
      [input.adminUser],
      { sudo: input.rootSudo },
    );
    if (!harden.outcome.ok) {
      return stepFail(mapBdErrorCode(harden.outcome.code), harden.outcome.message, {
        stderr: harden.exec.stderr,
      });
    }
    const backupDir = harden.outcome.data['backupDir'] ?? '';

    // Verify a *second*, independent connection as the admin user works before treating hardening
    // as done — this is the whole point of doing it this way rather than trusting the script alone.
    let adminSession: SshSession;
    try {
      adminSession = await connectSsh({
        host: input.host,
        port: input.port,
        username: input.adminUser,
        auth: input.adminAuth,
        // The host key can't have changed (same server, same connection window); pin it so this
        // verification never itself prompts.
        expectedFingerprint: input.rootSession.fingerprint,
        redact: input.redact,
      });
    } catch (verifyErr) {
      const restore = await runScript(input.rootSession, scriptByName('21-sshd-restore.sh'), [backupDir], {
        sudo: input.rootSudo,
      });
      const verifyMessage = verifyErr instanceof Error ? verifyErr.message : 'Could not verify admin access.';
      if (!restore.outcome.ok) {
        return stepFail(
          'HARDENING_FAILED',
          `Locking down SSH broke access as ${input.adminUser} (${verifyMessage}), and restoring the ` +
            `previous sshd config also failed: ${restore.outcome.message}. Root access via the ` +
            'original session may still work — do not close it.',
        );
      }
      return stepFail(
        'HARDENING_FAILED',
        `Locking down SSH broke access as ${input.adminUser} (${verifyMessage}). The previous sshd ` +
          'config was restored automatically.',
      );
    }

    return stepOk({ adminSession, backupDir });
  },
};

// ---------------------------------------------------------------------------------------------
// Step 5: firewall_and_patches
// ---------------------------------------------------------------------------------------------

export interface FirewallAndPatchesInput {
  /** The admin session established in lock_down — always key-only, always sudo-capable. */
  session: RemoteExec;
  adminUser: string;
}

export interface FirewallAndPatchesOutput {
  ufw: string;
  fail2ban: string;
  helperCount: number;
}

const HELPERS_DIR = '/usr/local/lib/bob-deploy/bin';

/** Writes each helper script + allowlist.txt to a scratch local dir and puts them in
 * /usr/local/lib/bob-deploy/bin/ on the server (needed as real files there, since
 * 40-install-helpers.sh's allowlist and sudoers entries point at them).
 *
 * SFTP runs as the admin user and cannot sudo, while the helpers dir must be root-owned (the admin
 * user may run these files as root, so it must never be able to write them). So: upload into a
 * private mktemp dir the admin user owns, then have root `install` copies into place, owned by
 * root, and remove the temp dir. Uploading straight into the root-owned dir failed with
 * "Permission denied" on every real bootstrap. */
async function uploadHelpers(session: RemoteExec): Promise<void> {
  const localDir = await mkdtemp(join(tmpdir(), 'bd-helpers-'));
  let remoteTmp: string | undefined;
  try {
    const made = await session.exec('mktemp -d /tmp/bd-helpers.XXXXXXXX');
    remoteTmp = made.stdout.trim();
    if (made.code !== 0 || !/^\/tmp\/bd-helpers\.[A-Za-z0-9]+$/.test(remoteTmp)) {
      throw new Error(`could not create a temporary folder on the server: ${made.stderr || made.stdout}`);
    }
    const files: GeneratedScript[] = [...HELPER_SCRIPTS, HELPERS_ALLOWLIST];
    for (const file of files) {
      const localPath = join(localDir, file.name);
      await writeFile(localPath, file.content, 'utf8');
      await session.upload(localPath, `${remoteTmp}/${file.name}`);
    }
    const names = files.map((f) => `'${remoteTmp}/${f.name}'`).join(' ');
    const placed = await session.exec(
      `sh -c "mkdir -p '${HELPERS_DIR}' && install -o root -g root -m 0755 ${names} '${HELPERS_DIR}/'"`,
      { sudo: true },
    );
    if (placed.code !== 0) throw new Error(placed.stderr || placed.stdout || `install exited with ${placed.code}`);
  } finally {
    if (remoteTmp && /^\/tmp\/bd-helpers\.[A-Za-z0-9]+$/.test(remoteTmp)) {
      await session.exec(`rm -rf '${remoteTmp}'`).catch(() => undefined);
    }
    await rm(localDir, { recursive: true, force: true });
  }
}

export const firewallAndPatchesStep: PlaybookStep<FirewallAndPatchesInput, FirewallAndPatchesOutput> = {
  id: 'firewall_and_patches',
  title: 'Configure the firewall and install helpers',
  async run(input): Promise<PlaybookStepOutcome<FirewallAndPatchesOutput>> {
    const firewall = await runScript(input.session, scriptByName('30-firewall.sh'), [], { sudo: true });
    if (!firewall.outcome.ok) {
      return stepFail(mapBdErrorCode(firewall.outcome.code), firewall.outcome.message, {
        stderr: firewall.exec.stderr,
      });
    }

    try {
      await uploadHelpers(input.session);
    } catch (err) {
      // SshError keeps the raw ssh2 reason in details.cause; without it every channel/transport
      // failure reads as the same "Could not connect to the server".
      const cause = err instanceof SshError && typeof err.details?.['cause'] === 'string' ? ` (${err.details['cause']})` : '';
      return stepFail(
        'HARDENING_FAILED',
        `Failed to upload the helper scripts: ${err instanceof Error ? err.message : String(err)}${cause}`,
      );
    }

    const install = await runScript(input.session, scriptByName('40-install-helpers.sh'), [input.adminUser], {
      sudo: true,
    });
    if (!install.outcome.ok) {
      return stepFail(mapBdErrorCode(install.outcome.code), install.outcome.message, {
        stderr: install.exec.stderr,
      });
    }

    return stepOk({
      ufw: firewall.outcome.data['ufw'] ?? '',
      fail2ban: firewall.outcome.data['fail2ban'] ?? '',
      helperCount: Number(install.outcome.data['helperCount'] ?? '0'),
    });
  },
};
