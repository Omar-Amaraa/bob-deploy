/**
 * S7 — "Admin user has no general sudo; sudoers allows only
 * /usr/local/lib/bob-deploy/bin/bd-* helpers, each validating its arguments."
 *
 * Live-server verification (`sudo -n -l`, `sudo -n apt-get update` must fail) is in
 * bootstrap.int.test.ts (tagged "S3/S7" — not executed here, no Docker). This file asserts the
 * fixed script content that produces that state: 40-install-helpers.sh generates the sudoers file
 * from allowlist.txt one path at a time (never `ALL=(ALL) NOPASSWD:ALL`, which 10-create-admin.sh
 * *does* grant transiently — see the note below), and HELPERS_ALLOWLIST only ever lists paths
 * under the fixed helpers directory.
 */
import { describe, it, expect } from 'vitest';
import { BOOTSTRAP_SCRIPTS, HELPERS_ALLOWLIST } from '@bob-deploy/ssh-playbooks';

function scriptContent(name: string): string {
  const script = BOOTSTRAP_SCRIPTS.find((s) => s.name === name);
  if (!script) throw new Error(`Generated script not found: ${name}`);
  return script.content;
}

describe('S7: sudoers is regenerated scoped to exactly the allowlisted bd-* helper paths', () => {
  it('40-install-helpers.sh writes one NOPASSWD line per allowlisted path, scoped to root-run helpers only', () => {
    const content = scriptContent('40-install-helpers.sh');
    expect(content).toContain('%s ALL=(root) NOPASSWD: %s');
    expect(content).not.toContain('ALL=(ALL) NOPASSWD:ALL');
    // Every allowlist entry outside the fixed helpers dir is rejected before it can be used.
    expect(content).toMatch(/allowlist\.txt entry outside of \$\{HELPERS_DIR\}/);
    expect(content).toMatch(/visudo -cf/); // never trusts an unvalidated sudoers file
  });

  it('the compiled allowlist.txt only ever lists absolute /usr/local/lib/bob-deploy/bin/bd-* paths', () => {
    const paths = HELPERS_ALLOWLIST.content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path).toMatch(/^\/usr\/local\/lib\/bob-deploy\/bin\/bd-[a-z0-9-]+$/);
    }
  });

  it("10-create-admin.sh's temporary unscoped sudoers grant is revoked once 40-install-helpers.sh's scoped file is in place", () => {
    // This is the actual finding this suite exists to catch: 10-create-admin.sh grants
    // ALL=(ALL) NOPASSWD:ALL (needed transiently so the bootstrap sequence itself can run
    // privileged steps as the admin user) and, before this fix, nothing ever revoked it — so a
    // fully bootstrapped server left the admin user with unrestricted sudo, violating S7 outright
    // regardless of what the scoped 91- file said. Fixed in 40-install-helpers.sh (this task).
    const createAdmin = scriptContent('10-create-admin.sh');
    const installHelpers = scriptContent('40-install-helpers.sh');
    expect(createAdmin).toContain('/etc/sudoers.d/90-bob-deploy-${ADMIN_USER}');
    expect(createAdmin).toContain('ALL=(ALL) NOPASSWD:ALL');
    expect(installHelpers).toContain('/etc/sudoers.d/91-bob-deploy-helpers-${ADMIN_USER}');
    // The temporary grant is removed only *after* the scoped file is written and validated —
    // i.e. this line appears after the 91- sudoers block in the script, not before it.
    const revokeIdx = installHelpers.indexOf('rm -f "/etc/sudoers.d/90-bob-deploy-${ADMIN_USER}"');
    const scopedIdx = installHelpers.indexOf('/etc/sudoers.d/91-bob-deploy-helpers-${ADMIN_USER}');
    expect(revokeIdx).toBeGreaterThan(-1);
    expect(revokeIdx).toBeGreaterThan(scopedIdx);
    expect(installHelpers).toContain('gpasswd -d "$ADMIN_USER" sudo');
  });
});
