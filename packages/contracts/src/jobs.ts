export type JobKind =
  'deploy_own_server' | 'deploy_free' | 'update' | 'rollback' | 'diagnose' | 'maintenance';
export type JobStatus =
  'queued' | 'running' | 'waiting_user' | 'succeeded' | 'failed' | 'rolled_back' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface JobEvent {
  jobId: string;
  seq: number; // strictly increasing per job, starts at 1
  ts: string; // ISO 8601 UTC
  type: 'step_started' | 'step_log' | 'step_finished' | 'question' | 'answer' | 'change' | 'error' | 'done';
  stepId?: string;
  message: string; // plain language, redacted
  data?: Record<string, unknown>;
  // type 'question' -> data: JobQuestion
  // type 'answer'   -> data: { questionId, display }   (display is '••••' for secret answers)
  // type 'change'   -> data: { change: { kind: 'file'; path: string; action: 'added'|'modified'|'deleted' }
  //                              | { kind: 'command'; cmd: string; code: number } }
  // type 'error'    -> data: { code: ErrorCode }
  // type 'done'     -> data: { status: JobStatus; siteUrl?: string }
}

export type QuestionKind = 'confirm' | 'choice' | 'text' | 'secret';
export interface JobQuestion {
  questionId: string;
  kind: QuestionKind;
  title: string;
  body: string; // plain language, may contain a fingerprint or a summary
  options?: { id: string; label: string; description?: string }[]; // for 'choice'
  confirmLabel?: string;
  cancelLabel?: string; // for 'confirm'
  placeholder?: string; // for 'text' / 'secret'
}
export interface JobAnswer {
  jobId: string;
  questionId: string;
  value: string | boolean;
}

export interface JobSummary {
  id: string;
  projectId: string;
  kind: JobKind;
  status: JobStatus;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
}
export interface JobStepView {
  id: string;
  name: string;
  kind: 'script' | 'agent';
  status: StepStatus;
  attempt: number;
  startedAt?: string;
  finishedAt?: string;
}
