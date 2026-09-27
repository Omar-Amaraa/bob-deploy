import { Client, type ClientChannel } from 'ssh2';
import { classifyConnectError, SshError } from './errors.js';
import { fingerprintOf, makeHostVerifier } from './host-verifier.js';
import { shellQuote } from './shell-quote.js';
import type { ExecOptions, ExecResult, SshConnectOptions, SshSession } from './types.js';

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const OUTPUT_CAP_BYTES = 10 * 1024 * 1024; // 10 MB, per stream

/** Appends `chunk` to `buf`, keeping at most OUTPUT_CAP_BYTES (dropping from the front, i.e.
 * keeping the tail) and reporting whether truncation has happened so far. */
function appendCapped(buf: Uint8Array, chunk: Uint8Array): { buf: Uint8Array; truncated: boolean } {
  const combined: Uint8Array = Buffer.concat([buf, chunk]);
  if (combined.length <= OUTPUT_CAP_BYTES) return { buf: combined, truncated: false };
  return { buf: combined.subarray(combined.length - OUTPUT_CAP_BYTES), truncated: true };
}

class SshSessionImpl implements SshSession {
  readonly fingerprint: string;
  readonly username: string;
  private readonly client: Client;
  private readonly redact: (s: string) => string;
  private closed = false;
  private closeCallbacks: Array<() => void> = [];

  constructor(client: Client, fingerprint: string, username: string, redact: (s: string) => string) {
    this.client = client;
    this.fingerprint = fingerprint;
    this.username = username;
    this.redact = redact;
    this.client.on('close', () => {
      this.closed = true;
      for (const cb of this.closeCallbacks) cb();
    });
  }

  onClose(cb: () => void): void {
    this.closeCallbacks.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.client.end();
  }

  exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const fullCmd = opts.sudo ? `sudo -n ${cmd}` : cmd;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

    return new Promise<ExecResult>((resolve, reject) => {
      this.client.exec(fullCmd, (err, stream: ClientChannel) => {
        if (err) return reject(classifyConnectError(err));

        let stdoutBuf: Uint8Array = Buffer.alloc(0);
        let stderrBuf: Uint8Array = Buffer.alloc(0);
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            stream.signal('KILL');
          } catch {
            // best effort — some servers don't implement the signal channel request
          }
          stream.close();
          reject(new SshError('SSH_TIMEOUT', `Command timed out after ${timeoutMs}ms.`));
        }, timeoutMs);

        stream.on('data', (chunk: Buffer) => {
          const appended = appendCapped(stdoutBuf, chunk);
          stdoutBuf = appended.buf;
          stdoutTruncated = stdoutTruncated || appended.truncated;
          opts.onOutput?.({ stream: 'stdout', text: this.redact(chunk.toString('utf8')) });
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          const appended = appendCapped(stderrBuf, chunk);
          stderrBuf = appended.buf;
          stderrTruncated = stderrTruncated || appended.truncated;
          opts.onOutput?.({ stream: 'stderr', text: this.redact(chunk.toString('utf8')) });
        });

        stream.on('close', (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            code: code ?? -1,
            stdout: this.redact(Buffer.from(stdoutBuf).toString('utf8')),
            stderr: this.redact(Buffer.from(stderrBuf).toString('utf8')),
            stdoutTruncated,
            stderrTruncated,
          });
        });

        if (opts.stdin !== undefined) {
          stream.write(opts.stdin);
        }
        stream.end();
      });
    });
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    const lastSlash = remotePath.lastIndexOf('/');
    const remoteDir = lastSlash > 0 ? remotePath.slice(0, lastSlash) : '/';

    const attempt = async (): Promise<void> => {
      await this.exec(`mkdir -p ${shellQuote(remoteDir)}`);
      await new Promise<void>((resolve, reject) => {
        this.client.sftp((err, sftp) => {
          if (err) return reject(classifyConnectError(err));
          // Always close the SFTP channel. Each call opens a new "session" channel on the SSH
          // connection, and sshd allows at most MaxSessions (default 10) open at once: leaving them
          // open made the 11th upload on one connection fail with "no more sessions" (reported as
          // "Could not connect to the server" while uploading the 13 bootstrap helpers).
          const finish = (finishErr?: Error | null): void => {
            try {
              sftp.end();
            } catch {
              // best effort: the channel may already be gone
            }
            if (finishErr) reject(finishErr);
            else resolve();
          };
          sftp.fastPut(localPath, remotePath, (fastPutErr) => {
            if (fastPutErr) return finish(fastPutErr);
            sftp.chmod(remotePath, 0o640, (chmodErr) => finish(chmodErr));
          });
        });
      });
    };

    try {
      await attempt();
    } catch {
      await attempt(); // one retry on transient failure
    }
  }
}

export interface ConnectSshDeps {
  createClient?: () => Client;
}

/** Connects only far enough to read the server's host key, then aborts the handshake before any
 * authentication. Used so the "is this your server?" question is never asked inside a live
 * handshake, where ssh2's readyTimeout and sshd's LoginGraceTime would both keep running. */
function probeHostFingerprint(opts: SshConnectOptions, deps: ConnectSshDeps): Promise<string> {
  const client = deps.createClient ? deps.createClient() : new Client();
  return new Promise<string>((resolve, reject) => {
    let fingerprint: string | undefined;
    let settled = false;
    const finish = (err?: unknown): void => {
      if (settled) return;
      settled = true;
      client.end();
      if (fingerprint) resolve(fingerprint);
      else reject(err instanceof SshError ? err : classifyConnectError(err));
    };
    client.on('error', (err) => finish(err));
    client.on('ready', () => finish()); // only if a server skipped host-key checking entirely
    client.connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      hostVerifier: (rawKey: Buffer, verify: (accepted: boolean) => void) => {
        fingerprint = fingerprintOf(rawKey);
        verify(false);
        finish();
      },
      readyTimeout: opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    });
  });
}

/** Opens an SSH connection per `opts`, verifying the host key (pinned or TOFU) before
 * authenticating. Rejects with a plain-language SshError (SSH_UNREACHABLE / SSH_AUTH_FAILED /
 * SSH_TIMEOUT / SSH_HOSTKEY_MISMATCH / SSH_HOSTKEY_REJECTED) rather than a raw ssh2 error.
 *
 * With no pinned fingerprint and an `onUnknownHostKey` prompt, this runs in two phases: read the
 * host key, ask (for as long as the user needs), then connect for real with that key pinned, so a
 * different server answering in between is rejected as SSH_HOSTKEY_MISMATCH. */
export async function connectSsh(opts: SshConnectOptions, deps: ConnectSshDeps = {}): Promise<SshSession> {
  if (opts.expectedFingerprint === undefined && opts.onUnknownHostKey) {
    const fingerprint = await probeHostFingerprint(opts, deps);
    let accepted = false;
    try {
      accepted = await opts.onUnknownHostKey(fingerprint);
    } catch {
      accepted = false;
    }
    if (!accepted) throw new SshError('SSH_HOSTKEY_REJECTED', 'The host key was not confirmed.', { fingerprint });
    return openSsh({ ...opts, expectedFingerprint: fingerprint, onUnknownHostKey: undefined }, deps);
  }
  return openSsh(opts, deps);
}

function openSsh(opts: SshConnectOptions, deps: ConnectSshDeps): Promise<SshSession> {
  const client = deps.createClient ? deps.createClient() : new Client();
  const hostVerifier = makeHostVerifier({
    expectedFingerprint: opts.expectedFingerprint,
    onUnknownHostKey: opts.onUnknownHostKey,
  });

  return new Promise<SshSession>((resolve, reject) => {
    let settled = false;

    client.on('ready', () => {
      if (settled) return;
      settled = true;
      resolve(new SshSessionImpl(client, hostVerifier.getFingerprint(), opts.username, opts.redact));
    });

    client.on('error', (err) => {
      if (settled) return;
      settled = true;
      const hostKeyError = hostVerifier.getError();
      reject(hostKeyError ?? classifyConnectError(err));
    });

    const authConfig = 'password' in opts.auth ? { password: opts.auth.password } : { privateKey: opts.auth.privateKey, passphrase: opts.auth.passphrase };

    client.connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      ...authConfig,
      hostVerifier: hostVerifier.verifier,
      readyTimeout: opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
    });
  });
}
