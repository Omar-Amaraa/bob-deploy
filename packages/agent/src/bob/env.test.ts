import { describe, it, expect } from 'vitest';
import { platform } from 'node:os';
import { buildScrubbedEnv, BOB_KEY_ENV_VARS } from './env.js';

describe('buildScrubbedEnv', () => {
  it('contains only the allowed keys, never anything else from the parent environment', () => {
    const env = buildScrubbedEnv({ bobHome: '/tmp/bobhome', apiKey: 'sk-test-123' });
    const allowedKeys =
      platform() === 'win32'
        ? ['PATH', 'HOME', 'LANG', 'LC_ALL', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'ComSpec', 'PATHEXT', ...BOB_KEY_ENV_VARS]
        : ['PATH', 'HOME', 'LANG', 'LC_ALL', ...BOB_KEY_ENV_VARS];
    expect(Object.keys(env).sort()).toEqual([...new Set(allowedKeys)].sort());
  });

  it('sets HOME to bobHome, not the real process HOME', () => {
    const env = buildScrubbedEnv({ bobHome: '/tmp/bobhome', apiKey: 'sk-test-123' });
    expect(env.HOME).toBe('/tmp/bobhome');
  });

  it('sets the API key under every BOB_KEY_ENV_VARS name and nowhere else', () => {
    const env = buildScrubbedEnv({ bobHome: '/tmp/bobhome', apiKey: 'sk-test-secret' });
    for (const key of BOB_KEY_ENV_VARS) {
      expect(env[key]).toBe('sk-test-secret');
    }
    const otherValues = Object.entries(env)
      .filter(([k]) => !BOB_KEY_ENV_VARS.includes(k))
      .map(([, v]) => v);
    expect(otherValues.every((v) => v !== 'sk-test-secret')).toBe(true);
  });
});
