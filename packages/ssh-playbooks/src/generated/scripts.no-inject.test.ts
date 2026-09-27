import { describe, it, expect } from 'vitest';
import { BOOTSTRAP_SCRIPTS, HELPER_SCRIPTS, HELPERS_ALLOWLIST } from './scripts.js';

// Fault-injection script variants (scripts/testing/*, marked with the literal "BD_INJECT" prefix —
// see scripts/testing/README.md) exist only for src/**/*.fail.test.ts and must never reach a real
// server. This proves that at the point they'd actually be used: the generated bundle every real
// bootstrap/helper script is uploaded from.
describe('src/generated/scripts.ts', () => {
  it('never contains a BD_INJECT fault-injection marker', () => {
    for (const script of [...BOOTSTRAP_SCRIPTS, ...HELPER_SCRIPTS, HELPERS_ALLOWLIST]) {
      expect(script.content).not.toContain('BD_INJECT');
    }
  });
});
