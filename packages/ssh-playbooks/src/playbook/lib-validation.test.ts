import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// scripts/lib.sh is fixed shell code (see CLAUDE.md), not TypeScript, so it can't be unit tested
// by importing it. Instead this spawns a real `bash` for each case and sources the actual file on
// disk — the same pattern ssh/shell-quote.test.ts uses to round-trip through a real shell.

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_PATH = join(__dirname, '..', '..', 'scripts', 'lib.sh');

// POSIX-only: needs a real bash / /bin/sh. Windows has none (the WSL bash.exe shim can't see C:\ paths),
// so these run on Linux/macOS and CI and are skipped on win32.
const IS_WINDOWS = process.platform === 'win32';
const describePosix = describe.skipIf(IS_WINDOWS);

it.skipIf(IS_WINDOWS)('scripts/lib.sh has valid bash syntax', () => {
  expect(() => execFileSync('bash', ['-n', LIB_PATH])).not.toThrow();
});

function callBoolFn(fn: string, ...args: string[]): boolean {
  const quotedArgs = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  try {
    execFileSync('bash', ['-c', `source '${LIB_PATH}'; ${fn} ${quotedArgs}`]);
    return true;
  } catch {
    return false;
  }
}

describePosix('validate_app', () => {
  it.each([
    ['myapp', true],
    ['a23456789012345678901234567890', true], // 31 chars, max length
    ['a', false], // too short (min length 2)
    ['1app', false], // must start with a letter
    ['My-App', false], // must be lowercase
    ['a_app', false], // underscore not allowed
    ['a-very-long-app-name-that-is-31c', false], // 32 chars, one over the limit
  ])('%s -> %s', (value, expected) => {
    expect(callBoolFn('validate_app', value)).toBe(expected);
  });
});

describePosix('validate_user', () => {
  it.each([
    ['deployer', true],
    ['abc', true],
    ['ab', false], // too short (min length 3)
    ['root', false], // reserved
    ['ubuntu', false], // reserved
    ['bd-admin', false], // bd- prefix reserved
    ['Deployer', false], // must be lowercase
  ])('%s -> %s', (value, expected) => {
    expect(callBoolFn('validate_user', value)).toBe(expected);
  });
});

describePosix('validate_port', () => {
  it.each([
    ['1', true],
    ['22', true],
    ['65535', true],
    ['022', true], // leading zeros tolerated, same as Number() would
    ['0', false],
    ['65536', false],
    ['abc', false],
    ['-1', false],
    ['3.5', false],
  ])('%s -> %s', (value, expected) => {
    expect(callBoolFn('validate_port', value)).toBe(expected);
  });
});

describePosix('validate_domain', () => {
  it.each([
    ['example.com', true],
    ['sub.example.com', true],
    ['a.b.example.co', true],
    ['203-0-113-9.sslip.io', true],
    ['EXAMPLE.com', false], // must be lowercase
    ['example', false], // needs at least one dot
    ['-bad.com', false], // label can't start with a hyphen
    ['bad-.com', false], // label can't end with a hyphen
    ['example.c', false], // TLD must be at least 2 letters
    ['example.c0m', false], // TLD must be all letters
  ])('%s -> %s', (value, expected) => {
    expect(callBoolFn('validate_domain', value)).toBe(expected);
  });
});

describePosix('validate_start_cmd', () => {
  it.each([
    ['npm run start', true],
    ['npm start', true],
    ['node server.js', true],
    ['.venv/bin/gunicorn app:app --bind=0.0.0.0:8000', true],
    ['.venv/bin/uvicorn app:app --host 0.0.0.0 --port 8000', true],
    ['.venv/bin/gunicorn app:app --bind 127.0.0.1:$PORT', true],
    ['.venv/bin/uvicorn main:app --host 127.0.0.1 --port $PORT', true],
    ['rm -rf /', false],
    ['npm run start; rm -rf /', false],
    ['python app.py', false],
  ])('%s -> %s', (value, expected) => {
    expect(callBoolFn('validate_start_cmd', value)).toBe(expected);
  });
});

describePosix('json_escape', () => {
  it.each([
    ['plain', 'plain'],
    ['has "quotes"', 'has \\"quotes\\"'],
    ['back\\slash', 'back\\\\slash'],
  ])('%s -> %s', (input, expectedEscaped) => {
    const out = execFileSync('bash', ['-c', `source '${LIB_PATH}'; json_escape "$1"`, '--', input]).toString(
      'utf8',
    );
    expect(out).toBe(expectedEscaped);
  });
});

describePosix('json_escape / result / die', () => {
  it('produces a BD_RESULT line whose value round-trips through JSON.parse, including a quote and a newline', () => {
    const out = execFileSync('bash', ['-c', `source '${LIB_PATH}'; result key1 "$1" key2 "$2"`, '--', 'va"lue', 'line1\nline2']).toString(
      'utf8',
    );
    const line = out.trim().split('\n').at(-1) ?? '';
    expect(line.startsWith('BD_RESULT ')).toBe(true);
    const parsed = JSON.parse(line.slice('BD_RESULT '.length)) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['key1']).toBe('va"lue');
    expect(parsed['key2']).toBe('line1\nline2');
  });

  it('die prints a BD_RESULT failure line and exits 1', () => {
    let stdout = '';
    let status = 0;
    try {
      execFileSync('bash', ['-c', `source '${LIB_PATH}'; die "boom" "BD_TEST_CODE"`]);
    } catch (err) {
      const e = err as { status: number; stdout: Buffer };
      status = e.status;
      stdout = e.stdout.toString('utf8');
    }
    expect(status).toBe(1);
    const line = stdout.trim().split('\n').at(-1) ?? '';
    const parsed = JSON.parse(line.slice('BD_RESULT '.length)) as Record<string, unknown>;
    expect(parsed).toEqual({ ok: false, error: 'BD_TEST_CODE', message: 'boom' });
  });

  it('require_root fails BD_NOT_ROOT when not running as root', () => {
    // This test suite always runs as a non-root CI/sandbox user.
    let status = 0;
    let stdout = '';
    try {
      execFileSync('bash', ['-c', `source '${LIB_PATH}'; require_root; result ok true`]);
    } catch (err) {
      const e = err as { status: number; stdout: Buffer };
      status = e.status;
      stdout = e.stdout.toString('utf8');
    }
    if (process.getuid?.() === 0) {
      // Running as root (e.g. inside a container) — require_root is a no-op, so this case just
      // documents that instead of asserting the opposite.
      expect(status).toBe(0);
      return;
    }
    expect(status).toBe(1);
    const line = stdout.trim().split('\n').at(-1) ?? '';
    const parsed = JSON.parse(line.slice('BD_RESULT '.length)) as Record<string, unknown>;
    expect(parsed['error']).toBe('BD_NOT_ROOT');
  });
});
