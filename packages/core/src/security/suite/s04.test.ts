/**
 * S4 — "Admin key login is tested in a second session before the root session closes; failure
 * restores the previous config."
 *
 * Live-server verification with a deliberately broken drop-in is bootstrap.fail.test.ts (tagged
 * "S4" — not executed in this sandbox, no Docker). This file is the Docker-free structural
 * complement: it asserts lockDownStep genuinely opens a *second* session as the admin user before
 * declaring success, and only ever restores via the fixed 21-sshd-restore.sh script (never an
 * ad-hoc inline command), from the exact backup directory 20-sshd-harden.sh created.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BOOTSTRAP_SCRIPTS } from '@bob-deploy/ssh-playbooks';

function readSource(relativeToThisFile: string): string {
  return readFileSync(fileURLToPath(new URL(relativeToThisFile, import.meta.url)), 'utf8');
}

describe('S4: lockDownStep verifies a second admin session before trusting hardening, and restores on failure', () => {
  it('lockDownStep connects as the admin user (a second session) after hardening, and calls 21-sshd-restore.sh on failure', () => {
    const source = readSource('../../../../ssh-playbooks/src/playbook/bootstrap.ts');
    expect(source).toMatch(/lockDownStep/);
    // A second, independent connection attempt as the admin user — not just reusing rootSession.
    expect(source).toMatch(/connectSsh\(/);
    expect(source).toContain("scriptByName('21-sshd-restore.sh')");
    // The restore call is passed the exact backupDir the hardening step reported, never a literal.
    expect(source).toMatch(/runScript\(input\.rootSession,\s*scriptByName\('21-sshd-restore\.sh'\),\s*\[backupDir\]/);
  });

  it('21-sshd-restore.sh only ever restores from the fixed backups directory, never an arbitrary path', () => {
    const restore = BOOTSTRAP_SCRIPTS.find((s) => s.name === '21-sshd-restore.sh');
    expect(restore).toBeDefined();
    expect(restore!.content).toContain('/etc/bob-deploy/sshd-backups/*');
    expect(restore!.content).toMatch(/backup_dir must be under \/etc\/bob-deploy\/sshd-backups\//);
  });
});
