import { EventEmitter } from 'node:events';

/** A fake ssh2 exec channel: a duplex-ish stream with a `.stderr` sub-emitter, matching just
 * enough of ssh2's ClientChannel surface for session.ts's exec() to work against. */
export class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  written: string[] = [];
  ended = false;
  closed = false;
  lastSignal: string | undefined;

  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  signal(name: string): void {
    this.lastSignal = name;
  }
  close(): void {
    this.closed = true;
  }
}

export class FakeSftp {
  fastPutCalls: Array<{ local: string; remote: string }> = [];
  chmodCalls: Array<{ path: string; mode: number }> = [];
  fastPutError: Error | undefined;

  fastPut(local: string, remote: string, cb: (err?: Error) => void): void {
    this.fastPutCalls.push({ local, remote });
    cb(this.fastPutError);
  }
  chmod(path: string, mode: number, cb: (err?: Error) => void): void {
    this.chmodCalls.push({ path, mode });
    cb();
  }
  endCalls = 0;
  end(): void {
    this.endCalls += 1;
  }
}

/** A fake ssh2 Client: `connect()` just records the config (nothing fires until the test calls
 * `verifyHostKey`/`emitReady`/`emitError`), and `exec`/`sftp` are synchronous so tests can grab the
 * returned FakeChannel/FakeSftp immediately and drive them. */
export class FakeClient extends EventEmitter {
  connectConfig:
    | {
        hostVerifier: (key: Buffer, verify: (accepted: boolean) => void) => void;
        [key: string]: unknown;
      }
    | undefined;
  execCalls: Array<{ cmd: string; channel: FakeChannel }> = [];
  readonly sftpInstance = new FakeSftp();
  ended = false;

  connect(config: FakeClient['connectConfig']): void {
    this.connectConfig = config;
  }

  /** Drives the configured hostVerifier as ssh2 itself would, given a raw host public key. */
  verifyHostKey(rawKey: Buffer): Promise<boolean> {
    return new Promise((resolve) => {
      this.connectConfig!.hostVerifier(rawKey, resolve);
    });
  }

  emitReady(): void {
    this.emit('ready');
  }
  emitError(err: Error): void {
    this.emit('error', err);
  }

  exec(cmd: string, cb: (err: Error | null, channel: FakeChannel) => void): void {
    const channel = new FakeChannel();
    this.execCalls.push({ cmd, channel });
    cb(null, channel);
  }

  sftp(cb: (err: Error | null, sftp: FakeSftp) => void): void {
    cb(null, this.sftpInstance);
  }

  end(): void {
    this.ended = true;
    this.emit('close');
  }
}
