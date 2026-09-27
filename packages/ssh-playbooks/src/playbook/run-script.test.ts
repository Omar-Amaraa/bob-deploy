import { describe, it, expect, vi } from 'vitest';
import { runScript } from './run-script.js';
import type { RemoteExec, ExecOptions, ExecResult } from '../ssh/types.js';
import { HELPER_SCRIPTS, BOOTSTRAP_SCRIPTS, type GeneratedScript } from '../generated/scripts.js';

const SCRIPT: GeneratedScript = { name: 'fake.sh', sha256: 'deadbeef', content: '#!/usr/bin/env bash\necho hi\n' };

function fakeExec(result: ExecResult, opts?: { onCall?: (cmd: string, opts?: ExecOptions) => void }): RemoteExec {
  return {
    exec(cmd: string, execOpts?: ExecOptions) {
      opts?.onCall?.(cmd, execOpts);
      return Promise.resolve(result);
    },
    upload: vi.fn(),
    close: vi.fn(),
  };
}

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, ...overrides };
}

describe('runScript', () => {
  it('pipes the script content over stdin to `bash -s` with no args', async () => {
    let seenCmd = '';
    let seenOpts: ExecOptions | undefined;
    const exec = fakeExec(execResult({ stdout: 'BD_RESULT {"ok":true}\n' }), {
      onCall: (cmd, o) => {
        seenCmd = cmd;
        seenOpts = o;
      },
    });
    await runScript(exec, SCRIPT, []);
    expect(seenCmd).toBe('bash -s');
    expect(seenOpts?.stdin).toBe(SCRIPT.content);
  });

  it('shell-quotes args and passes them after `--`', async () => {
    let seenCmd = '';
    const exec = fakeExec(execResult({ stdout: 'BD_RESULT {"ok":true}\n' }), {
      onCall: (cmd) => {
        seenCmd = cmd;
      },
    });
    await runScript(exec, SCRIPT, ['plain', "it's got a quote", '']);
    expect(seenCmd).toBe(`bash -s -- 'plain' 'it'\\''s got a quote' ''`);
  });

  it('passes sudo/timeoutMs/onOutput through to exec', async () => {
    let seenOpts: ExecOptions | undefined;
    const onOutput = vi.fn();
    const exec = fakeExec(execResult({ stdout: 'BD_RESULT {"ok":true}\n' }), {
      onCall: (_cmd, o) => {
        seenOpts = o;
      },
    });
    await runScript(exec, SCRIPT, [], { sudo: true, timeoutMs: 5000, onOutput });
    expect(seenOpts?.sudo).toBe(true);
    expect(seenOpts?.timeoutMs).toBe(5000);
    expect(seenOpts?.onOutput).toBe(onOutput);
  });

  it('parses a success BD_RESULT line, stringifying non-string fields', async () => {
    const exec = fakeExec(execResult({ stdout: 'some noise\nBD_RESULT {"ok":true,"user":"alice","created":true}\n' }));
    const { outcome } = await runScript(exec, SCRIPT, []);
    expect(outcome).toEqual({ ok: true, data: { user: 'alice', created: 'true' } });
  });

  it('takes the LAST BD_RESULT line when several are present in stdout', async () => {
    const exec = fakeExec(
      execResult({ stdout: 'BD_RESULT {"ok":false,"error":"IGNORED","message":"not this one"}\nBD_RESULT {"ok":true,"final":"yes"}\n' }),
    );
    const { outcome } = await runScript(exec, SCRIPT, []);
    expect(outcome).toEqual({ ok: true, data: { final: 'yes' } });
  });

  it('parses a failure BD_RESULT line', async () => {
    const exec = fakeExec(execResult({ code: 1, stdout: 'BD_RESULT {"ok":false,"error":"BD_BAD_ARGS","message":"nope"}\n' }));
    const { outcome } = await runScript(exec, SCRIPT, []);
    expect(outcome).toEqual({ ok: false, code: 'BD_BAD_ARGS', message: 'nope' });
  });

  it('fails with BD_NO_RESULT_LINE when the script never printed one', async () => {
    const exec = fakeExec(execResult({ code: 0, stdout: 'just some regular output\n' }));
    const { outcome } = await runScript(exec, SCRIPT, []);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('BD_NO_RESULT_LINE');
      expect(outcome.message).toContain('fake.sh');
    }
  });

  it('fails with BD_BAD_RESULT_JSON when the line is not valid JSON', async () => {
    const exec = fakeExec(execResult({ stdout: 'BD_RESULT {not json}\n' }));
    const { outcome } = await runScript(exec, SCRIPT, []);
    expect(outcome).toMatchObject({ ok: false, code: 'BD_BAD_RESULT_JSON' });
  });

  it('fails with BD_BAD_RESULT_SHAPE when the JSON is not an object', async () => {
    const exec = fakeExec(execResult({ stdout: 'BD_RESULT [1,2,3]\n' }));
    const { outcome } = await runScript(exec, SCRIPT, []);
    expect(outcome).toMatchObject({ ok: false, code: 'BD_BAD_RESULT_SHAPE' });
  });

  it('fails with BD_BAD_RESULT_SHAPE when "ok" is missing or not boolean', async () => {
    const exec = fakeExec(execResult({ stdout: 'BD_RESULT {"ok":"yes"}\n' }));
    const { outcome } = await runScript(exec, SCRIPT, []);
    expect(outcome).toMatchObject({ ok: false, code: 'BD_BAD_RESULT_SHAPE' });
  });

  it('defaults to BD_UNKNOWN_ERROR when a failure object has no error code', async () => {
    const exec = fakeExec(execResult({ stdout: 'BD_RESULT {"ok":false}\n' }));
    const { outcome } = await runScript(exec, SCRIPT, []);
    expect(outcome).toMatchObject({ ok: false, code: 'BD_UNKNOWN_ERROR' });
  });

  it('returns the raw exec result alongside the parsed outcome', async () => {
    const raw = execResult({ code: 0, stdout: 'BD_RESULT {"ok":true}\n', stderr: 'warnings here' });
    const exec = fakeExec(raw);
    const { exec: returnedExec } = await runScript(exec, SCRIPT, []);
    expect(returnedExec).toBe(raw);
  });

  // S7: after bootstrap the admin user may sudo only the installed helper files by absolute path;
  // `sudo -n bash -s` is refused ("a password is required"), which broke every release step.
  it('runs a bd-* helper with sudo as its installed file, with no stdin', async () => {
    const helper = HELPER_SCRIPTS.find((h) => h.name === 'bd-service');
    if (!helper) throw new Error('bd-service missing from HELPER_SCRIPTS');
    let seenCmd = '';
    let seenOpts: ExecOptions | undefined;
    const exec = fakeExec(execResult({ stdout: 'BD_RESULT {"ok":true}\n' }), {
      onCall: (cmd, o) => {
        seenCmd = cmd;
        seenOpts = o;
      },
    });
    await runScript(exec, helper, ['myapp', '3100', 'restart'], { sudo: true });
    expect(seenCmd).toBe("/usr/local/lib/bob-deploy/bin/bd-service 'myapp' '3100' 'restart'");
    expect(seenOpts?.sudo).toBe(true);
    expect(seenOpts?.stdin).toBeUndefined();
  });

  it('still pipes bootstrap scripts to `bash -s` even with sudo (the helpers are not installed yet)', async () => {
    const preflight = BOOTSTRAP_SCRIPTS.find((s) => s.name === '00-preflight.sh');
    if (!preflight) throw new Error('00-preflight.sh missing from BOOTSTRAP_SCRIPTS');
    let seenCmd = '';
    const exec = fakeExec(execResult({ stdout: 'BD_RESULT {"ok":true}\n' }), { onCall: (cmd) => (seenCmd = cmd) });
    await runScript(exec, preflight, [], { sudo: true });
    expect(seenCmd).toBe('bash -s');
  });
});
