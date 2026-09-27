#!/usr/bin/env node
// Windows-friendly equivalent of reset.sh (no bash/ssh-keyscan dependency): rebuilds and restarts
// one (or all) testbed service(s), then waits until each one's sshd is actually sending its banner
// before returning.
//
// Usage: node testbed/reset.mjs [ubuntu2404|ubuntu2204|all]   (default: all)
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const TESTBED_DIR = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 120_000;
const SSH_PORTS = { ubuntu2404: 2222, ubuntu2204: 2223 };

const service = process.argv[2] ?? 'all';
const services = service === 'all' ? Object.keys(SSH_PORTS) : [service];

for (const svc of services) {
  if (!(svc in SSH_PORTS)) {
    console.error(`Unknown testbed service: ${svc} (expected one of: ${Object.keys(SSH_PORTS).join(', ')}, or "all")`);
    process.exit(1);
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    console.log(`==> ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { cwd: TESTBED_DIR, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))));
  });
}

/** Resolves once the SSH banner ("SSH-2.0-...") is read from host:port, or rejects on timeout. */
function waitForSshBanner(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    function attempt() {
      const socket = connect({ host, port, timeout: 2000 });
      let settled = false;

      const cleanup = () => {
        socket.removeAllListeners();
        socket.destroy();
      };

      socket.on('data', (chunk) => {
        if (settled) return;
        if (chunk.toString('utf8').startsWith('SSH-')) {
          settled = true;
          cleanup();
          resolve();
        }
      });

      const retryOrFail = () => {
        if (settled) return;
        cleanup();
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for sshd banner on ${host}:${port}`));
        } else {
          setTimeout(attempt, 1000);
        }
      };

      socket.on('error', retryOrFail);
      socket.on('timeout', retryOrFail);
    }
    attempt();
  });
}

async function main() {
  await run('docker', ['compose', 'down', '-v']);
  await run('docker', ['compose', 'up', '-d', '--build', '--wait', ...services]);

  for (const svc of services) {
    const port = SSH_PORTS[svc];
    console.log(`==> Waiting for sshd on 127.0.0.1:${port} (service: ${svc}, timeout ${TIMEOUT_MS / 1000}s)`);
    try {
      await waitForSshBanner('127.0.0.1', port, TIMEOUT_MS);
    } catch (err) {
      console.error(`!! ${err.message}`);
      await run('docker', ['compose', 'logs', '--tail=100', svc]).catch(() => {});
      process.exit(1);
    }
    console.log(`==> ${svc}: sshd is answering on port ${port}`);
  }

  console.log(`==> Testbed ready: ${services.join(', ')}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
