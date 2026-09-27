import { describe, it, expect, vi } from 'vitest';
import { createAdminStep, firewallAndPatchesStep } from './bootstrap.js';
import type { RemoteExec, ExecOptions, ExecResult } from '../ssh/types.js';

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, ...overrides };
}

/** A fake RemoteExec whose exec() responses are looked up by matching a substring of the command
 * (e.g. the script name is never in the command since scripts are piped via stdin, but callers can
 * still tell calls apart by order or by inspecting the recorded call log). */
function fakeRemoteExec(
  responses: ExecResult[],
): RemoteExec & {
  calls: Array<{ cmd: string; opts?: ExecOptions }>;
  uploadCalls: Array<{ local: string; remote: string }>;
} {
  const calls: Array<{ cmd: string; opts?: ExecOptions }> = [];
  const uploadCalls: Array<{ local: string; remote: string }> = [];
  let i = 0;
  return {
    calls,
    uploadCalls,
    exec(cmd: string, opts?: ExecOptions) {
      calls.push({ cmd, opts });
      const result = responses[i];
      i++;
      if (!result) throw new Error(`fakeRemoteExec: no response queued for call #${i}`);
      return Promise.resolve(result);
    },
    upload(local: string, remote: string) {
      uploadCalls.push({ local, remote });
      return Promise.resolve();
    },
    close: vi.fn(),
  };
}

describe('createAdminStep', () => {
  it('base64-encodes the public key and passes it as the second script arg', async () => {
    const exec = fakeRemoteExec([execResult({ stdout: 'BD_RESULT {"ok":true,"user":"deployer","created":"true"}\n' })]);
    const outcome = await createAdminStep.run({
      session: exec,
      sudo: false,
      adminUser: 'deployer',
      publicKey: 'ssh-ed25519 AAAAC3 comment',
    });
    expect(outcome).toEqual({ ok: true, data: { user: 'deployer', created: true } });
    const cmd = exec.calls[0]?.cmd ?? '';
    const b64 = Buffer.from('ssh-ed25519 AAAAC3 comment', 'utf8').toString('base64');
    expect(cmd).toContain(`'deployer'`);
    expect(cmd).toContain(b64);
  });

  it('maps a script failure through mapBdErrorCode', async () => {
    const exec = fakeRemoteExec([execResult({ code: 1, stdout: 'BD_RESULT {"ok":false,"error":"BD_INVALID_USER","message":"bad user"}\n' })]);
    const outcome = await createAdminStep.run({ session: exec, sudo: true, adminUser: 'x', publicKey: 'ssh-ed25519 AAAA' });
    expect(outcome).toMatchObject({ ok: false, code: 'VALIDATION', message: 'bad user' });
  });

  it('passes sudo through to exec', async () => {
    const exec = fakeRemoteExec([execResult({ stdout: 'BD_RESULT {"ok":true,"user":"u","created":"false"}\n' })]);
    await createAdminStep.run({ session: exec, sudo: true, adminUser: 'u', publicKey: 'ssh-ed25519 AAAA' });
    expect(exec.calls[0]?.opts?.sudo).toBe(true);
  });
});

describe('firewallAndPatchesStep', () => {
  it('uploads helpers to a private temp dir as the admin user, then installs them root-owned with sudo', async () => {
    const exec = fakeRemoteExec([
      execResult({ stdout: 'BD_RESULT {"ok":true,"ufw":"active","fail2ban":"active"}\n' }), // 30-firewall.sh
      execResult({ stdout: '/tmp/bd-helpers.Ab12Cd34\n' }), // mktemp (no sudo)
      execResult({ code: 0 }), // sudo install into the helpers dir
      execResult({ code: 0 }), // rm -rf temp dir
      execResult({ stdout: 'BD_RESULT {"ok":true,"helperCount":"12"}\n' }), // 40-install-helpers.sh
    ]);
    const outcome = await firewallAndPatchesStep.run({ session: exec, adminUser: 'deployer' });
    expect(outcome).toEqual({ ok: true, data: { ufw: 'active', fail2ban: 'active', helperCount: 12 } });

    expect(exec.calls[0]?.cmd).toBe('bash -s');
    expect(exec.calls[1]).toMatchObject({ cmd: 'mktemp -d /tmp/bd-helpers.XXXXXXXX' });
    expect(exec.calls[1]?.opts?.sudo).toBeFalsy();
    // SFTP can't sudo: every file lands in the admin-owned temp dir, never in the root-owned one.
    const remotePaths = exec.uploadCalls.map((c) => c.remote);
    expect(remotePaths.length).toBe(13); // 12 helpers + allowlist.txt
    expect(remotePaths.every((p) => p.startsWith('/tmp/bd-helpers.Ab12Cd34/'))).toBe(true);
    expect(remotePaths).toContain('/tmp/bd-helpers.Ab12Cd34/allowlist.txt');
    // Root copies them into place, root-owned, so the admin user can't rewrite what it may sudo.
    expect(exec.calls[2]?.opts?.sudo).toBe(true);
    expect(exec.calls[2]?.cmd).toContain("mkdir -p '/usr/local/lib/bob-deploy/bin'");
    expect(exec.calls[2]?.cmd).toContain('install -o root -g root -m 0755');
    expect(exec.calls[2]?.cmd).toContain("'/tmp/bd-helpers.Ab12Cd34/bd-app-setup'");
    expect(exec.calls[3]?.cmd).toBe("rm -rf '/tmp/bd-helpers.Ab12Cd34'");
    expect(exec.calls[4]?.cmd).toBe(`bash -s -- 'deployer'`);
  });

  it('fails with a clear message when root cannot install the uploaded helpers', async () => {
    const exec = fakeRemoteExec([
      execResult({ stdout: 'BD_RESULT {"ok":true,"ufw":"active","fail2ban":"active"}\n' }),
      execResult({ stdout: '/tmp/bd-helpers.Zz99Yy88\n' }),
      execResult({ code: 1, stderr: 'install: cannot create regular file' }),
      execResult({ code: 0 }),
    ]);
    const outcome = await firewallAndPatchesStep.run({ session: exec, adminUser: 'deployer' });
    expect(outcome).toMatchObject({ ok: false, code: 'HARDENING_FAILED' });
    expect(outcome.ok ? '' : outcome.message).toContain('install: cannot create regular file');
    expect(exec.calls[3]?.cmd).toBe("rm -rf '/tmp/bd-helpers.Zz99Yy88'"); // temp dir still cleaned up
  });

  it('stops and fails without uploading anything if the firewall script fails', async () => {
    const exec = fakeRemoteExec([execResult({ code: 1, stdout: 'BD_RESULT {"ok":false,"error":"BD_UFW_ENABLE_FAILED","message":"nope"}\n' })]);
    const outcome = await firewallAndPatchesStep.run({ session: exec, adminUser: 'deployer' });
    expect(outcome).toMatchObject({ ok: false, code: 'HARDENING_FAILED', message: 'nope' });
    expect(exec.uploadCalls.length).toBe(0);
  });

  it('fails if install-helpers fails after a successful upload', async () => {
    const exec = fakeRemoteExec([
      execResult({ stdout: 'BD_RESULT {"ok":true,"ufw":"active","fail2ban":"active"}\n' }),
      execResult({ stdout: '/tmp/bd-helpers.Qq11Ww22\n' }), // mktemp
      execResult({ code: 0 }), // sudo install
      execResult({ code: 0 }), // rm temp dir
      execResult({ code: 1, stdout: 'BD_RESULT {"ok":false,"error":"BD_HELPERS_MISSING","message":"missing"}\n' }),
    ]);
    const outcome = await firewallAndPatchesStep.run({ session: exec, adminUser: 'deployer' });
    expect(outcome).toMatchObject({ ok: false, code: 'HARDENING_FAILED', message: 'missing' });
  });
});
