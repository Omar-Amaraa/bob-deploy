import type Database from 'better-sqlite3';
import type {
  Clock,
  ErrorCode,
  JobEvent,
  JobKind,
  JobQuestion,
  JobStatus,
  JobStepView,
  JobSummary,
} from '@bob-deploy/contracts';
import { JobsRepo, type StepPlanEntry, type StepState } from '../db/repos/jobs.js';
import { newId } from '../util.js';
import { StepError } from './types.js';
import type { CommandChange, FileChange, JobDef, JobSecrets, StepContext, StepDef } from './types.js';

const MAX_MESSAGE_LENGTH = 4000;
const MAX_CONCURRENT_JOBS = 3;
const MAX_TEXT_ANSWER_LENGTH = 4096;

export interface JobEngineOptions {
  db: Database.Database;
  redact: (s: string) => string;
  clock: Clock;
  emit: (event: JobEvent) => void;
  registry: Map<JobKind, JobDef>;
}

interface PendingAnswer {
  questionId: string;
  kind: JobQuestion['kind'];
  resolve: (value: string | boolean) => void;
  reject: (err: unknown) => void;
}

interface RunningEntry {
  abortController: AbortController;
  pendingAnswer?: PendingAnswer;
}

function truncate(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : message;
}

/** Applies `redact` to every string, recursively, inside a JSON-shaped value. */
function redactDeep(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redact);
    return out;
  }
  return value;
}

/**
 * Resumable job engine: persists every job/step transition to SQLite so that a crash mid-job can be
 * recovered from on the next resumeAll() call. See docs/briefs/CLAUDE_CODE_BRIEF.md task A2 and
 * DEC-A2 in docs/DECISIONS.md for the exact state machine this implements.
 */
export class JobEngine {
  private readonly db: Database.Database;
  private readonly redact: (s: string) => string;
  private readonly clock: Clock;
  private readonly emit: (event: JobEvent) => void;
  private readonly registry: Map<JobKind, JobDef>;
  private readonly repo: JobsRepo;

  private readonly secretsByJob = new Map<string, JobSecrets>();
  private readonly running = new Map<string, RunningEntry>();
  private readonly queue: string[] = [];

  constructor(opts: JobEngineOptions) {
    this.db = opts.db;
    this.redact = opts.redact;
    this.clock = opts.clock;
    this.emit = opts.emit;
    this.registry = opts.registry;
    this.repo = new JobsRepo(this.db);
  }

  // --- starting ---------------------------------------------------------

  start(projectId: string, kind: JobKind, inputs: unknown, secrets?: JobSecrets): string {
    const active = this.repo
      .listResumable()
      .find((j) => j.projectId === projectId && ['queued', 'running', 'waiting_user'].includes(j.status));
    if (active) {
      throw new StepError('JOB_RUNNING', 'A job is already running for this project.');
    }

    const jobDef = this.registry.get(kind);
    if (!jobDef) throw new StepError('INTERNAL', `No JobDef registered for kind "${kind}".`);

    const steps = jobDef.build(inputs);
    const plan: StepPlanEntry[] = steps.map((s) => ({ stepKey: s.key, name: s.name, kind: s.kind }));
    const { job } = this.repo.create({ projectId, kind, inputs }, plan, () => this.clock.now());

    if (secrets) this.secretsByJob.set(job.id, secrets);
    else this.secretsByJob.set(job.id, new Map());

    this.tryStart(job.id, steps, jobDef);
    return job.id;
  }

  private tryStart(jobId: string, steps: StepDef[], jobDef: JobDef): void {
    if (this.running.size >= MAX_CONCURRENT_JOBS) {
      this.queue.push(jobId);
      return;
    }
    this.running.set(jobId, { abortController: new AbortController() });
    void this.runJob(jobId, steps, jobDef);
  }

  private dequeueNext(): void {
    const nextId = this.queue.shift();
    if (!nextId) return;
    const jobRow = this.repo.getRow(nextId);
    if (!jobRow) return;
    const jobDef = this.registry.get(jobRow.kind as JobKind);
    if (!jobDef) return;
    const nextInputs: unknown = jobRow.inputs_json ? (JSON.parse(jobRow.inputs_json) as unknown) : undefined;
    const steps = jobDef.build(nextInputs);
    this.running.set(nextId, { abortController: new AbortController() });
    void this.runJob(nextId, steps, jobDef);
  }

  private finishRunning(jobId: string): void {
    this.running.delete(jobId);
    this.secretsByJob.delete(jobId);
    this.dequeueNext();
  }

  // --- event emission -----------------------------------------------------

  private appendAndEmit(event: Omit<JobEvent, 'seq'>): JobEvent {
    const redactedMessage = truncate(this.redact(event.message));
    const redactedData = event.data
      ? (redactDeep(event.data, this.redact) as Record<string, unknown>)
      : undefined;
    const stored = this.repo.appendEvent({ ...event, message: redactedMessage, data: redactedData });
    this.emit(stored);
    for (const listener of this.liveListeners) listener(stored);
    return stored;
  }

  // --- step context -----------------------------------------------------

  private makeContext(
    jobId: string,
    projectId: string,
    stepRow: StepState,
    inputs: unknown,
    shared: Record<string, unknown>,
    signal: AbortSignal,
  ): StepContext {
    const secrets: JobSecrets = this.secretsByJob.get(jobId) ?? new Map<string, string>();
    const ctx: StepContext = {
      jobId,
      projectId,
      stepId: stepRow.id,
      attempt: stepRow.attempt,
      signal,
      inputs,
      secrets,
      state: (stepRow.state as Record<string, unknown>) ?? {},
      shared,
      log: (message, data) => {
        this.appendAndEmit({
          jobId,
          ts: this.clock.now().toISOString(),
          type: 'step_log',
          stepId: stepRow.id,
          message,
          ...(data ? { data } : {}),
        });
      },
      change: (change: FileChange | CommandChange) => {
        this.appendAndEmit({
          jobId,
          ts: this.clock.now().toISOString(),
          type: 'change',
          stepId: stepRow.id,
          message: change.kind === 'file' ? `${change.action} ${change.path}` : `ran: ${change.cmd}`,
          data: { change },
        });
      },
      ask: (q) => this.askInternal(jobId, stepRow.id, q),
      fail: (code, message) => {
        throw new StepError(code, message);
      },
    };
    return ctx;
  }

  private askInternal(
    jobId: string,
    stepId: string,
    q: Omit<JobQuestion, 'questionId'>,
  ): Promise<string | boolean> {
    const questionId = newId();
    const question: JobQuestion = { ...q, questionId };
    this.repo.askQuestion(jobId, question, () => this.clock.now());
    this.repo.setStatus(jobId, 'waiting_user');
    this.appendAndEmit({
      jobId,
      ts: this.clock.now().toISOString(),
      type: 'question',
      stepId,
      message: question.title,
      data: question as unknown as Record<string, unknown>,
    });
    return new Promise<string | boolean>((resolve, reject) => {
      const entry = this.running.get(jobId);
      if (entry) entry.pendingAnswer = { questionId, kind: question.kind, resolve, reject };
      else {
        // Resumed-but-not-tracked path (shouldn't normally happen): store nothing to wait on.
        reject(new StepError('INTERNAL', 'No running entry for job while asking a question.'));
      }
    });
  }

  answer(jobId: string, questionId: string, value: string | boolean): void {
    const entry = this.running.get(jobId);
    const pending = entry?.pendingAnswer;
    if (!pending || pending.questionId !== questionId) {
      throw new StepError('NOT_FOUND', `No open question ${questionId} on job ${jobId}.`);
    }
    this.validateAnswer(pending.kind, value);
    const display = pending.kind === 'secret' ? '••••' : String(value);
    this.repo.answerQuestion({ jobId, questionId, value }, display, () => this.clock.now());
    this.repo.setStatus(jobId, 'running');
    this.appendAndEmit({
      jobId,
      ts: this.clock.now().toISOString(),
      type: 'answer',
      message: 'Answer received.',
      data: { questionId, display },
    });
    entry.pendingAnswer = undefined;
    pending.resolve(value);
  }

  private validateAnswer(kind: JobQuestion['kind'], value: string | boolean): void {
    if (kind === 'confirm' && typeof value !== 'boolean') {
      throw new StepError('VALIDATION', 'This question expects a yes/no answer.');
    }
    if ((kind === 'text' || kind === 'secret' || kind === 'choice') && typeof value !== 'string') {
      throw new StepError('VALIDATION', 'This question expects a text answer.');
    }
    if (typeof value === 'string' && value.length > MAX_TEXT_ANSWER_LENGTH) {
      throw new StepError('VALIDATION', 'Answer is too long.');
    }
  }

  // --- main run loop -------------------------------------------------------

  private async runJob(jobId: string, steps: StepDef[], jobDef: JobDef): Promise<void> {
    const jobRow = this.repo.getRow(jobId);
    if (!jobRow) {
      this.finishRunning(jobId);
      return;
    }
    const projectId = jobRow.project_id;
    const inputs: unknown = jobRow.inputs_json ? (JSON.parse(jobRow.inputs_json) as unknown) : undefined;
    const shared: Record<string, unknown> =
      (inputs && typeof inputs === 'object' && 'shared' in (inputs as Record<string, unknown>)
        ? ((inputs as Record<string, unknown>).shared as Record<string, unknown>)
        : undefined) ?? {};

    if (jobRow.status !== 'succeeded' && jobRow.status !== 'failed') this.repo.setStatus(jobId, 'running');

    let startIdx = 0;
    const persistedSteps = this.repo.listSteps(jobId);
    const firstIncomplete = persistedSteps.findIndex(
      (s) => s.status !== 'succeeded' && s.status !== 'skipped',
    );
    if (firstIncomplete >= 0) startIdx = firstIncomplete;

    const entry = this.running.get(jobId);
    const signal = entry?.abortController.signal ?? new AbortController().signal;

    for (let idx = startIdx; idx < steps.length; idx++) {
      const stepDef = steps[idx];
      if (!stepDef) continue;
      let stepRow = this.repo.getStep(jobId, idx);
      if (!stepRow) continue;

      if (signal.aborted) {
        this.repo.updateStep(stepRow.id, { status: 'failed' });
        await this.finishJob(jobId, projectId, inputs, 'cancelled');
        return;
      }

      const maxAttempts = stepDef.maxAttempts ?? 1;
      let succeeded = false;
      let lastError: unknown;

      while (stepRow.attempt <= maxAttempts && !succeeded) {
        this.repo.updateStep(stepRow.id, { status: 'running', startedAt: this.clock.now().toISOString() });
        this.appendAndEmit({
          jobId,
          ts: this.clock.now().toISOString(),
          type: 'step_started',
          stepId: stepRow.id,
          message: stepDef.name,
        });

        const ctx = this.makeContext(jobId, projectId, stepRow, inputs, shared, signal);
        try {
          await stepDef.run(ctx);
          if (stepDef.verify) await stepDef.verify(ctx);
          this.repo.updateStep(stepRow.id, {
            status: 'succeeded',
            finishedAt: this.clock.now().toISOString(),
            state: ctx.state,
          });
          this.appendAndEmit({
            jobId,
            ts: this.clock.now().toISOString(),
            type: 'step_finished',
            stepId: stepRow.id,
            message: `${stepDef.name}: done`,
          });
          succeeded = true;
        } catch (err) {
          lastError = err;
          this.repo.updateStep(stepRow.id, { state: ctx.state });
          if (signal.aborted || (err instanceof StepError && err.code === 'CANCELLED')) {
            this.repo.updateStep(stepRow.id, {
              status: 'failed',
              finishedAt: this.clock.now().toISOString(),
            });
            await this.finishJob(jobId, projectId, inputs, 'cancelled');
            return;
          }
          if (stepRow.attempt < maxAttempts) {
            const nextAttempt = stepRow.attempt + 1;
            this.appendAndEmit({
              jobId,
              ts: this.clock.now().toISOString(),
              type: 'step_log',
              stepId: stepRow.id,
              message: `Trying again (${nextAttempt} of ${maxAttempts})`,
            });
            this.repo.updateStep(stepRow.id, { attempt: nextAttempt });
            stepRow = this.repo.getStep(jobId, idx) ?? stepRow;
          } else {
            break;
          }
        }
      }

      if (!succeeded) {
        const code = lastError instanceof StepError ? lastError.code : 'INTERNAL';
        const message = lastError instanceof Error ? lastError.message : 'Step failed.';
        const ctx = this.makeContext(jobId, projectId, stepRow, inputs, shared, signal);
        if (stepDef.onFailure) {
          try {
            await stepDef.onFailure(ctx, lastError);
          } catch {
            // best-effort local recovery; the original failure still drives the outcome
          }
        }
        this.repo.updateStep(stepRow.id, { status: 'failed', finishedAt: this.clock.now().toISOString() });
        this.appendAndEmit({
          jobId,
          ts: this.clock.now().toISOString(),
          type: 'error',
          stepId: stepRow.id,
          message,
          data: { code },
        });
        const finalStatus = (await jobDef.onFinalFailure?.({ jobId, projectId, inputs })) ?? 'failed';
        await this.finishJob(jobId, projectId, inputs, finalStatus);
        return;
      }
    }

    await this.finishJob(jobId, projectId, inputs, 'succeeded');
  }

  private async finishJob(
    jobId: string,
    _projectId: string,
    _inputs: unknown,
    status: JobStatus,
  ): Promise<void> {
    this.repo.setStatus(jobId, status, { finishedAt: this.clock.now().toISOString() });
    this.appendAndEmit({
      jobId,
      ts: this.clock.now().toISOString(),
      type: 'done',
      message: `Job ${status}.`,
      data: { status },
    });
    this.finishRunning(jobId);
    await Promise.resolve();
  }

  // --- cancel ---------------------------------------------------------

  cancel(jobId: string): void {
    const entry = this.running.get(jobId);
    if (!entry) {
      const job = this.repo.getSummary(jobId);
      if (!job) throw new StepError('NOT_FOUND', `Job ${jobId} not found.`);
      if (job.status === 'waiting_user' || job.status === 'queued' || job.status === 'running') {
        this.repo.setStatus(jobId, 'cancelled', { finishedAt: this.clock.now().toISOString() });
        this.appendAndEmit({
          jobId,
          ts: this.clock.now().toISOString(),
          type: 'done',
          message: 'Job cancelled.',
          data: { status: 'cancelled' },
        });
      }
      return;
    }
    entry.abortController.abort();
    if (entry.pendingAnswer) {
      entry.pendingAnswer.reject(new StepError('CANCELLED', 'Job cancelled while waiting for an answer.'));
      entry.pendingAnswer = undefined;
    }
  }

  // --- subscribe --------------------------------------------------------

  subscribe(jobId: string, fromSeq: number, listener: (event: JobEvent) => void): () => void {
    for (const event of this.repo.listEvents(jobId, fromSeq)) listener(event);
    const wrapped = (event: JobEvent): void => {
      if (event.jobId === jobId) listener(event);
    };
    this.liveListeners.add(wrapped);
    return () => this.liveListeners.delete(wrapped);
  }

  private readonly liveListeners = new Set<(event: JobEvent) => void>();

  // --- queries ----------------------------------------------------------

  /** True while any job is actively running in this process — wired to AccountService's `busy`
   * option so the idle-lock timer defers locking the vault mid-job (registerIpc/createCore). */
  isBusy(): boolean {
    return this.running.size > 0;
  }

  getJob(
    jobId: string,
  ): { job: JobSummary; steps: JobStepView[]; pendingQuestion?: JobQuestion } | undefined {
    const job = this.repo.getSummary(jobId);
    if (!job) return undefined;
    const steps = this.repo.listStepViews(jobId);
    const pendingQuestion = this.repo.getOpenQuestion(jobId);
    return { job, steps, ...(pendingQuestion ? { pendingQuestion } : {}) };
  }

  listJobs(projectId: string, limit = 20): JobSummary[] {
    return this.repo.listForProject(projectId).slice(0, limit);
  }

  // --- resume -------------------------------------------------------------

  /**
   * Called once on app startup. Re-attaches to every job left queued/running/waiting_user when the
   * app last shut down. A job's current step (the first one not yet succeeded/skipped) is: re-run
   * from scratch (attempt+1) if it's idempotent — including one the app was waiting_user on, which
   * re-asks its question as part of re-running; marked failed with an explanatory message, with no
   * guess at partial progress, if it isn't idempotent.
   */
  resumeAll(): void {
    for (const job of this.repo.listResumable()) {
      const jobDef = this.registry.get(job.kind);
      if (!jobDef) continue;
      const jobRow = this.repo.getRow(job.id);
      const inputs: unknown = jobRow?.inputs_json ? (JSON.parse(jobRow.inputs_json) as unknown) : undefined;
      const steps = jobDef.build(inputs);
      this.secretsByJob.set(job.id, new Map());

      if (job.status === 'queued') {
        this.tryStart(job.id, steps, jobDef);
        continue;
      }

      const persistedSteps = this.repo.listSteps(job.id);
      const current = persistedSteps.find((s) => s.status !== 'succeeded' && s.status !== 'skipped');
      const stepDef = current ? steps[current.idx] : undefined;

      if (current && stepDef && !stepDef.idempotent) {
        this.repo.updateStep(current.id, { status: 'failed', finishedAt: this.clock.now().toISOString() });
        this.appendAndEmit({
          jobId: job.id,
          ts: this.clock.now().toISOString(),
          type: 'error',
          stepId: current.id,
          message: 'The app closed during this step. Nothing was changed after that point.',
          data: { code: 'INTERNAL' satisfies ErrorCode },
        });
        void this.finishJob(job.id, job.projectId, inputs, 'failed');
        continue;
      }

      if (current) {
        // Give the resumed attempt a fresh attempt budget: a crash isn't one of the step's own retries.
        this.repo.updateStep(current.id, { status: 'pending', attempt: 1 });
      }
      this.tryStart(job.id, steps, jobDef);
    }
  }
}
