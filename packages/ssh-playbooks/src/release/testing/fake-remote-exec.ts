import type { RemoteExec, ExecOptions, ExecResult } from '../../ssh/types.js';

export function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, ...overrides };
}

export interface FakeRemoteExecHandle extends RemoteExec {
  calls: Array<{ cmd: string; opts?: ExecOptions }>;
  uploadCalls: Array<{ local: string; remote: string }>;
}

/**
 * A scriptable fake RemoteExec for release/*.test.ts. Unlike bootstrap.steps.test.ts's fixed
 * response queue (every step there runs a small, fixed number of exec calls in a known order),
 * release.ts branches heavily (static vs proxy, health-check retries, rollback-on-failure), so
 * responses are matched by a predicate against the command string instead of by call order. A
 * `defaultResult` is returned for anything unmatched (defaults to a plain success), so tests only
 * need to stub the calls they actually care about.
 */
export function fakeRemoteExec(
  handlers: Array<{ when: (cmd: string) => boolean; result: ExecResult | ((cmd: string) => ExecResult) }> = [],
  defaultResult: ExecResult = execResult(),
): FakeRemoteExecHandle {
  const calls: Array<{ cmd: string; opts?: ExecOptions }> = [];
  const uploadCalls: Array<{ local: string; remote: string }> = [];
  return {
    calls,
    uploadCalls,
    exec(cmd: string, opts?: ExecOptions) {
      calls.push({ cmd, opts });
      for (const handler of handlers) {
        if (handler.when(cmd)) {
          const result = typeof handler.result === 'function' ? handler.result(cmd) : handler.result;
          return Promise.resolve(result);
        }
      }
      return Promise.resolve(defaultResult);
    },
    upload(local: string, remote: string) {
      uploadCalls.push({ local, remote });
      return Promise.resolve();
    },
    close() {
      /* no-op */
    },
  };
}

export function bdSuccess(fields: Record<string, string | number | boolean>): ExecResult {
  const obj: Record<string, unknown> = { ok: true };
  for (const [k, v] of Object.entries(fields)) obj[k] = typeof v === 'boolean' ? String(v) : v;
  return execResult({ stdout: `BD_RESULT ${JSON.stringify(obj)}\n` });
}

export function bdFailure(error: string, message: string): ExecResult {
  return execResult({ code: 1, stdout: `BD_RESULT ${JSON.stringify({ ok: false, error, message })}\n` });
}
