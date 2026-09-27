import { shellQuote } from '../ssh/shell-quote.js';
import type { RemoteExec, ExecOptions, ExecResult, ExecOutputChunk } from '../ssh/types.js';
import { HELPER_SCRIPTS, type GeneratedScript } from '../generated/scripts.js';

/** Where 40-install-helpers.sh installs the bd-* helpers (root-owned, 0755). */
export const HELPERS_BIN_DIR = '/usr/local/lib/bob-deploy/bin';

const HELPER_NAMES: ReadonlySet<string> = new Set(HELPER_SCRIPTS.map((h) => h.name));

const RESULT_PREFIX = 'BD_RESULT ';

export interface RunScriptOptions {
  sudo?: boolean;
  /** Default 120000 (see ExecOptions). */
  timeoutMs?: number;
  onOutput?: (chunk: ExecOutputChunk) => void;
}

export interface RunScriptSuccess {
  readonly ok: true;
  /** Every field the script's `result` call included, besides "ok", stringified. */
  readonly data: Record<string, string>;
}

export interface RunScriptFailure {
  readonly ok: false;
  /** The script's own BD_* error code (from `die`), or one of this module's BD_* codes below when
   * the script didn't produce a well-formed BD_RESULT line at all. */
  readonly code: string;
  readonly message: string;
}

export type RunScriptOutcome = RunScriptSuccess | RunScriptFailure;

export interface RunScriptResult {
  readonly outcome: RunScriptOutcome;
  /** The raw exec result (exit code, full stdout/stderr), for logging and diagnostics. */
  readonly exec: ExecResult;
}

/**
 * Runs one of packages/ssh-playbooks/scripts's generated scripts (a `GeneratedScript` from
 * src/generated/scripts.ts) on the remote server by piping its content over stdin to `bash -s`,
 * with `args` passed through as $1, $2, ... — no upload or temp file needed, since the script
 * never has to be referenced by path on the remote end.
 *
 * Parses the script's required `BD_RESULT {...}` last line (see scripts/lib.sh's `result`/`die`)
 * into a typed outcome. A script that exits without printing that line, or prints one that isn't
 * valid JSON with a boolean `ok` field, is treated as a failure with a `BD_*` code of this module's
 * own (never a silent success).
 */
export async function runScript(
  exec: RemoteExec,
  script: GeneratedScript,
  args: readonly string[] = [],
  opts: RunScriptOptions = {},
): Promise<RunScriptResult> {
  const argsPart = args.map((a) => shellQuote(a)).join(' ');

  // After bootstrap the admin user may sudo ONLY the installed helper files, by absolute path
  // (/etc/sudoers.d/91-bob-deploy-helpers-<user>, S7) — `sudo -n bash -s` is refused with "a
  // password is required". So a bd-* helper run with sudo executes the installed copy; everything
  // else (the bootstrap scripts, run as root or by a fully-sudo bootstrap user) is piped to bash.
  const installedHelper = opts.sudo === true && HELPER_NAMES.has(script.name);
  let cmd: string;
  if (installedHelper) {
    cmd = `${HELPERS_BIN_DIR}/${script.name}${argsPart.length > 0 ? ` ${argsPart}` : ''}`;
  } else {
    cmd = argsPart.length > 0 ? `bash -s -- ${argsPart}` : 'bash -s';
  }

  const execOpts: ExecOptions = {
    sudo: opts.sudo,
    timeoutMs: opts.timeoutMs,
    stdin: installedHelper ? undefined : script.content,
    onOutput: opts.onOutput,
  };

  const result = await exec.exec(cmd, execOpts);
  const outcome = parseResultLine(script.name, result);
  return { outcome, exec: result };
}

function parseResultLine(scriptName: string, result: ExecResult): RunScriptOutcome {
  const lines = result.stdout.split('\n');
  let resultLine: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && line.startsWith(RESULT_PREFIX)) {
      resultLine = line;
      break;
    }
  }

  if (resultLine === undefined) {
    return {
      ok: false,
      code: 'BD_NO_RESULT_LINE',
      message: `${scriptName} exited with code ${result.code} without printing a BD_RESULT line.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(resultLine.slice(RESULT_PREFIX.length));
  } catch {
    return {
      ok: false,
      code: 'BD_BAD_RESULT_JSON',
      message: `${scriptName} printed a BD_RESULT line that was not valid JSON: ${resultLine}`,
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      code: 'BD_BAD_RESULT_SHAPE',
      message: `${scriptName} printed a BD_RESULT value that was not a JSON object: ${resultLine}`,
    };
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj['ok'] !== 'boolean') {
    return {
      ok: false,
      code: 'BD_BAD_RESULT_SHAPE',
      message: `${scriptName} printed a BD_RESULT object without a boolean "ok" field: ${resultLine}`,
    };
  }

  if (obj['ok'] === true) {
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'ok') continue;
      data[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return { ok: true, data };
  }

  const code = typeof obj['error'] === 'string' ? obj['error'] : 'BD_UNKNOWN_ERROR';
  const message = typeof obj['message'] === 'string' ? obj['message'] : `${scriptName} failed.`;
  return { ok: false, code, message };
}
