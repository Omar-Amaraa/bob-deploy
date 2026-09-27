export type AgentTaskKind = 'detect_stack' | 'plan_install' | 'fix_build' | 'diagnose';
export interface AgentTask {
  kind: AgentTaskKind;
  cwd: string; // staging copy; the only folder Bob may edit
  instructions: string;
  context: { command?: string; output?: string; logs?: string; hints?: Record<string, unknown> };
  allowedCommands: string[];
  maxTurns: number;
  timeoutMs: number;
}
export type AgentEvent =
  | { type: 'message'; text: string }
  | { type: 'file_changed'; path: string; action: 'added' | 'modified' | 'deleted' }
  | { type: 'command'; cmd: string; code: number }
  | { type: 'result'; ok: boolean; summary: string; data?: unknown };
export interface AgentRunner {
  run(task: AgentTask): AsyncIterable<AgentEvent>;
  cancel(): Promise<void>;
}

export interface InstallPlan {
  runtime: { name: 'node' | 'python'; version: string } | null;
  aptPackages: string[];
  notes: string[];
}
export interface FixResult {
  fixed: boolean;
  summary: string;
  changedFiles: string[];
  requestedCommands: string[];
}
export interface Diagnosis {
  summary: string;
  likelyCause: string;
  userMessage: string;
  proposedAction: 'update_with_fix' | 'rollback' | 'maintenance' | 'none';
  fixInstructions?: string;
}
