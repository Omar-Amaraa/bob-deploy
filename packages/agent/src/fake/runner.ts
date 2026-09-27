import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { AgentEvent, AgentRunner, AgentTask, AgentTaskKind } from '@bob-deploy/contracts';

export interface FakeRunnerResponse {
  events: AgentEvent[];
  /**
   * Files to write or delete once this response is picked, keyed by a path relative to
   * `task.cwd` (or an absolute path, or a path containing `..`). FakeRunner does not sanitise
   * these at all — it applies them exactly as given, the same way a real, possibly-malicious
   * agent could try to. That is the point: this class exists so tests can prove the *downstream*
   * defenses (the diff gate in particular) catch an edit outside the project, an edit to `.env`,
   * or any other forbidden path, not so FakeRunner itself is safe.
   */
  edits?: Record<string, string | null>;
  delayMs?: number;
}

export type FakeRunnerScript = Partial<Record<AgentTaskKind, FakeRunnerResponse[]>>;

function resolveEditPath(cwd: string, relOrAbs: string): string {
  // Deliberately permissive: join+resolve follows '..' wherever it points, including outside cwd,
  // and an absolute path is used as-is. See the FakeRunnerResponse.edits doc comment above.
  return resolve(cwd, relOrAbs);
}

async function applyEdits(cwd: string, edits: Record<string, string | null> | undefined): Promise<void> {
  if (!edits) return;
  for (const [path, content] of Object.entries(edits)) {
    const target = resolveEditPath(cwd, path);
    if (content === null) {
      await unlink(target).catch(() => undefined);
    } else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A scripted stand-in for BobShellRunner, used in tests that need a deterministic AgentRunner:
 * ordinary happy-path fixtures, and adversarial ("malicious") scripts that try to edit outside the
 * project, edit .env files, or request disallowed commands, to prove the staging/diff-gate and
 * runAllowed layers actually stop those things regardless of what the agent asks for.
 */
export class FakeRunner implements AgentRunner {
  private readonly queues: Map<AgentTaskKind, FakeRunnerResponse[]>;
  private cancelled = false;

  constructor(script: FakeRunnerScript) {
    this.queues = new Map(Object.entries(script) as [AgentTaskKind, FakeRunnerResponse[]][]);
  }

  run(task: AgentTask): AsyncIterable<AgentEvent> {
    const queue = this.queues.get(task.kind);
    const response = queue?.shift();
    return this.runResponse(task, response);
  }

  private async *runResponse(task: AgentTask, response: FakeRunnerResponse | undefined): AsyncGenerator<AgentEvent> {
    if (!response) {
      yield { type: 'result', ok: false, summary: `FakeRunner has no scripted response left for "${task.kind}"` };
      return;
    }
    if (response.delayMs) await sleep(response.delayMs);
    await applyEdits(task.cwd, response.edits);
    for (const event of response.events) {
      if (this.cancelled) return;
      yield event;
    }
  }

  cancel(): Promise<void> {
    this.cancelled = true;
    return Promise.resolve();
  }
}

/** Convenience for building a single-file edits map keyed relative to a project's staging root. */
export function editAt(cwd: string, relPath: string): string {
  return join(cwd, ...relPath.split('/'));
}
