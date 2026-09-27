import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { shellQuote } from './shell-quote.js';

// POSIX-only: needs a real bash / /bin/sh. Windows has none (the WSL bash.exe shim can't see C:\ paths),
// so these run on Linux/macOS and CI and are skipped on win32.
const IS_WINDOWS = process.platform === 'win32';

/** Round-trips `value` through `echo <shellQuote(value)>` in a real shell and asserts it comes
 * back byte-for-byte unchanged — the only test that actually proves the escaping is safe. */
function echoRoundTrip(value: string): string {
  return execFileSync('/bin/sh', ['-c', `echo ${shellQuote(value)}`], { encoding: 'utf8' }).replace(/\n$/, '');
}

describe('shellQuote', () => {
  it('wraps a plain value in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it.skipIf(IS_WINDOWS).each([
    'plain',
    'has spaces',
    "it's got a quote",
    "'''triple leading quotes'''",
    '$(rm -rf /)',
    '`whoami`',
    'a; rm -rf /',
    'line1\nline2',
    'a && b || c',
    '${HOME}',
    '',
  ])('round-trips %j through a real shell unchanged', (value) => {
    expect(echoRoundTrip(value)).toBe(value);
  });
});
