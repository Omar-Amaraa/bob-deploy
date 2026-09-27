export type BobFailureCode = 'BOB_NOT_INSTALLED' | 'BOB_TIMEOUT' | 'BOB_AUTH_FAILED' | 'BOB_BAD_OUTPUT' | 'BOB_NONZERO_EXIT';

export interface ClassifiedFailure {
  code: BobFailureCode;
  message: string;
}

/**
 * Best-effort classification of a non-zero Bob Shell exit, from its exit code / timeout state and
 * the tail of its stderr. Like buildBobArgs, the exact error text Bob prints for each condition is
 * unverified (see args.ts's A1 gap note) — the patterns below are reasonable guesses at common
 * phrasing, not confirmed against the real CLI, so this may misclassify an error whose wording
 * differs. It always falls back to BOB_NONZERO_EXIT with the real exit code, so a misclassification
 * never hides the underlying failure.
 */
export function classifyBobFailure(params: { code: number | null; timedOut: boolean; stderrTail: string }): ClassifiedFailure {
  const { code, timedOut, stderrTail } = params;
  if (timedOut) {
    return { code: 'BOB_TIMEOUT', message: 'Bob did not finish within the allotted time.' };
  }
  if (/unauthorized|invalid api key|authentication failed|\b401\b/i.test(stderrTail)) {
    return { code: 'BOB_AUTH_FAILED', message: 'Bob rejected the configured API key.' };
  }
  if (/enoent|command not found|no such file or directory/i.test(stderrTail)) {
    return { code: 'BOB_NOT_INSTALLED', message: 'The bob binary could not be run.' };
  }
  return { code: 'BOB_NONZERO_EXIT', message: `Bob exited with code ${code ?? 'unknown'}.` };
}
