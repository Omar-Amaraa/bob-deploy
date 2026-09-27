import spawn from 'cross-spawn';
import type { BobCheckResult } from '@bob-deploy/contracts';
import { buildBobArgs } from './args.js';
import { buildScrubbedEnv } from './env.js';
import { classifyBobFailure } from './failure.js';
import { runProcess, type SpawnFn } from './proc.js';
import { resolveBobBinary, BobNotInstalledError } from './resolve.js';
import type { BobShellRunnerConfig } from './runner.js';
import { extractBobResponseText } from './stream.js';

const MIN_NODE_VERSION = [22, 15, 0] as const;
const AUTH_CHECK_TIMEOUT_MS = 60000;

function parseVersion(text: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(actual: [number, number, number], minimum: readonly [number, number, number]): boolean {
  const [aMajor, aMinor, aPatch] = actual;
  const [mMajor, mMinor, mPatch] = minimum;
  if (aMajor !== mMajor) return aMajor > mMajor;
  if (aMinor !== mMinor) return aMinor > mMinor;
  return aPatch >= mPatch;
}

/**
 * Runs the four bob:check steps (binary, node, license, auth) the setup UI shows. Like
 * BobShellRunner itself, the "binary" and "auth" steps depend on args.ts's unverified
 * buildBobArgs/`--version` assumptions (see that file's doc comment) — everything here degrades to
 * an honest ok:false with a plain message rather than throwing if those assumptions are wrong.
 */
export async function checkBob(
  config: BobShellRunnerConfig,
  getApiKey: () => Promise<string>,
  bobHome: string,
  spawnFn: SpawnFn = spawn,
): Promise<BobCheckResult[]> {
  const results: BobCheckResult[] = [];

  let binaryPath: string | undefined;
  try {
    binaryPath = await resolveBobBinary(spawnFn, config.binaryPath);
    // Convention, not a verified flag (see args.ts) — most CLIs support --version directly.
    const versionResult = await runProcess(spawnFn, binaryPath, ['--version'], { cwd: process.cwd(), env: process.env, timeoutMs: 10000 });
    const version = versionResult.stdout.trim() || versionResult.stderr.trim();
    results.push(
      versionResult.code === 0
        ? { step: 'binary', ok: true, message: 'Bob Shell is installed.', value: version }
        : { step: 'binary', ok: false, message: 'The bob binary did not report a version.', value: version },
    );
  } catch (err) {
    const detail = err instanceof BobNotInstalledError ? err.message : String(err);
    results.push({ step: 'binary', ok: false, message: detail });
  }

  try {
    const nodeResult = await runProcess(spawnFn, 'node', ['--version'], { cwd: process.cwd(), env: process.env, timeoutMs: 10000 });
    const version = parseVersion(nodeResult.stdout);
    if (version && versionAtLeast(version, MIN_NODE_VERSION)) {
      results.push({ step: 'node', ok: true, message: 'Node.js version is supported.', value: nodeResult.stdout.trim() });
    } else {
      results.push({
        step: 'node',
        ok: false,
        message: `Node.js ${MIN_NODE_VERSION.join('.')} or newer is required.`,
        value: nodeResult.stdout.trim() || undefined,
      });
    }
  } catch (err) {
    results.push({ step: 'node', ok: false, message: err instanceof Error ? err.message : String(err) });
  }

  results.push(
    config.licenseAccepted
      ? { step: 'license', ok: true, message: 'License accepted.' }
      : { step: 'license', ok: false, message: 'The Bob Shell license has not been accepted yet.' },
  );

  if (binaryPath) {
    try {
      const apiKey = await getApiKey();
      const env = buildScrubbedEnv({ bobHome, apiKey });
      const args = buildBobArgs(config, { workspace: bobHome, maxTurns: 1 });
      const authResult = await runProcess(spawnFn, binaryPath, args, {
        cwd: bobHome,
        env,
        timeoutMs: AUTH_CHECK_TIMEOUT_MS,
        stdin: 'Reply with the single word OK.',
      });
      const response = extractBobResponseText(authResult.stdout);
      if (authResult.code === 0 && /\bOK\b/.test(response)) {
        results.push({ step: 'auth', ok: true, message: 'Authenticated with Bob Shell.' });
      } else {
        const failure = classifyBobFailure({ code: authResult.code, timedOut: authResult.timedOut, stderrTail: authResult.stderr.slice(-2000) });
        results.push({ step: 'auth', ok: false, message: failure.message });
      }
    } catch (err) {
      results.push({ step: 'auth', ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  } else {
    results.push({ step: 'auth', ok: false, message: 'Cannot check authentication without a working bob binary.' });
  }

  return results;
}
