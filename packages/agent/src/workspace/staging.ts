import { mkdir, copyFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import type { StagingWorkspace } from './types.js';
import { walkFiles } from './fs-walk.js';

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((res, rej) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => res());
    stream.on('error', rej);
  });
  return hash.digest('hex');
}

/**
 * Copies `projectDir` into `stagingRoot/<uuid>/project`, excluding node_modules/.git/.venv/venv/
 * __pycache__/.DS_Store and any `.env*` file, skipping (and logging) symlinks that resolve outside
 * the project and files over 50 MB. Returns the staging dir plus a manifest of every included
 * file's sha256, keyed by its project-relative posix path.
 */
export async function createStaging(projectDir: string, stagingRoot: string): Promise<StagingWorkspace> {
  const resolvedProjectDir = resolve(projectDir);
  const stagingDir = join(stagingRoot, randomUUID(), 'project');
  await mkdir(stagingDir, { recursive: true });

  const manifest = new Map<string, string>();
  const skipped: StagingWorkspace['skipped'] = [];

  for await (const file of walkFiles(resolvedProjectDir, skipped)) {
    const destPath = join(stagingDir, ...file.relPath.split('/'));
    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(file.sourcePath, destPath);
    manifest.set(file.relPath, await sha256File(destPath));
  }

  return { dir: stagingDir, manifest, skipped };
}
