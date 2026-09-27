import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { platform } from 'node:os';

/** Characters that are never allowed anywhere in a command string passed to runAllowed. */
const FORBIDDEN_CHARS = /[;&|`$()<>\n]/;

export interface RunAllowedOptions {
  cwd: string;
  /** Prefix-match allowlist: cmd must start with one of these (after normalisation). */
  allowed: string[];
  timeoutMs: number;
  /** Extra environment values layered on top of the minimal scrubbed env. Only NODE_ENV is read. */
  env?: { NODE_ENV?: string };
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  signal?: AbortSignal;
}

export interface RunAllowedResult {
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
}

/**
 * Splits a command string into argv, honoring single and double quotes. Not a full shell
 * grammar — deliberately: runAllowed never invokes a shell, so there is no escaping, globbing,
 * substitution or piping to support, only enough quoting to write `pip install -r requirements.txt`
 * style commands naturally in an allowlist.
 */
export function splitCommand(cmd: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function normalise(cmd: string): string {
  return cmd.trim().replace(/\s+/g, ' ');
}

function isAllowed(cmd: string, allowed: string[]): boolean {
  const normalised = normalise(cmd);
  return allowed.some((prefix) => {
    const normalisedPrefix = normalise(prefix);
    return normalised === normalisedPrefix || normalised.startsWith(`${normalisedPrefix} `);
  });
}

function minimalEnv(env?: RunAllowedOptions['env']): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
    CI: '1',
    npm_config_update_notifier: 'false',
  };
  if (platform() === 'win32') {
    scrubbed.USERPROFILE = process.env.USERPROFILE;
    scrubbed.SystemRoot = process.env.SystemRoot;
    scrubbed.ComSpec = process.env.ComSpec;
    scrubbed.PATHEXT = process.env.PATHEXT;
  }
  if (env?.NODE_ENV) scrubbed.NODE_ENV = env.NODE_ENV;
  return scrubbed;
}

/**
 * Runs `cmd` iff it matches the allowlist and contains none of the forbidden shell metacharacters,
 * spawning it directly (no shell) with a minimal, scrubbed environment. Kills the whole process
 * tree on timeout or abort.
 */
export async function runAllowed(cmd: string, options: RunAllowedOptions): Promise<RunAllowedResult> {
  if (FORBIDDEN_CHARS.test(cmd)) {
    throw new Error(`runAllowed: command contains a forbidden character: ${cmd}`);
  }
  if (!isAllowed(cmd, options.allowed)) {
    throw new Error(`runAllowed: command is not on the allowlist: ${cmd}`);
  }

  const argv = splitCommand(cmd);
  const [file, ...args] = argv;
  if (!file) {
    throw new Error('runAllowed: empty command');
  }

  return new Promise<RunAllowedResult>((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: minimalEnv(options.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Detached on POSIX so the child becomes its own process group leader, letting killTree
        // signal the whole tree via process.kill(-pid) rather than only the immediate child.
        detached: platform() !== 'win32',
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let settled = false;
    let timedOut = false;
    let aborted = false;

    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        if (platform() === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        } else {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        child.kill('SIGKILL');
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, options.timeoutMs);

    const onAbort = () => {
      aborted = true;
      killTree();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => options.onOutput?.(chunk.toString('utf8'), 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => options.onOutput?.(chunk.toString('utf8'), 'stderr'));

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
      resolvePromise({ code, timedOut, aborted });
    });
  });
}

/** Default allowlist for Node/JS projects (POSIX form; runAllowed matches by string prefix so the
 * caller substitutes the Windows-equivalent list on win32 rather than this module guessing). */
export const NODE_ALLOWED: readonly string[] = [
  'npm ci',
  'npm install',
  'npm run build',
  'npm run lint',
  'npm test',
  'npx --no-install tsc',
  'npx --no-install vite build',
  'npx --no-install next build',
];

/** Default allowlist for Python projects, POSIX venv layout (.venv/bin/...). */
export const PYTHON_ALLOWED: readonly string[] = [
  'python3 -m venv .venv',
  '.venv/bin/pip install -r requirements.txt',
  '.venv/bin/pip install .',
  '.venv/bin/python -m compileall',
  '.venv/bin/python -m pytest',
];

/** Windows-equivalent Python allowlist (.venv\Scripts\...), for callers running on win32. */
export const PYTHON_ALLOWED_WIN32: readonly string[] = [
  'python3 -m venv .venv',
  '.venv\\Scripts\\pip install -r requirements.txt',
  '.venv\\Scripts\\pip install .',
  '.venv\\Scripts\\python -m compileall',
  '.venv\\Scripts\\python -m pytest',
];
