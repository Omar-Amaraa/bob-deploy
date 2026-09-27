/**
 * S3 — "After hardening: root login off, password login off, only admin allowed, ufw allows only
 * 22/tcp, 80/tcp, 443/tcp, 443/udp."
 *
 * The authoritative check is against a live server (`sshd -T`, `ufw status verbose`) in
 * bootstrap.int.test.ts (packages/ssh-playbooks/src/playbook/bootstrap.int.test.ts, tagged
 * "S3/S7" — not executed in this sandbox, no Docker). This file is the Docker-free complement:
 * it asserts the exact fixed script content that produces that server state, so a regression here
 * (e.g. someone loosening the sshd drop-in or the ufw allow list) fails CI immediately without
 * needing the testbed at all.
 */
import { describe, it, expect } from 'vitest';
import { BOOTSTRAP_SCRIPTS } from '@bob-deploy/ssh-playbooks';

function scriptContent(name: string): string {
  const script = BOOTSTRAP_SCRIPTS.find((s) => s.name === name);
  if (!script) throw new Error(`Generated script not found: ${name}`);
  return script.content;
}

describe('S3: the generated hardening/firewall scripts enforce exactly the required server state', () => {
  it('20-sshd-harden.sh writes a drop-in that disables root login, password auth, and restricts to the admin user only', () => {
    const content = scriptContent('20-sshd-harden.sh');
    expect(content).toContain('PermitRootLogin no');
    expect(content).toContain('PasswordAuthentication no');
    expect(content).toContain('KbdInteractiveAuthentication no');
    expect(content).toContain('AllowUsers ${ADMIN_USER}');
    expect(content).toContain('PubkeyAuthentication yes');
    // The drop-in is validated with `sshd -t` before being applied, and the daemon is reloaded —
    // a bad config never silently takes effect.
    expect(content).toMatch(/sshd -t/);
  });

  it('30-firewall.sh allows exactly 22/tcp, 80/tcp, 443/tcp, 443/udp and denies everything else by default', () => {
    const content = scriptContent('30-firewall.sh');
    expect(content).toContain('ufw default deny incoming');
    expect(content).toMatch(/ufw allow (OpenSSH|22\/tcp)/);
    expect(content).toContain('ufw allow 80/tcp');
    expect(content).toContain('ufw allow 443/tcp');
    expect(content).toContain('ufw allow 443/udp');
    // No other `ufw allow` rule for any other port/protocol exists in the script.
    const allowLines = content.match(/ufw allow [^\n]+/g) ?? [];
    for (const line of allowLines) {
      expect(line).toMatch(/22\/tcp|OpenSSH|80\/tcp|443\/tcp|443\/udp/);
    }
  });
});
