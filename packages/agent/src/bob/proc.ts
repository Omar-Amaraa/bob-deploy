import type { ChildProcess, SpawnOptionsWithoutStdio } from 'node:child_process';
import { platform } from 'node:os';

/** The subset of cross-spawn's signature BobShellRunner needs, so tests can inject a fake. */
export type SpawnFn = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcess;

export interface RunProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdin?: string;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  signal?: AbortSignal;
}

export interface RunProcessResult {
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  stdout: string;
  stderr: string;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (platform() === 'win32') {
      // Best-effort: no injectable spawn here since this only runs on failure paths in tests.
      child.kill();
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    child.kill('SIGKILL');
  }
}

/** Splits a stream of chunks into lines, calling `onLine` for each complete line as it becomes available. */
function makeLineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffer = '';
  return (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  };
}

/**
 * Runs `command` with `args` via `spawnFn` (never a shell), writes `stdin` if given and closes it,
 * streams stdout/stderr line by line via `onLine`, and enforces `timeoutMs` / `signal` by killing
 * the whole process tree. Used both for the real Bob Shell invocation and for checkBob's smaller
 * probes (node --version, a tiny auth prompt), so all of them get the same timeout/kill semantics.
 */
export function runProcess(spawnFn: SpawnFn, command: string, args: string[], options: RunProcessOptions): Promise<RunProcessResult> {
  return new Promise((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawnFn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: platform() !== 'win32',
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const onStdoutLine = makeLineSplitter((line) => options.onLine?.(line, 'stdout'));
    const onStderrLine = makeLineSplitter((line) => options.onLine?.(line, 'stderr'));

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      onStdoutLine(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      onStderrLine(chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);

    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin);
    }
    child.stdin?.end();

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolvePromise({ code, timedOut, aborted, stdout, stderr });
    });
  });
}
