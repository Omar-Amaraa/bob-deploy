import type { ErrorCode } from '@bob-deploy/contracts';

/**
 * A minimal, local step abstraction — deliberately NOT importing core's `StepDef` (packages/core
 * depends on packages/ssh-playbooks, never the reverse; see CLAUDE.md's package ownership rules).
 * Core wraps each of these into its own `StepDef` (adding job-event emission, cancellation, etc.);
 * this package only needs enough shape to run and unit-test a step on its own.
 */
export interface PlaybookStep<TInput, TOutput> {
  readonly id: string;
  readonly title: string;
  run(input: TInput): Promise<PlaybookStepOutcome<TOutput>>;
}

export type PlaybookStepOutcome<T> = PlaybookStepSuccess<T> | PlaybookStepFailure;

export interface PlaybookStepSuccess<T> {
  readonly ok: true;
  readonly data: T;
}

export interface PlaybookStepFailure {
  readonly ok: false;
  /** One of contracts' frozen ErrorCode values — never a raw BD_* script code (see run-script.ts's
   * mapBdErrorCode, which is where BD_* codes get translated into these). */
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export function stepOk<T>(data: T): PlaybookStepOutcome<T> {
  return { ok: true, data };
}

export function stepFail(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): PlaybookStepFailure {
  return { ok: false, code, message, details };
}
