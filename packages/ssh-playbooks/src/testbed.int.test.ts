import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from 'ssh2';
import { resetTestbed, testbedTarget, dockerExec, type TestbedService } from './testbed.js';

// Needs Docker (and, on first run, outbound internet to pull/build the ubuntu base images) — see
// testbed/README.md. Run with `pnpm -w test:integration` (or `bash testbed/reset.sh all` first if
// you want the containers left running for manual poking afterwards).

const SERVICES: TestbedService[] = ['ubuntu2404', 'ubuntu2204'];

beforeAll(async () => {
  const start = Date.now();
  await resetTestbed('all');
  // Acceptance: total reset time < 3 min per service after the first build.
  expect(Date.now() - start).toBeLessThan(SERVICES.length * 3 * 60 * 1000);
}, 10 * 60 * 1000); // generous timeout for the *first* build, which pulls/builds the base images

function sshLoginWithPassword(host: string, port: number, username: string, password: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client
      .on('ready', () => resolve(client))
      .on('error', reject)
      .connect({ host, port, username, password, readyTimeout: 20_000 });
  });
}

function execOnce(client: Client, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream
        .on('close', (code: number) => resolve({ code, stdout, stderr }))
        .on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
        .stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    });
  });
}

describe.each(SERVICES)('testbed: %s', (service) => {
  it('root can log in with a password and run a command', async () => {
    const target = testbedTarget(service);
    const client = await sshLoginWithPassword(target.host, target.sshPort, 'root', target.rootPassword);
    try {
      const result = await execOnce(client, 'whoami');
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('root');
    } finally {
      client.end();
    }
  });

  it('systemd reports running or degraded', async () => {
    const result = await dockerExec(service, 'systemctl is-system-running --wait || true');
    expect(['running', 'degraded']).toContain(result.stdout.trim());
  });

  it('ufw is installed and responds to `ufw status`', async () => {
    const result = await dockerExec(service, 'ufw status');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Status: (active|inactive)/);
  });

  it('has outbound internet for apt (`apt-get update` succeeds)', async () => {
    const result = await dockerExec(service, 'apt-get update');
    expect(result.code).toBe(0);
  }, 60_000);
});
