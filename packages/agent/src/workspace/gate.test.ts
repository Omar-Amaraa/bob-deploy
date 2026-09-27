import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, unlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaging } from './staging.js';
import { diffStaging } from './diff.js';
import { applyGate } from './gate.js';

const cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bd-agent-project-'));
  cleanupDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, ...rel.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

async function setup(files: Record<string, string>) {
  const project = await makeProject(files);
  const stagingRoot = await mkdtemp(join(tmpdir(), 'bd-agent-staging-'));
  cleanupDirs.push(stagingRoot);
  const staging = await createStaging(project, stagingRoot);
  return { project, staging };
}

describe('applyGate', () => {
  it('accepts an ordinary in-scope edit', async () => {
    const { project, staging } = await setup({ 'src/app.js': 'v1' });
    await writeFile(join(staging.dir, 'src', 'app.js'), 'v2');
    const diff = await diffStaging(staging);
    const result = await applyGate(staging, project, diff);
    expect(result).toEqual({ accepted: { added: [], modified: ['src/app.js'], deleted: [] }, rejected: [] });
  });

  it('rejects and reverts a path traversal attempt', async () => {
    const { project, staging } = await setup({ 'index.js': 'x' });
    // Simulate what a `..`-containing path would look like after diffStaging by injecting it
    // directly into the diff (diffStaging itself can never produce one from a real fs walk, so
    // this exercises the gate's own defense-in-depth check).
    await writeFile(join(staging.dir, 'evil.js'), 'evil');
    const diff = { added: ['../evil.js'], modified: [], deleted: [] };
    const result = await applyGate(staging, project, diff);
    expect(result.accepted).toEqual({ added: [], modified: [], deleted: [] });
    expect(result.rejected).toEqual([{ path: '../evil.js', reason: 'path-traversal' }]);
  });

  it('rejects .bob/** and .git/** paths', async () => {
    const { project, staging } = await setup({ 'index.js': 'x' });
    await mkdir(join(staging.dir, '.bob'), { recursive: true });
    await writeFile(join(staging.dir, '.bob', 'state.json'), '{}');
    const diff = { added: ['.bob/state.json'], modified: [], deleted: [] };
    const result = await applyGate(staging, project, diff);
    expect(result.rejected).toEqual([{ path: '.bob/state.json', reason: 'forbidden-path' }]);
    await expect(readFile(join(staging.dir, '.bob', 'state.json'))).rejects.toThrow();
  });

  it('rejects .pem and id_* files', async () => {
    const { project, staging } = await setup({ 'index.js': 'x' });
    await writeFile(join(staging.dir, 'key.pem'), 'x');
    await writeFile(join(staging.dir, 'id_rsa'), 'x');
    const diff = { added: ['key.pem', 'id_rsa'], modified: [], deleted: [] };
    const result = await applyGate(staging, project, diff);
    expect(result.rejected.map((r) => r.path).sort()).toEqual(['id_rsa', 'key.pem']);
  });

  it('rejects and reverts a file over the size limit', async () => {
    const { project, staging } = await setup({ 'small.txt': 'ok' });
    await writeFile(join(staging.dir, 'big.txt'), 'x'.repeat(1000));
    const diff = { added: ['big.txt'], modified: [], deleted: [] };
    const result = await applyGate(staging, project, diff, { maxFileBytes: 100 });
    expect(result.rejected).toEqual([{ path: 'big.txt', reason: 'too-large' }]);
    await expect(readFile(join(staging.dir, 'big.txt'))).rejects.toThrow();
  });

  it('rejects a disallowed binary but accepts an image', async () => {
    const { project, staging } = await setup({ 'index.js': 'x' });
    await writeFile(join(staging.dir, 'weird.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    await writeFile(join(staging.dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
    const diff = { added: ['weird.bin', 'logo.png'], modified: [], deleted: [] };
    const result = await applyGate(staging, project, diff);
    expect(result.rejected).toEqual([{ path: 'weird.bin', reason: 'disallowed-binary' }]);
    expect(result.accepted.added).toEqual(['logo.png']);
  });

  it('rejects everything when more than maxChangedFiles files changed', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`f${i}.txt`] = 'x';
    const { project, staging } = await setup(files);
    for (let i = 5; i < 8; i++) await writeFile(join(staging.dir, `f${i}.txt`), 'new');
    const diff = await diffStaging(staging);
    const result = await applyGate(staging, project, diff, { maxChangedFiles: 2 });
    expect(result.accepted).toEqual({ added: [], modified: [], deleted: [] });
    expect(result.rejected.length).toBe(3);
    expect(result.rejected.every((r) => r.reason === 'too-many-changed-files')).toBe(true);
  });

  it('rejects deletions beyond maxDeletedFiles but still allows an unrelated edit', async () => {
    const files: Record<string, string> = { keep: 'keep-me' };
    for (let i = 0; i < 5; i++) files[`d${i}.txt`] = 'x';
    const { project, staging } = await setup(files);
    for (let i = 0; i < 5; i++) await unlink(join(staging.dir, `d${i}.txt`));
    await writeFile(join(staging.dir, 'keep'), 'keep-me-changed');
    const diff = await diffStaging(staging);
    const result = await applyGate(staging, project, diff, { maxDeletedFiles: 2 });
    expect(result.rejected.length).toBe(5);
    expect(result.rejected.every((r) => r.reason === 'too-many-deleted-files')).toBe(true);
    expect(result.accepted).toEqual({ added: [], modified: ['keep'], deleted: [] });
    // Reverted: every deleted file is restored in staging from the original project.
    for (let i = 0; i < 5; i++) {
      expect(await readFile(join(staging.dir, `d${i}.txt`), 'utf8')).toBe('x');
    }
  });

  it('reverts a rejected modification back to the original project content', async () => {
    const { project, staging } = await setup({ 'key.pem': 'original-not-a-real-key' });
    // key.pem itself is forbidden by name regardless of whether it's added or modified.
    await writeFile(join(staging.dir, 'key.pem'), 'attacker-controlled');
    const diff = { added: [], modified: ['key.pem'], deleted: [] };
    const result = await applyGate(staging, project, diff);
    expect(result.rejected).toEqual([{ path: 'key.pem', reason: 'forbidden-path' }]);
    expect(await readFile(join(staging.dir, 'key.pem'), 'utf8')).toBe('original-not-a-real-key');
  });
});
