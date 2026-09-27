/**
 * A real smoke test against an actual `bob` installation, per the brief's TESTS section: "Real Bob
 * smoke test (bob.real.int.test.ts) skipped unless BOB_TEST_API_KEY is set: detect_stack on the
 * vite sample returns a valid StackInfo." Named *.int.test.ts so vitest.workspace.ts only runs it
 * under `pnpm -w test:integration`, never in the plain unit run.
 *
 * This cannot be exercised in this sandbox: there is no `bob` binary installed here, no
 * BOB_TEST_API_KEY, and — as documented at length in bob/args.ts — the real Bob Shell CLI
 * invocation contract (buildBobArgs) has never been verified against a real binary in any
 * environment available to this codebase (A1's spike was never run; docs/spikes/A1-bob-shell.md and
 * DECISIONS.md's DEC-A1 do not exist). This test is written so it becomes meaningful the moment
 * both a real `bob` binary and BOB_TEST_API_KEY are available; until then it — correctly — skips.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { BobShellRunner } from './runner.js';

const apiKey = process.env.BOB_TEST_API_KEY;

describe.skipIf(!apiKey)('BobShellRunner (real bob binary)', () => {
  it('detect_stack on the vite sample returns a valid StackInfo', async () => {
    const runner = new BobShellRunner({
      getApiKey: () => Promise.resolve(apiKey as string),
      config: { keyType: 'inference', licenseAccepted: true },
      bobHome: process.env.BOB_TEST_HOME ?? '/tmp/bob-home',
      redactor: { redact: (t: string) => t, assertNoSecrets: () => undefined },
      clock: { now: () => Date.now() },
    });

    const cwd = join(__dirname, '..', 'detect', '__samples__', 'vite');
    const events = [];
    for await (const event of runner.run({
      kind: 'detect_stack',
      cwd,
      instructions: '',
      context: { hints: { evidence: ['dependency on "vite"'] } },
      allowedCommands: [],
      maxTurns: 1,
      timeoutMs: 180000,
    })) {
      events.push(event);
    }

    const result = events[events.length - 1] as { type: string; ok: boolean; data: { type: string } };
    expect(result.type).toBe('result');
    expect(result.ok).toBe(true);
    expect(['static', 'node', 'python']).toContain(result.data.type);
  });
});
