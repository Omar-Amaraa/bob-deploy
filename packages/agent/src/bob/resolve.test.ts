import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBobBinary, BobNotInstalledError } from './resolve.js';
import { makeFakeSpawn } from './test-fake-spawn.js';

describe('resolveBobBinary', () => {
  it('returns an explicitly configured, executable binaryPath without spawning anything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bd-agent-bob-'));
    try {
      const binPath = join(dir, 'bob');
      await writeFile(binPath, '#!/bin/sh\necho fake-bob\n');
      await chmod(binPath, 0o755);
      const { spawnFn, calls } = makeFakeSpawn([]);
      const resolved = await resolveBobBinary(spawnFn, binPath);
      expect(resolved).toBe(binPath);
      expect(calls).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws BobNotInstalledError for a configured binaryPath that does not exist', async () => {
    const { spawnFn } = makeFakeSpawn([]);
    await expect(resolveBobBinary(spawnFn, '/does/not/exist/bob')).rejects.toBeInstanceOf(BobNotInstalledError);
  });

  it('falls back to which/where and resolves the first line of its stdout', async () => {
    const { spawnFn } = makeFakeSpawn([{ stdout: '/usr/local/bin/bob\n', code: 0 }]);
    const resolved = await resolveBobBinary(spawnFn, undefined);
    expect(resolved).toBe('/usr/local/bin/bob');
  });

  it('throws BobNotInstalledError when which/where finds nothing', async () => {
    const { spawnFn } = makeFakeSpawn([{ stdout: '', code: 1 }]);
    await expect(resolveBobBinary(spawnFn, undefined)).rejects.toBeInstanceOf(BobNotInstalledError);
  });
});
