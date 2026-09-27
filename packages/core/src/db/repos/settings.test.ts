import { describe, expect, it } from 'vitest';
import { DEFAULT_POLL_INTERVALS } from '@bob-deploy/contracts';
import { openInMemory } from '../db.js';
import { SettingsRepo } from './settings.js';

describe('SettingsRepo', () => {
  it('returns documented defaults when nothing has been saved yet', () => {
    const db = openInMemory();
    const repo = new SettingsRepo(db);
    expect(repo.get()).toEqual({
      autoLockMinutes: 15,
      theme: 'system',
      pollIntervals: DEFAULT_POLL_INTERVALS,
    });
    db.close();
  });

  it('update merges a partial patch and persists it', () => {
    const db = openInMemory();
    const repo = new SettingsRepo(db);
    repo.update({ theme: 'dark' });
    expect(repo.get().theme).toBe('dark');
    expect(repo.get().autoLockMinutes).toBe(15);

    repo.update({ autoLockMinutes: 30 });
    expect(repo.get()).toMatchObject({ theme: 'dark', autoLockMinutes: 30 });
    db.close();
  });

  it('raw key/value accessors are independent of AppSettings', () => {
    const db = openInMemory();
    const repo = new SettingsRepo(db);
    expect(repo.getRaw('anything')).toBeUndefined();
    repo.setRaw('anything', '{"x":1}');
    expect(repo.getRaw('anything')).toBe('{"x":1}');
    db.close();
  });
});
