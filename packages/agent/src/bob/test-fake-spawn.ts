import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess, SpawnOptionsWithoutStdio } from 'node:child_process';
import type { SpawnFn } from './proc.js';

export interface FakeSpawnCall {
  command: string;
  args: string[];
  options: SpawnOptionsWithoutStdio;
  stdinWritten: string;
}

export interface FakeSpawnScriptEntry {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  /** If true, never emits 'close' (used to test timeout/abort kill behaviour). */
  hang?: boolean;
  /** Run right when this call is made (before stdout/stderr/close), e.g. to simulate the spawned
   * process editing files in its cwd before it exits. */
  onInvoke?: () => void | Promise<void>;
}

/**
 * Builds a SpawnFn that never touches a real process: each call pops the next scripted response
 * (or repeats the last one if the script is shorter than the number of calls) and emits it as a
 * fake ChildProcess would. Every call's command/args/options/stdin are recorded in `calls` so tests
 * can assert on exactly what BobShellRunner would have spawned.
 */
export function makeFakeSpawn(script: FakeSpawnScriptEntry[]): { spawnFn: SpawnFn; calls: FakeSpawnCall[] } {
  const calls: FakeSpawnCall[] = [];
  let callIndex = 0;

  const spawnFn: SpawnFn = (command, args, options) => {
    const entry = script[Math.min(callIndex, script.length - 1)] ?? {};
    callIndex++;

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stdinWritten = '';
    const stdin = new Writable({
      write(chunk: Buffer | string, _enc, cb) {
        stdinWritten += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        cb();
      },
    });

    const emitter = new EventEmitter() as unknown as ChildProcess;
    let closed = false;
    const kill = () => {
      // Mimics a real kill: the process eventually reports its own close, exactly once.
      if (!closed) {
        closed = true;
        queueMicrotask(() => emitter.emit('close', null));
      }
      return true;
    };
    Object.assign(emitter, { stdout, stderr, stdin, pid: 4242, kill });

    const call: FakeSpawnCall = { command, args, options, stdinWritten: '' };
    calls.push(call);

    const invoke = async (): Promise<void> => {
      await entry.onInvoke?.();
      if (entry.stdout) stdout.write(entry.stdout);
      if (entry.stderr) stderr.write(entry.stderr);
      stdout.end();
      stderr.end();
      call.stdinWritten = stdinWritten;
      if (!entry.hang) {
        queueMicrotask(() => {
          if (closed) return;
          closed = true;
          emitter.emit('close', entry.code ?? 0);
        });
      }
    };
    queueMicrotask(() => void invoke());

    return emitter;
  };

  return { spawnFn, calls };
}
