import { access, constants } from 'node:fs/promises';
import { platform } from 'node:os';
import { runProcess, type SpawnFn } from './proc.js';

export class BobNotInstalledError extends Error {
  readonly code = 'BOB_NOT_INSTALLED';
  constructor(detail: string) {
    super(`Bob Shell could not be found: ${detail}`);
  }
}

/**
 * Resolves the `bob` binary: an explicit configured path (verified to exist) if given, otherwise
 * `which bob` (POSIX) or `where bob.cmd` (Windows) on PATH. Throws BobNotInstalledError if neither
 * works, per the brief's step 1.
 */
export async function resolveBobBinary(spawnFn: SpawnFn, binaryPath: string | undefined): Promise<string> {
  if (binaryPath) {
    try {
      await access(binaryPath, constants.X_OK);
      return binaryPath;
    } catch {
      throw new BobNotInstalledError(`configured binaryPath "${binaryPath}" is not an executable file`);
    }
  }

  const isWindows = platform() === 'win32';
  const finder = isWindows ? 'where' : 'which';
  const target = isWindows ? 'bob.cmd' : 'bob';
  try {
    const result = await runProcess(spawnFn, finder, [target], { cwd: process.cwd(), env: process.env, timeoutMs: 5000 });
    const firstLine = result.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (result.code === 0 && firstLine) return firstLine.trim();
  } catch {
    // fall through to the not-installed error below
  }
  throw new BobNotInstalledError(`"${finder} ${target}" did not resolve a binary on PATH`);
}
