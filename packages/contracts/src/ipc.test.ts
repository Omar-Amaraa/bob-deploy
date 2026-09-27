import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, PUSH_EVENTS } from './ipc.js';

describe('IPC_CHANNELS', () => {
  it('has no duplicate entries', () => {
    expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length);
  });

  it('covers every documented channel group', () => {
    const groups = [
      'account',
      'bob',
      'hosts',
      'settings',
      'security',
      'projects',
      'snapshots',
      'dns',
      'deploy',
      'update',
      'rollback',
      'releases',
      'job',
      'metrics',
      'health',
      'analytics',
      'maintenance',
      'problem',
      'problems',
    ];
    for (const group of groups) {
      expect(IPC_CHANNELS.some((channel) => channel.startsWith(`${group}:`))).toBe(true);
    }
  });
});

describe('PUSH_EVENTS', () => {
  it('matches the four documented push events', () => {
    expect([...PUSH_EVENTS].sort()).toEqual(
      ['account:locked', 'job:events', 'metrics:updated', 'project:status'].sort(),
    );
  });
});
