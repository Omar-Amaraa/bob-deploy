import type { ErrorCode, JobKind, JobQuestion } from '@bob-deploy/contracts';

export type JobSecrets = Map<string, string>;

export interface FileChange {
  kind: 'file';
  path: string;
  action: 'added' | 'modified' | 'deleted';
}
export interface CommandChange {
  kind: 'command';
  cmd: string;
  code: number;
}

/** Thrown by ctx.fail(); the engine catches this to drive the retry/failure state machine. */
export class StepError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'StepError';
    this.code = code;
  }
}

export interface StepContext {
  jobId: string;
  projectId: string;
  stepId: string;
  attempt: number;
  signal: AbortSignal;
  inputs: unknown; // parsed non-secret inputs
  secrets: JobSecrets; // in-memory only, never persisted
  state: Record<string, unknown>; // persisted to job_steps.state_json after each step
  shared: Record<string, unknown>; // persisted to jobs.inputs_json.shared between steps
  log(message: string, data?: Record<string, unknown>): void;
  change(change: FileChange | CommandChange): void;
  ask(q: Omit<JobQuestion, 'questionId'>): Promise<string | boolean>;
  fail(code: ErrorCode, message: string): never;
}

export interface StepDef {
  key: string;
  name: string; // plain language shown to the user
  kind: 'script' | 'agent';
  idempotent: boolean; // safe to re-run after a crash
  maxAttempts?: number; // default 1
  run(ctx: StepContext): Promise<void>;
  verify?(ctx: StepContext): Promise<void>;
  onFailure?(ctx: StepContext, err: unknown): Promise<void>;
}

export interface JobFinalFailureContext {
  jobId: string;
  projectId: string;
  inputs: unknown;
}

export interface JobDef {
  kind: JobKind;
  build(inputs: unknown): StepDef[];
  onFinalFailure?(ctx: JobFinalFailureContext): Promise<'failed' | 'rolled_back'>;
}
