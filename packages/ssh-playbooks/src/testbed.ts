import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:process';

/** Repo-root testbed/ directory, resolved relative to this file so it works from both src (ts-node)
 * and the compiled dist/ output (same nesting depth under packages/ssh-playbooks/{src,dist}). */
const TESTBED_DIR = fileURLToPath(new URL('../../../testbed', import.meta.url));

export type TestbedService = 'ubuntu2404' | 'ubuntu2204';

const SSH_PORTS: Record<TestbedService, number> = { ubuntu2404: 2222, ubuntu2204: 2223 };
const HTTP_PORTS: Record<TestbedService, number> = { ubuntu2404: 8080, ubuntu2204: 8081 };
const HTTPS_PORTS: Record<TestbedService, number> = { ubuntu2404: 8443, ubuntu2204: 8444 };

export interface TestbedTarget {
  host: '127.0.0.1';
  sshPort: number;
  httpPort: number;
  httpsPort: number;
  rootPassword: string;
  /** A BOB_DEPLOY_TESTBED-mode-only domain; see DEC-020 and the fake DNS resolver it describes. */
  domain: string;
}

let cachedRootPassword: string | undefined;

function loadRootPassword(): string {
  if (cachedRootPassword === undefined) {
    const secretsPath = fileURLToPath(new URL('../../../testbed/test-secrets.json', import.meta.url));
    const secrets = JSON.parse(readFileSync(secretsPath, 'utf8')) as { rootPassword: string };
    cachedRootPassword = secrets.rootPassword;
  }
  return cachedRootPassword;
}

/** The connection details + fixed fake credentials for one testbed container. */
export function testbedTarget(service: TestbedService): TestbedTarget {
  return {
    host: '127.0.0.1',
    sshPort: SSH_PORTS[service],
    httpPort: HTTP_PORTS[service],
    httpsPort: HTTPS_PORTS[service],
    rootPassword: loadRootPassword(),
    domain: `${service}.bd.test`,
  };
}

function spawnAndWait(cmd: string, args: string[], opts: { cwd: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))));
  });
}

/**
 * Rebuilds and restarts one testbed service (or 'all') from a clean state, and waits until its
 * sshd is answering. Uses reset.sh on POSIX (bash + ssh-keyscan) and reset.mjs on Windows (pure
 * Node, no bash/ssh-keyscan dependency) — see testbed/README.md.
 */
export async function resetTestbed(service: TestbedService | 'all' = 'all'): Promise<void> {
  if (platform === 'win32') {
    await spawnAndWait('node', ['reset.mjs', service], { cwd: TESTBED_DIR });
  } else {
    await spawnAndWait('bash', ['reset.sh', service], { cwd: TESTBED_DIR });
  }
}

export interface DockerExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `docker compose exec -T <service> sh -c <cmd>` against a testbed container — for
 * out-of-band assertions in integration tests (reading `sshd -T`, `systemctl is-system-running`,
 * `ufw status`) that must not go through our own SSH client, since that's what's under test.
 */
export function dockerExec(service: TestbedService, cmd: string): Promise<DockerExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', 'exec', '-T', service, 'sh', '-c', cmd], { cwd: TESTBED_DIR });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
