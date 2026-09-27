import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaging } from './staging.js';

/** Windows only lets admins (or Developer Mode) create file symlinks; without that, `symlink()`
 * fails with EPERM before createStaging is even exercised. Probe once and skip those cases there. */
async function canCreateSymlinks(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'bd-agent-symlink-probe-'));
  try {
    await writeFile(join(dir, 'target.txt'), 'x');
    await symlink(join(dir, 'target.txt'), join(dir, 'link.txt'));
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const itWithSymlinks = it.skipIf(!(await canCreateSymlinks()));

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

async function makeStagingRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bd-agent-staging-'));
  cleanupDirs.push(dir);
  return dir;
}

describe('createStaging', () => {
  it('copies ordinary files and computes their sha256', async () => {
    const project = await makeProject({ 'index.js': 'console.log(1)', 'src/app.js': 'export {}' });
    const staging = await createStaging(project, await makeStagingRoot());
    expect([...staging.manifest.keys()].sort()).toEqual(['index.js', 'src/app.js']);
    expect(await readFile(join(staging.dir, 'index.js'), 'utf8')).toBe('console.log(1)');
    expect(staging.skipped).toEqual([]);
  });

  it('excludes node_modules, .git, .venv, venv, __pycache__, .DS_Store and .env*', async () => {
    const project = await makeProject({
      'index.js': 'x',
      'node_modules/pkg/index.js': 'x',
      '.git/HEAD': 'x',
      '.venv/lib/x.py': 'x',
      'venv/lib/x.py': 'x',
      '__pycache__/x.pyc': 'x',
      '.DS_Store': 'x',
      '.env': 'SECRET=1',
      '.env.local': 'SECRET=1',
      '.env-test': 'SECRET=1',
    });
    const staging = await createStaging(project, await makeStagingRoot());
    expect([...staging.manifest.keys()]).toEqual(['index.js']);
  });

  it('skips (and logs) a file over 50 MB', async () => {
    const project = await mkdtemp(join(tmpdir(), 'bd-agent-project-'));
    cleanupDirs.push(project);
    // Sparse file: fast to create, still reports a real size to fs.stat.
    const { openSync, ftruncateSync, closeSync } = await import('node:fs');
    const fd = openSync(join(project, 'big.bin'), 'w');
    ftruncateSync(fd, 50 * 1024 * 1024 + 1);
    closeSync(fd);
    await writeFile(join(project, 'small.txt'), 'ok');

    const staging = await createStaging(project, await makeStagingRoot());
    expect([...staging.manifest.keys()]).toEqual(['small.txt']);
    expect(staging.skipped).toEqual([{ path: 'big.bin', reason: 'too-large' }]);
  });

  itWithSymlinks('follows a symlink that points inside the project', async () => {
    const project = await makeProject({ 'real/target.txt': 'hello' });
    await symlink(join(project, 'real', 'target.txt'), join(project, 'link.txt'));
    const staging = await createStaging(project, await makeStagingRoot());
    expect(staging.manifest.has('link.txt')).toBe(true);
    expect(await readFile(join(staging.dir, 'link.txt'), 'utf8')).toBe('hello');
    expect(staging.skipped).toEqual([]);
  });

  itWithSymlinks('skips (and logs) a symlink pointing outside the project', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'bd-agent-outside-'));
    cleanupDirs.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'nope');
    const project = await makeProject({ 'index.js': 'x' });
    await symlink(join(outside, 'secret.txt'), join(project, 'escape.txt'));

    const staging = await createStaging(project, await makeStagingRoot());
    expect(staging.manifest.has('escape.txt')).toBe(false);
    expect(staging.skipped).toEqual([{ path: 'escape.txt', reason: 'symlink-outside-project' }]);
  });

  itWithSymlinks('skips a broken symlink without throwing', async () => {
    const project = await makeProject({ 'index.js': 'x' });
    await symlink(join(project, 'does-not-exist.txt'), join(project, 'broken.txt'));
    const staging = await createStaging(project, await makeStagingRoot());
    expect(staging.manifest.has('broken.txt')).toBe(false);
    expect(staging.skipped.some((s) => s.path === 'broken.txt')).toBe(true);
  });
});
