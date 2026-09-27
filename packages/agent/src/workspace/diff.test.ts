import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaging } from './staging.js';
import { diffStaging } from './diff.js';

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

describe('diffStaging', () => {
  it('reports no changes right after createStaging', async () => {
    const project = await makeProject({ 'a.txt': 'a' });
    const stagingRoot = await mkdtemp(join(tmpdir(), 'bd-agent-staging-'));
    cleanupDirs.push(stagingRoot);
    const staging = await createStaging(project, stagingRoot);
    expect(await diffStaging(staging)).toEqual({ added: [], modified: [], deleted: [] });
  });

  it('detects an added, a modified and a deleted file', async () => {
    const project = await makeProject({ 'a.txt': 'a', 'b.txt': 'b' });
    const stagingRoot = await mkdtemp(join(tmpdir(), 'bd-agent-staging-'));
    cleanupDirs.push(stagingRoot);
    const staging = await createStaging(project, stagingRoot);

    await writeFile(join(staging.dir, 'a.txt'), 'a-changed');
    await unlink(join(staging.dir, 'b.txt'));
    await writeFile(join(staging.dir, 'c.txt'), 'c-new');

    const diff = await diffStaging(staging);
    expect(diff).toEqual({ added: ['c.txt'], modified: ['a.txt'], deleted: ['b.txt'] });
  });

  it('a second call reports no further changes once the manifest has been advanced', async () => {
    const project = await makeProject({ 'a.txt': 'a' });
    const stagingRoot = await mkdtemp(join(tmpdir(), 'bd-agent-staging-'));
    cleanupDirs.push(stagingRoot);
    const staging = await createStaging(project, stagingRoot);
    await writeFile(join(staging.dir, 'a.txt'), 'a-changed');

    expect(await diffStaging(staging)).toEqual({ added: [], modified: ['a.txt'], deleted: [] });
    expect(await diffStaging(staging)).toEqual({ added: [], modified: [], deleted: [] });
  });

  it('does not report node_modules created inside staging (e.g. by npm ci) as added files', async () => {
    const project = await makeProject({ 'package.json': '{}' });
    const stagingRoot = await mkdtemp(join(tmpdir(), 'bd-agent-staging-'));
    cleanupDirs.push(stagingRoot);
    const staging = await createStaging(project, stagingRoot);

    await mkdir(join(staging.dir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(staging.dir, 'node_modules', 'pkg', 'index.js'), 'x');

    expect(await diffStaging(staging)).toEqual({ added: [], modified: [], deleted: [] });
  });
});
