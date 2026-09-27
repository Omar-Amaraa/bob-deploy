import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { list as tarList } from 'tar';
import { packageRelease } from './package.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function listTarEntries(tarPath: string): Promise<string[]> {
  const entries: string[] = [];
  await tarList({ file: tarPath, onentry: (entry) => entries.push(entry.path) });
  return entries.sort();
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('packageRelease', () => {
  it('node: excludes node_modules, .env files and .git', async () => {
    const src = await makeTempDir('bd-pkg-node-');
    await mkdir(join(src, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(join(src, 'node_modules', 'left-pad', 'index.js'), '');
    await mkdir(join(src, '.git'), { recursive: true });
    await writeFile(join(src, '.git', 'HEAD'), '');
    await writeFile(join(src, '.env'), 'SECRET=1');
    await writeFile(join(src, '.env.production'), 'SECRET=2');
    await writeFile(join(src, 'package.json'), '{}');
    await writeFile(join(src, 'package-lock.json'), '{}');
    await mkdir(join(src, 'dist'));
    await writeFile(join(src, 'dist', 'index.js'), 'console.log(1)');

    const outDir = await makeTempDir('bd-pkg-out-');
    const tarPath = join(outDir, 'release.tar.gz');
    const result = await packageRelease(src, 'node', tarPath);

    const entries = await listTarEntries(tarPath);
    expect(entries).toEqual(['dist/index.js', 'package-lock.json', 'package.json']);
    expect(result.fileCount).toBe(3);
    expect(result.folderHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('python: excludes .venv, __pycache__, .env files and .git', async () => {
    const src = await makeTempDir('bd-pkg-py-');
    await mkdir(join(src, '.venv', 'bin'), { recursive: true });
    await writeFile(join(src, '.venv', 'bin', 'python'), '');
    await mkdir(join(src, '__pycache__'), { recursive: true });
    await writeFile(join(src, '__pycache__', 'app.cpython-311.pyc'), '');
    await writeFile(join(src, '.env'), 'SECRET=1');
    await writeFile(join(src, 'app.py'), 'print(1)');
    await writeFile(join(src, 'requirements.txt'), 'flask\n');

    const outDir = await makeTempDir('bd-pkg-out-');
    const tarPath = join(outDir, 'release.tar.gz');
    const result = await packageRelease(src, 'python', tarPath);

    const entries = await listTarEntries(tarPath);
    expect(entries).toEqual(['app.py', 'requirements.txt']);
    expect(result.fileCount).toBe(2);
  });

  it('static: packages everything under outputDir with no exclusions', async () => {
    const src = await makeTempDir('bd-pkg-static-');
    await writeFile(join(src, 'index.html'), '<html></html>');
    await mkdir(join(src, 'assets'));
    await writeFile(join(src, 'assets', 'app.js'), 'console.log(1)');

    const outDir = await makeTempDir('bd-pkg-out-');
    const tarPath = join(outDir, 'release.tar.gz');
    const result = await packageRelease(src, 'static', tarPath);

    const entries = await listTarEntries(tarPath);
    expect(entries).toEqual(['assets/app.js', 'index.html']);
    expect(result.fileCount).toBe(2);
  });

  it('produces the same folderHash for byte-identical content and a different one when content changes', async () => {
    const srcA = await makeTempDir('bd-pkg-hash-a-');
    const srcB = await makeTempDir('bd-pkg-hash-b-');
    await writeFile(join(srcA, 'index.html'), '<html>1</html>');
    await writeFile(join(srcB, 'index.html'), '<html>1</html>');
    const outDir = await makeTempDir('bd-pkg-out-');

    const a = await packageRelease(srcA, 'static', join(outDir, 'a.tar.gz'));
    const b = await packageRelease(srcB, 'static', join(outDir, 'b.tar.gz'));
    expect(a.folderHash).toBe(b.folderHash);

    await writeFile(join(srcB, 'index.html'), '<html>1 modified</html>');
    const c = await packageRelease(srcB, 'static', join(outDir, 'c.tar.gz'));
    expect(c.folderHash).not.toBe(a.folderHash);
  });

  it('throws when there is nothing left to package after exclusions', async () => {
    const src = await makeTempDir('bd-pkg-empty-');
    await mkdir(join(src, 'node_modules'), { recursive: true });
    await writeFile(join(src, 'node_modules', 'x.js'), '');
    const outDir = await makeTempDir('bd-pkg-out-');
    await expect(packageRelease(src, 'node', join(outDir, 'r.tar.gz'))).rejects.toThrow(/nothing to package/i);
  });
});
