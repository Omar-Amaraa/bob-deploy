import { describe, it, expect } from 'vitest';
import { classifyBobFailure } from './failure.js';

describe('classifyBobFailure', () => {
  it('classifies a timeout regardless of exit code or stderr', () => {
    expect(classifyBobFailure({ code: null, timedOut: true, stderrTail: '' }).code).toBe('BOB_TIMEOUT');
  });

  it('classifies an auth failure from stderr wording', () => {
    expect(classifyBobFailure({ code: 1, timedOut: false, stderrTail: 'Error: unauthorized' }).code).toBe('BOB_AUTH_FAILED');
    expect(classifyBobFailure({ code: 1, timedOut: false, stderrTail: 'HTTP 401' }).code).toBe('BOB_AUTH_FAILED');
  });

  it('classifies a missing-binary failure from ENOENT-style stderr', () => {
    expect(classifyBobFailure({ code: null, timedOut: false, stderrTail: 'spawn bob ENOENT' }).code).toBe('BOB_NOT_INSTALLED');
  });

  it('falls back to a generic non-zero-exit classification, always including the real exit code', () => {
    const result = classifyBobFailure({ code: 7, timedOut: false, stderrTail: 'some other failure' });
    expect(result.code).toBe('BOB_NONZERO_EXIT');
    expect(result.message).toContain('7');
  });
});
