import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaging } from './staging.js';
import { syncBack } from './sync.js';
import type { AgentEvent } from '@bob-deploy/contracts';

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

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('syncBack', () => {
  it('copies an added file into the real project and emits an event', async () => {
    const project = await makeProject({ 'index.js': 'x' });
    const stagingRoot = await mkdtemp(join(tmpdir(), 'bd-agent-staging-'));
    cleanupDirs.push(stagingRoot);
    const staging = await createStaging(project, stagingRoot);
    await mkdir(join(staging.dir, 'src'), { recursive: true });
    await writeFile(join(staging.dir, 'src', 'new.js'), 'new-content');

    const events = await collect(syncBack(staging, project, { added: ['src/new.js'], modified: [], deleted: [] }));

    expect(events).toEqual([{ type: 'file_changed', path: 'src/new.js', action: 'added' }]);
    expect(await readFile(join(project, 'src', 'new.js'), 'utf8')).toBe('new-content');
  });

  it('overwrites a modified file in the real project and emits an event', async () => {
    const project = await makeProject({ 'index.js': 'old' });
    const stagingRoot = await mkdtemp(join(tmpdir(), 'bd-agent-staging-'));
    cleanupDirs.push(stagingRoot);
    const staging = await createStaging(project, stagingRoot);
    await writeFile(join(staging.dir, 'index.js'), 'new');

    const events = await collect(syncBack(staging, project, { added: [], modified: ['index.js'], deleted: [] }));

    expect(events).toEqual([{ type: 'file_changed', path: 'index.js', action: 'modified' }]);
    expect(await readFile(join(project, 'index.js'), 'utf8')).toBe('new');
  });

  it('deletes a file from the real project and emits an event', async () => {
    const project = await makeProject({ 'index.js': 'x', 'gone.js': 'y' });
    const stagingRoot = await mkdtemp(join(tmpdir(), 'bd-agent-staging-'));
    cleanupDirs.push(stagingRoot);
    const staging = await createStaging(project, stagingRoot);

    const events = await collect(syncBack(staging, project, { added: [], modified: [], deleted: ['gone.js'] }));

    expect(events).toEqual([{ type: 'file_changed', path: 'gone.js', action: 'deleted' }]);
    await expect(stat(join(project, 'gone.js'))).rejects.toThrow();
    expect(await readFile(join(project, 'index.js'), 'utf8')).toBe('x');
  });

  it('does not throw when deleting a path that is already gone from the project', async () => {
    const project = await makeProject({ 'index.js': 'x' });
    const stagingRoot = await mkdtemp(join(tmpdir(), 'bd-agent-staging-'));
    cleanupDirs.push(stagingRoot);
    const staging = await createStaging(project, stagingRoot);

    const events = await collect(syncBack(staging, project, { added: [], modified: [], deleted: ['never-existed.js'] }));
    expect(events).toEqual([{ type: 'file_changed', path: 'never-existed.js', action: 'deleted' }]);
  });

  it('handles a mixed add/modify/delete diff in order, creating nested directories as needed', async () => {
    const project = await makeProject({ 'index.js': 'old', 'remove-me.js': 'z' });
    const stagingRoot = await mkdtemp(join(tmpdir(), 'bd-agent-staging-'));
    cleanupDirs.push(stagingRoot);
    const staging = await createStaging(project, stagingRoot);
    await writeFile(join(staging.dir, 'index.js'), 'updated');
    await mkdir(join(staging.dir, 'nested', 'dir'), { recursive: true });
    await writeFile(join(staging.dir, 'nested', 'dir', 'file.txt'), 'deep');

    const events = await collect(
      syncBack(staging, project, {
        added: ['nested/dir/file.txt'],
        modified: ['index.js'],
        deleted: ['remove-me.js'],
      }),
    );

    expect(events).toEqual([
      { type: 'file_changed', path: 'nested/dir/file.txt', action: 'added' },
      { type: 'file_changed', path: 'index.js', action: 'modified' },
      { type: 'file_changed', path: 'remove-me.js', action: 'deleted' },
    ]);
    expect(await readFile(join(project, 'nested', 'dir', 'file.txt'), 'utf8')).toBe('deep');
    expect(await readFile(join(project, 'index.js'), 'utf8')).toBe('updated');
    await expect(stat(join(project, 'remove-me.js'))).rejects.toThrow();
  });
});
