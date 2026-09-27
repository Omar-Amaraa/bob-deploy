/**
 * S14 (new) — "Bob child process gets a scrubbed environment (only PATH, an isolated HOME, locale,
 * the Bob key variable, Windows system vars), cwd = staging copy, hard timeout."
 *
 * Fully covered by packages/agent/src/bob/env.test.ts (tagged via its own describe — exact key
 * set, HOME override, API key placement) and runner.test.ts ("spawns with exactly the scrubbed env
 * keys ... and cwd = staging", plus the cancel()/hard-timeout kill tests). This file adds the one
 * scenario those don't cover directly: an arbitrary secret-shaped variable actually present in the
 * *real* process environment (not just the ones buildScrubbedEnv knows to allow) must not survive
 * into the scrubbed env by accident, e.g. via a future change that spreads `...process.env` in
 * first and overrides second.
 */
import { describe, it, expect } from 'vitest';
import { buildScrubbedEnv } from '@bob-deploy/agent';

describe('S14: an unrelated secret sitting in the real process env never reaches the scrubbed env', () => {
  it('a made-up sensitive var set on process.env before the call is absent from the result', () => {
    const sentinelName = 'BD_S14_TOTALLY_UNRELATED_SECRET';
    const sentinelValue = 'super-secret-value-that-must-not-leak';
    const previous = process.env[sentinelName];
    process.env[sentinelName] = sentinelValue;
    try {
      const env = buildScrubbedEnv({ bobHome: '/tmp/bd-s14-home', apiKey: 'sk-test-s14' });
      expect(env[sentinelName]).toBeUndefined();
      expect(Object.values(env)).not.toContain(sentinelValue);
    } finally {
      if (previous === undefined) delete process.env[sentinelName];
      else process.env[sentinelName] = previous;
    }
  });
});
