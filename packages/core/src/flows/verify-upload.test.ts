import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeHttpProbe } from '@bob-deploy/ssh-playbooks';
import { pickPublishedSamples, verifyPublishedFiles } from './verify-upload.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeOutput(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bd-verify-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, ...rel.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

describe('pickPublishedSamples', () => {
  it('returns only files inside subfolders, scripts and styles first, as POSIX paths', async () => {
    const dir = await makeOutput({
      'index.html': '',
      'site-ma7abesh.html': '',
      'assets/logo.png': '',
      'assets/main.js': '',
      'assets/nested/deep.css': '',
      'assets/data.json': '',
    });
    expect(await pickPublishedSamples(dir)).toEqual([
      'assets/main.js',
      'assets/nested/deep.css',
      'assets/logo.png',
      'assets/data.json',
    ]);
  });

  it('skips dotfiles, node_modules and host config files, and respects the limit', async () => {
    const dir = await makeOutput({
      '.git/config': '',
      'node_modules/x/index.js': '',
      'sub/_redirects': '',
      'sub/.hidden.js': '',
      'a/1.js': '',
      'a/2.js': '',
      'a/3.js': '',
    });
    expect(await pickPublishedSamples(dir, 2)).toEqual(['a/1.js', 'a/2.js']);
  });

  it('returns nothing for a site with only root files', async () => {
    const dir = await makeOutput({ 'index.html': '', 'about.html': '' });
    expect(await pickPublishedSamples(dir)).toEqual([]);
  });
});

describe('verifyPublishedFiles', () => {
  it('reports which sampled files the host does not serve, with URL-encoded paths', async () => {
    const dir = await makeOutput({ 'assets/app.js': '', 'img/my logo.png': '' });
    const probe = new FakeHttpProbe({
      '/assets/app.js': [{ ok: false, status: 404 }],
      '/img/my%20logo.png': [{ ok: true, status: 200 }],
    });
    const result = await verifyPublishedFiles('https://demo.netlify.app', dir, probe);
    expect(result).toEqual({ checked: ['assets/app.js', 'img/my logo.png'], missing: ['assets/app.js'] });
    expect(probe.callLog).toEqual(['https://demo.netlify.app/assets/app.js', 'https://demo.netlify.app/img/my%20logo.png']);
  });
});
