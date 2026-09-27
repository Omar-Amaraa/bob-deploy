import { describe, it, expect, vi } from 'vitest';
import type { Client } from 'ssh2';
import { connectSsh } from './session.js';
import { FakeClient } from './testing/fake-client.js';

// A tiny stand-in redact function (this package doesn't depend on @bob-deploy/core), mirroring the
// shape core's Redactor#redact has: (s: string) => string.
function makeRedact(secret: string): (s: string) => string {
  return (s) => s.split(secret).join('[hidden]');
}

/** Polls (via microtask flushes) until the fake client has recorded its Nth exec() call. */
async function waitForExecCall(client: FakeClient, index: number) {
  for (let i = 0; i < 200; i++) {
    if (client.execCalls[index]) return client.execCalls[index];
    await Promise.resolve();
  }
  throw new Error(`exec call #${index} was not observed in time`);
}

/** Polls until the fake client has been handed its connect() config. */
async function waitForConnect(client: FakeClient) {
  for (let i = 0; i < 200; i++) {
    if (client.connectConfig) return;
    await Promise.resolve();
  }
  throw new Error('connect() was not observed in time');
}

/** TOFU connects twice: a probe that only reads the host key, then the real, pinned connection. */
function twoClients() {
  const probe = new FakeClient();
  const main = new FakeClient();
  const queue = [probe, main];
  return { probe, main, createClient: () => queue.shift() as unknown as Client };
}

async function connectViaFake(overrides: Partial<Parameters<typeof connectSsh>[0]> = {}) {
  const { probe, main, createClient } = twoClients();
  const promise = connectSsh(
    {
      host: '127.0.0.1',
      port: 2222,
      username: 'root',
      auth: { password: 'irrelevant' },
      onUnknownHostKey: () => Promise.resolve(true),
      redact: (s: string) => s,
      ...overrides,
    },
    { createClient },
  );
  await waitForConnect(probe);
  await probe.verifyHostKey(Buffer.from('fake-host-key'));
  await waitForConnect(main);
  await main.verifyHostKey(Buffer.from('fake-host-key'));
  main.emitReady();
  const session = await promise;
  return { client: main, session };
}

describe('connectSsh', () => {
  it('resolves a session with the fingerprint captured during host verification', async () => {
    const { session } = await connectViaFake();
    expect(session.fingerprint).toMatch(/^SHA256:/);
    expect(session.username).toBe('root');
  });

  it('rejects with a mapped SshError when the client errors before ready', async () => {
    const client = new FakeClient();
    const promise = connectSsh(
      { host: 'h', port: 22, username: 'root', auth: { password: 'x' }, redact: (s) => s },
      { createClient: () => client as unknown as Client },
    );
    client.emitError(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }));
    await expect(promise).rejects.toMatchObject({ code: 'SSH_UNREACHABLE' });
  });

  it('rejects with SSH_HOSTKEY_REJECTED when the TOFU prompt declines, without ever authenticating', async () => {
    const { probe, main, createClient } = twoClients();
    const promise = connectSsh(
      { host: 'h', port: 22, username: 'root', auth: { password: 'x' }, onUnknownHostKey: () => Promise.resolve(false), redact: (s) => s },
      { createClient },
    );
    await waitForConnect(probe);
    expect(await probe.verifyHostKey(Buffer.from('key'))).toBe(false); // probe never accepts
    await expect(promise).rejects.toMatchObject({ code: 'SSH_HOSTKEY_REJECTED' });
    expect(probe.connectConfig).not.toHaveProperty('password');
    expect(main.connectConfig).toBeUndefined();
  });

  it('asks outside the handshake: a slow answer cannot time the connection out', async () => {
    const { probe, main, createClient } = twoClients();
    let answer: (ok: boolean) => void = () => undefined;
    const promise = connectSsh(
      {
        host: 'h',
        port: 22,
        username: 'root',
        auth: { password: 'x' },
        onUnknownHostKey: () => new Promise<boolean>((resolve) => (answer = resolve)),
        redact: (s) => s,
      },
      { createClient },
    );
    await waitForConnect(probe);
    await probe.verifyHostKey(Buffer.from('server-key'));
    expect(probe.ended).toBe(true); // the probe connection is closed while the user thinks
    expect(main.connectConfig).toBeUndefined();
    answer(true);
    await waitForConnect(main);
    expect(await main.verifyHostKey(Buffer.from('server-key'))).toBe(true);
    main.emitReady();
    await expect(promise).resolves.toMatchObject({ username: 'root' });
  });

  it('rejects SSH_HOSTKEY_MISMATCH if a different server answers the real connection', async () => {
    const { probe, main, createClient } = twoClients();
    const promise = connectSsh(
      { host: 'h', port: 22, username: 'root', auth: { password: 'x' }, onUnknownHostKey: () => Promise.resolve(true), redact: (s) => s },
      { createClient },
    );
    await waitForConnect(probe);
    await probe.verifyHostKey(Buffer.from('confirmed-key'));
    await waitForConnect(main);
    expect(await main.verifyHostKey(Buffer.from('other-key'))).toBe(false);
    main.emitError(new Error('handshake aborted by client'));
    await expect(promise).rejects.toMatchObject({ code: 'SSH_HOSTKEY_MISMATCH' });
  });
});

describe('SshSession.exec', () => {
  it('resolves with code/stdout/stderr and never rejects on a non-zero exit', async () => {
    const { client, session } = await connectViaFake();
    const promise = session.exec('false');
    const { channel } = client.execCalls[0]!;
    channel.emit('data', Buffer.from('out'));
    channel.stderr.emit('data', Buffer.from('err'));
    channel.emit('close', 1);

    const result = await promise;
    expect(result).toEqual({ code: 1, stdout: 'out', stderr: 'err', stdoutTruncated: false, stderrTruncated: false });
  });

  it('prefixes `sudo -n ` when sudo is requested', async () => {
    const { client, session } = await connectViaFake();
    const promise = session.exec('whoami', { sudo: true });
    client.execCalls[0]!.channel.emit('close', 0);
    await promise;
    expect(client.execCalls[0]!.cmd).toBe('sudo -n whoami');
  });

  it('writes stdin and closes the stream', async () => {
    const { client, session } = await connectViaFake();
    const promise = session.exec('cat', { stdin: 'hello' });
    const { channel } = client.execCalls[0]!;
    channel.emit('close', 0);
    await promise;
    expect(channel.written).toEqual(['hello']);
    expect(channel.ended).toBe(true);
  });

  it('streams redacted output chunks through onOutput as they arrive', async () => {
    const { client, session } = await connectViaFake({ redact: makeRedact('sekrit') });
    const chunks: Array<{ stream: string; text: string }> = [];
    const promise = session.exec('echo', { onOutput: (c) => chunks.push(c) });
    const { channel } = client.execCalls[0]!;
    channel.emit('data', Buffer.from('token=sekrit-value'));
    channel.stderr.emit('data', Buffer.from('warn sekrit too'));
    channel.emit('close', 0);
    const result = await promise;

    expect(chunks).toEqual([
      { stream: 'stdout', text: 'token=[hidden]-value' },
      { stream: 'stderr', text: 'warn [hidden] too' },
    ]);
    expect(result.stdout).toBe('token=[hidden]-value');
    expect(result.stderr).toBe('warn [hidden] too');
  });

  it('caps stdout at 10 MB, keeping the tail and flagging truncation', async () => {
    const { client, session } = await connectViaFake();
    const promise = session.exec('yes');
    const { channel } = client.execCalls[0]!;
    const chunk = Buffer.alloc(1024 * 1024, 'a'); // 1 MB
    for (let i = 0; i < 11; i++) channel.emit('data', chunk); // 11 MB total
    channel.emit('close', 0);
    const result = await promise;
    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(10 * 1024 * 1024);
  });

  it('on timeout, sends SIGKILL, closes the channel, and rejects SSH_TIMEOUT', async () => {
    vi.useFakeTimers();
    try {
      const { client, session } = await connectViaFake();
      const promise = session.exec('sleep 30', { timeoutMs: 1000 });
      const { channel } = client.execCalls[0]!;
      vi.advanceTimersByTime(1001);
      await expect(promise).rejects.toMatchObject({ code: 'SSH_TIMEOUT' });
      expect(channel.lastSignal).toBe('KILL');
      expect(channel.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SshSession.upload', () => {
  it('creates the parent dir, fastPuts, and chmods 0640', async () => {
    const { client, session } = await connectViaFake();
    const uploadPromise = session.upload('/local/file.tar.gz', '/remote/dir/file.tar.gz');
    const mkdirCall = await waitForExecCall(client, 0);
    mkdirCall.channel.emit('close', 0);
    await uploadPromise;

    expect(mkdirCall.cmd).toBe("mkdir -p '/remote/dir'");
    expect(client.sftpInstance.fastPutCalls).toEqual([{ local: '/local/file.tar.gz', remote: '/remote/dir/file.tar.gz' }]);
    expect(client.sftpInstance.chmodCalls).toEqual([{ path: '/remote/dir/file.tar.gz', mode: 0o640 }]);
    // sshd caps open session channels per connection (MaxSessions, default 10): an SFTP channel
    // left open per upload broke the 11th upload of the bootstrap helpers.
    expect(client.sftpInstance.endCalls).toBe(1);
  });

  it('retries once on a transient fastPut failure', async () => {
    const { client, session } = await connectViaFake();
    client.sftpInstance.fastPutError = new Error('transient');
    const uploadPromise = session.upload('/local/f', '/remote/f');

    const firstMkdir = await waitForExecCall(client, 0);
    firstMkdir.channel.emit('close', 0);

    const secondMkdir = await waitForExecCall(client, 1);
    client.sftpInstance.fastPutError = undefined;
    secondMkdir.channel.emit('close', 0);

    await uploadPromise;
    expect(client.sftpInstance.fastPutCalls.length).toBe(2);
    expect(client.sftpInstance.endCalls).toBe(2); // the failed attempt's channel is closed too
  });
});

describe('SshSession.close', () => {
  it('is idempotent', async () => {
    const { client, session } = await connectViaFake();
    session.close();
    session.close();
    expect(client.ended).toBe(true);
  });

  it('onClose fires when the underlying client closes', async () => {
    const { session } = await connectViaFake();
    const cb = vi.fn();
    session.onClose(cb);
    session.close();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
