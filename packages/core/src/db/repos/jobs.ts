import type Database from 'better-sqlite3';
import type {
  JobAnswer,
  JobEvent,
  JobKind,
  JobQuestion,
  JobStatus,
  JobStepView,
  JobSummary,
  StepStatus,
} from '@bob-deploy/contracts';
import { newId, nowIso, RepoError } from '../../util.js';

interface JobRow {
  id: string;
  project_id: string;
  kind: string;
  status: string;
  inputs_json: string | null;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
}

interface JobStepRow {
  id: string;
  job_id: string;
  idx: number;
  step_key: string;
  name: string;
  kind: string;
  status: string;
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  state_json: string | null;
}

interface JobEventRow {
  job_id: string;
  seq: number;
  ts: string;
  type: string;
  step_id: string | null;
  message: string;
  data_json: string | null;
}

interface JobQuestionRow {
  job_id: string;
  question_id: string;
  question_json: string;
  asked_at: string;
  answered_at: string | null;
  answer_display: string | null;
}

function toSummary(row: JobRow): JobSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    startedAt: row.started_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
  };
}

function toStepView(row: JobStepRow): JobStepView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as JobStepView['kind'],
    status: row.status as StepStatus,
    attempt: row.attempt,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

function toEvent(row: JobEventRow): JobEvent {
  return {
    jobId: row.job_id,
    seq: row.seq,
    ts: row.ts,
    type: row.type as JobEvent['type'],
    ...(row.step_id ? { stepId: row.step_id } : {}),
    message: row.message,
    ...(row.data_json ? { data: JSON.parse(row.data_json) as Record<string, unknown> } : {}),
  };
}

function toQuestion(row: JobQuestionRow): JobQuestion {
  return JSON.parse(row.question_json) as JobQuestion;
}

export interface CreateJobInput {
  projectId: string;
  kind: JobKind;
  inputs?: unknown;
}

export interface StepPlanEntry {
  stepKey: string;
  name: string;
  kind: 'script' | 'agent';
}

/** Persisted job-step internal state, opaque to callers other than the job engine itself. */
export interface StepState {
  id: string;
  jobId: string;
  idx: number;
  stepKey: string;
  name: string;
  kind: 'script' | 'agent';
  status: StepStatus;
  attempt: number;
  startedAt?: string;
  finishedAt?: string;
  state?: unknown;
}

function toStepState(row: JobStepRow): StepState {
  return {
    id: row.id,
    jobId: row.job_id,
    idx: row.idx,
    stepKey: row.step_key,
    name: row.name,
    kind: row.kind as StepState['kind'],
    status: row.status as StepStatus,
    attempt: row.attempt,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.state_json ? { state: JSON.parse(row.state_json) } : {}),
  };
}

export class JobsRepo {
  constructor(private readonly db: Database.Database) {}

  // --- jobs -----------------------------------------------------------

  create(
    input: CreateJobInput,
    plan: StepPlanEntry[],
    clockNow?: () => Date,
  ): { job: JobSummary; steps: StepState[] } {
    const id = newId();
    const startedAt = nowIso(clockNow);
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO jobs (id, project_id, kind, status, inputs_json, started_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          input.projectId,
          input.kind,
          'queued',
          input.inputs ? JSON.stringify(input.inputs) : null,
          startedAt,
        );

      const insertStep = this.db.prepare(
        `INSERT INTO job_steps (id, job_id, idx, step_key, name, kind, status, attempt)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 1)`,
      );
      plan.forEach((entry, idx) => {
        insertStep.run(newId(), id, idx, entry.stepKey, entry.name, entry.kind);
      });
    });
    tx();
    const job = this.getSummary(id);
    if (!job) throw new RepoError('INTERNAL', 'Job vanished immediately after creation.');
    return { job, steps: this.listSteps(id) };
  }

  getSummary(id: string): JobSummary | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? toSummary(row) : undefined;
  }

  getRow(id: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  }

  listForProject(projectId: string): JobSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY started_at DESC')
      .all(projectId) as JobRow[];
    return rows.map(toSummary);
  }

  /** Jobs left running/waiting when the app last shut down — the engine resumes each of these on boot. */
  listResumable(): JobSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE status IN ('queued', 'running', 'waiting_user')")
      .all() as JobRow[];
    return rows.map(toSummary);
  }

  setStatus(id: string, status: JobStatus, opts?: { finishedAt?: string; summary?: string }): void {
    const result = this.db
      .prepare(
        'UPDATE jobs SET status = ?, finished_at = COALESCE(?, finished_at), summary = COALESCE(?, summary) WHERE id = ?',
      )
      .run(status, opts?.finishedAt ?? null, opts?.summary ?? null, id);
    if (result.changes === 0) throw new RepoError('NOT_FOUND', `Job ${id} not found.`);
  }

  listStepViews(jobId: string): JobStepView[] {
    const rows = this.db
      .prepare('SELECT * FROM job_steps WHERE job_id = ? ORDER BY idx ASC')
      .all(jobId) as JobStepRow[];
    return rows.map(toStepView);
  }

  // --- steps (internal engine state) ----------------------------------

  listSteps(jobId: string): StepState[] {
    const rows = this.db
      .prepare('SELECT * FROM job_steps WHERE job_id = ? ORDER BY idx ASC')
      .all(jobId) as JobStepRow[];
    return rows.map(toStepState);
  }

  getStep(jobId: string, idx: number): StepState | undefined {
    const row = this.db.prepare('SELECT * FROM job_steps WHERE job_id = ? AND idx = ?').get(jobId, idx) as
      JobStepRow | undefined;
    return row ? toStepState(row) : undefined;
  }

  updateStep(
    stepId: string,
    patch: {
      status?: StepStatus;
      attempt?: number;
      startedAt?: string;
      finishedAt?: string;
      state?: unknown;
    },
  ): void {
    const current = this.db.prepare('SELECT * FROM job_steps WHERE id = ?').get(stepId) as
      JobStepRow | undefined;
    if (!current) throw new RepoError('NOT_FOUND', `Job step ${stepId} not found.`);
    this.db
      .prepare(
        `UPDATE job_steps SET status = @status, attempt = @attempt, started_at = @started_at,
           finished_at = @finished_at, state_json = @state_json WHERE id = @id`,
      )
      .run({
        id: stepId,
        status: patch.status ?? current.status,
        attempt: patch.attempt ?? current.attempt,
        started_at: patch.startedAt ?? current.started_at,
        finished_at: patch.finishedAt ?? current.finished_at,
        state_json: patch.state !== undefined ? JSON.stringify(patch.state) : current.state_json,
      });
  }

  // --- events (append-only) --------------------------------------------

  /** Appends an event with the next strictly-increasing seq for this job, inside a transaction. */
  appendEvent(event: Omit<JobEvent, 'seq'>): JobEvent {
    const tx = this.db.transaction(() => {
      const next =
        (
          this.db.prepare('SELECT MAX(seq) as m FROM job_events WHERE job_id = ?').get(event.jobId) as {
            m: number | null;
          }
        ).m ?? 0;
      const seq = next + 1;
      this.db
        .prepare(
          `INSERT INTO job_events (job_id, seq, ts, type, step_id, message, data_json)
           VALUES (@job_id, @seq, @ts, @type, @step_id, @message, @data_json)`,
        )
        .run({
          job_id: event.jobId,
          seq,
          ts: event.ts,
          type: event.type,
          step_id: event.stepId ?? null,
          message: event.message,
          data_json: event.data ? JSON.stringify(event.data) : null,
        });
      return seq;
    });
    const seq = tx();
    return { ...event, seq };
  }

  listEvents(jobId: string, sinceSeq = 0): JobEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq ASC')
      .all(jobId, sinceSeq) as JobEventRow[];
    return rows.map(toEvent);
  }

  /** Deletes all events for a project's jobs. Caller must run this inside withEventDeletesAllowed(). */
  deleteEventsForJobs(jobIds: string[]): void {
    const stmt = this.db.prepare('DELETE FROM job_events WHERE job_id = ?');
    for (const jobId of jobIds) stmt.run(jobId);
  }

  // --- questions ----------------------------------------------------

  askQuestion(jobId: string, question: JobQuestion, clockNow?: () => Date): void {
    this.db
      .prepare('INSERT INTO job_questions (job_id, question_id, question_json, asked_at) VALUES (?, ?, ?, ?)')
      .run(jobId, question.questionId, JSON.stringify(question), nowIso(clockNow));
  }

  getOpenQuestion(jobId: string): JobQuestion | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM job_questions WHERE job_id = ? AND answered_at IS NULL ORDER BY asked_at DESC LIMIT 1',
      )
      .get(jobId) as JobQuestionRow | undefined;
    return row ? toQuestion(row) : undefined;
  }

  /** Records that a question was answered. `displayValue` must already be redacted for secret answers. */
  answerQuestion(answer: JobAnswer, displayValue: string, clockNow?: () => Date): void {
    const result = this.db
      .prepare(
        'UPDATE job_questions SET answered_at = ?, answer_display = ? WHERE job_id = ? AND question_id = ? AND answered_at IS NULL',
      )
      .run(nowIso(clockNow), displayValue, answer.jobId, answer.questionId);
    if (result.changes === 0) {
      throw new RepoError('NOT_FOUND', `No open question ${answer.questionId} on job ${answer.jobId}.`);
    }
  }

  deleteForProject(projectId: string): void {
    const jobIds = (
      this.db.prepare('SELECT id FROM jobs WHERE project_id = ?').all(projectId) as { id: string }[]
    ).map((r) => r.id);
    for (const jobId of jobIds) {
      this.db.prepare('DELETE FROM job_questions WHERE job_id = ?').run(jobId);
      this.db.prepare('DELETE FROM job_events WHERE job_id = ?').run(jobId);
      this.db.prepare('DELETE FROM job_steps WHERE job_id = ?').run(jobId);
    }
    this.db.prepare('DELETE FROM jobs WHERE project_id = ?').run(projectId);
  }
}
