import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBob } from './check.js';
import { makeFakeSpawn, type FakeSpawnScriptEntry } from './test-fake-spawn.js';

const cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeFakeBobBinary(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bd-agent-bobbin-'));
  cleanupDirs.push(dir);
  const path = join(dir, 'bob');
  await writeFile(path, '#!/bin/sh\necho unused\n');
  await chmod(path, 0o755);
  return path;
}

describe('checkBob', () => {
  it('reports all four steps ok when everything succeeds', async () => {
    const binaryPath = await makeFakeBobBinary();
    const script: FakeSpawnScriptEntry[] = [
      { stdout: 'bob version 1.2.3\n', code: 0 }, // bob --version
      { stdout: 'v22.15.0\n', code: 0 }, // node --version
      { stdout: 'OK\n', code: 0 }, // auth check
    ];
    const { spawnFn } = makeFakeSpawn(script);
    const results = await checkBob(
      { keyType: 'inference', licenseAccepted: true, binaryPath },
      () => Promise.resolve('sk-x'),
      '/tmp/bobhome',
      spawnFn,
    );
    expect(results.map((r) => [r.step, r.ok])).toEqual([
      ['binary', true],
      ['node', true],
      ['license', true],
      ['auth', true],
    ]);
  });

  it('reports license not ok when licenseAccepted is false, independent of everything else', async () => {
    const binaryPath = await makeFakeBobBinary();
    const script: FakeSpawnScriptEntry[] = [
      { stdout: 'bob version 1.2.3\n', code: 0 },
      { stdout: 'v22.15.0\n', code: 0 },
      { stdout: 'OK\n', code: 0 },
    ];
    const { spawnFn } = makeFakeSpawn(script);
    const results = await checkBob(
      { keyType: 'inference', licenseAccepted: false, binaryPath },
      () => Promise.resolve('sk-x'),
      '/tmp/bobhome',
      spawnFn,
    );
    const license = results.find((r) => r.step === 'license');
    expect(license?.ok).toBe(false);
  });

  it('reports node not ok when the installed version is below the minimum', async () => {
    const binaryPath = await makeFakeBobBinary();
    const script: FakeSpawnScriptEntry[] = [
      { stdout: 'bob version 1.2.3\n', code: 0 },
      { stdout: 'v18.19.0\n', code: 0 },
      { stdout: 'OK\n', code: 0 },
    ];
    const { spawnFn } = makeFakeSpawn(script);
    const results = await checkBob(
      { keyType: 'inference', licenseAccepted: true, binaryPath },
      () => Promise.resolve('sk-x'),
      '/tmp/bobhome',
      spawnFn,
    );
    const node = results.find((r) => r.step === 'node');
    expect(node?.ok).toBe(false);
  });

  it('reports binary not ok and skips auth when the binary cannot be resolved', async () => {
    const { spawnFn } = makeFakeSpawn([{ stdout: 'v22.15.0\n', code: 0 }]); // only node --version ever runs
    const results = await checkBob(
      { keyType: 'inference', licenseAccepted: true, binaryPath: '/does/not/exist/bob' },
      () => Promise.resolve('sk-x'),
      '/tmp/bobhome',
      spawnFn,
    );
    const binary = results.find((r) => r.step === 'binary');
    const auth = results.find((r) => r.step === 'auth');
    expect(binary?.ok).toBe(false);
    expect(auth?.ok).toBe(false);
  });

  it('reports auth not ok when bob rejects the key', async () => {
    const binaryPath = await makeFakeBobBinary();
    const script: FakeSpawnScriptEntry[] = [
      { stdout: 'bob version 1.2.3\n', code: 0 },
      { stdout: 'v22.15.0\n', code: 0 },
      { stdout: '', stderr: 'unauthorized', code: 1 },
    ];
    const { spawnFn } = makeFakeSpawn(script);
    const results = await checkBob(
      { keyType: 'inference', licenseAccepted: true, binaryPath },
      () => Promise.resolve('sk-x'),
      '/tmp/bobhome',
      spawnFn,
    );
    const auth = results.find((r) => r.step === 'auth');
    expect(auth?.ok).toBe(false);
  });
});
