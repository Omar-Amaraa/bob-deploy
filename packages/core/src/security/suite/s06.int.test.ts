/**
 * S6 (integration half) — "No secret appears in a Bob prompt, job event, log or crash report."
 * This file asserts the broader claim (all six testbed/test-secrets.json values, not just the root
 * password) against the same real bootstrap run s01.int.test.ts drives; see that file and
 * fixtures/testbed-secret-scan.ts. The Bob-prompt half of S6 (no untrusted/agent-adapter code runs
 * during a bare bootstrap) is covered separately and Docker-free by packages/agent/src/
 * prompts/builder.test.ts and security.test.ts, both of which assert redactor.assertNoSecrets is
 * enforced on every prompt built for Bob — see docs/security/README.md's S6 row for the split.
 *
 * NOT EXECUTED IN THIS SANDBOX (no container-registry access) — see fixtures/testbed-secret-scan.ts.
 */
import { describe, it, expect } from 'vitest';
import { runBootstrapAndScanOutput } from './fixtures/testbed-secret-scan.js';

describe('S6: none of the fixed test secrets (in any encoded form) survive redaction during a real run', () => {
  it(
    'the redacted capture contains zero occurrences of any testbed/test-secrets.json value',
    async () => {
      const result = await runBootstrapAndScanOutput();
      expect(result.redactedCaptureHits).toEqual([]);
    },
    5 * 60 * 1000,
  );
});
