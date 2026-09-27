/**
 * S1 (integration half) — the full "run a real testbed bootstrap with the fixed root password in
 * play, then scan everything it could have leaked into" exercise. See s01.test.ts for the
 * Docker-free JobEngine-level proof of the narrower "secret lives only in one job's memory" claim.
 *
 * NOT EXECUTED IN THIS SANDBOX (no container-registry access) — see fixtures/testbed-secret-scan.ts.
 */
import { describe, it, expect } from 'vitest';
import { runBootstrapAndScanOutput } from './fixtures/testbed-secret-scan.js';

describe('S1: the testbed root password never reaches a redacted log/event line during a real bootstrap', () => {
  it(
    'flows through the SSH session (proving the test exercises the real credential) but never survives redaction',
    async () => {
      const result = await runBootstrapAndScanOutput();
      expect(result.rawCaptureSawRootPassword).toBe(true);
      expect(result.redactedCaptureHits).toEqual([]);
    },
    5 * 60 * 1000,
  );
});
