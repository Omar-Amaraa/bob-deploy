import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectSsh } from './session.js';
import { resetTestbed, testbedTarget } from '../testbed.js';

// Needs Docker + the testbed containers (see testbed/README.md). Run with `pnpm -w test:integration`.

beforeAll(async () => {
  await resetTestbed('ubuntu2404');
}, 10 * 60 * 1000);

const target = testbedTarget('ubuntu2404');
const noRedact = (s: string) => s;

describe('connectSsh against the testbed', () => {
  it('logs in as root with a password', async () => {
    const session = await connectSsh({
      host: target.host,
      port: target.sshPort,
      username: 'root',
      auth: { password: target.rootPassword },
      onUnknownHostKey: () => Promise.resolve(true),
      redact: noRedact,
    });
    try {
      const result = await session.exec('whoami');
      expect(result.stdout.trim()).toBe('root');
    } finally {
      session.close();
    }
  });

  it('calls onUnknownHostKey exactly once with a SHA256: fingerprint, then a pinned matching fingerprint is accepted without prompting', async () => {
    let calls = 0;
    let seenFingerprint = '';
    const first = await connectSsh({
      host: target.host,
      port: target.sshPort,
      username: 'root',
      auth: { password: target.rootPassword },
      onUnknownHostKey: (fp) => {
        calls++;
        seenFingerprint = fp;
        return Promise.resolve(true);
      },
      redact: noRedact,
    });
    first.close();
    expect(calls).toBe(1);
    expect(seenFingerprint).toMatch(/^SHA256:/);

    let secondPromptCalls = 0;
    const second = await connectSsh({
      host: target.host,
      port: target.sshPort,
      username: 'root',
      auth: { password: target.rootPassword },
      expectedFingerprint: seenFingerprint,
      onUnknownHostKey: () => {
        secondPromptCalls++;
        return Promise.resolve(true);
      },
      redact: noRedact,
    });
    second.close();
    expect(secondPromptCalls).toBe(0);
  });

  it('rejects a wrong pinned fingerprint with SSH_HOSTKEY_MISMATCH, never prompting', async () => {
    let promptCalls = 0;
    await expect(
      connectSsh({
        host: target.host,
        port: target.sshPort,
        username: 'root',
        auth: { password: target.rootPassword },
        expectedFingerprint: 'SHA256:' + 'A'.repeat(43),
        onUnknownHostKey: () => {
          promptCalls++;
          return Promise.resolve(true);
        },
        redact: noRedact,
      }),
    ).rejects.toMatchObject({ code: 'SSH_HOSTKEY_MISMATCH' });
    expect(promptCalls).toBe(0);
  });

  it('exec returns code/stdout/stderr and streams output in order', async () => {
    const session = await connectSsh({
      host: target.host,
      port: target.sshPort,
      username: 'root',
      auth: { password: target.rootPassword },
      onUnknownHostKey: () => Promise.resolve(true),
      redact: noRedact,
    });
    const seen: string[] = [];
    try {
      const result = await session.exec('echo one; echo two; echo three', { onOutput: (c) => seen.push(c.text.trim()) });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('one\ntwo\nthree\n');
      // The server may send the lines in one chunk or several: check order, not chunking.
      expect(seen.join('\n').split(/\n+/).filter(Boolean)).toEqual(['one', 'two', 'three']);
    } finally {
      session.close();
    }
  });

  it('times out a long-running command and rejects SSH_TIMEOUT', async () => {
    const session = await connectSsh({
      host: target.host,
      port: target.sshPort,
      username: 'root',
      auth: { password: target.rootPassword },
      onUnknownHostKey: () => Promise.resolve(true),
      redact: noRedact,
    });
    try {
      await expect(session.exec('sleep 30', { timeoutMs: 1000 })).rejects.toMatchObject({ code: 'SSH_TIMEOUT' });
    } finally {
      session.close();
    }
  }, 15_000);

  it('uploads a 5 MB file and the remote sha256sum matches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bd-ssh-upload-'));
    const localPath = join(dir, 'payload.bin');
    const data = randomBytes(5 * 1024 * 1024);
    writeFileSync(localPath, data);
    const expectedSha = createHash('sha256').update(data).digest('hex');

    const session = await connectSsh({
      host: target.host,
      port: target.sshPort,
      username: 'root',
      auth: { password: target.rootPassword },
      onUnknownHostKey: () => Promise.resolve(true),
      redact: noRedact,
    });
    try {
      await session.upload(localPath, '/tmp/bd-upload-test.bin');
      const result = await session.exec('sha256sum /tmp/bd-upload-test.bin');
      expect(result.stdout.trim().split(/\s+/)[0]).toBe(expectedSha);
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('a wrong password fails with SSH_AUTH_FAILED', async () => {
    await expect(
      connectSsh({
        host: target.host,
        port: target.sshPort,
        username: 'root',
        auth: { password: 'definitely-wrong' },
        onUnknownHostKey: () => Promise.resolve(true),
        redact: noRedact,
      }),
    ).rejects.toMatchObject({ code: 'SSH_AUTH_FAILED' });
  });

  it('a closed port fails with SSH_UNREACHABLE', async () => {
    await expect(
      connectSsh({
        host: target.host,
        port: 1, // nothing listens here
        username: 'root',
        auth: { password: target.rootPassword },
        onUnknownHostKey: () => Promise.resolve(true),
        redact: noRedact,
        readyTimeoutMs: 3000,
      }),
    ).rejects.toMatchObject({ code: 'SSH_UNREACHABLE' });
  }, 10_000);
});
