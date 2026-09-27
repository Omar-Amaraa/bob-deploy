import type { AgentRunner, AgentTask, StackInfo } from '@bob-deploy/contracts';
import type { Clock } from '@bob-deploy/contracts';
import {
  runAllowed,
  diffStaging,
  applyGate,
  syncBack,
  NODE_ALLOWED,
  PYTHON_ALLOWED,
  fixResultSchema,
  type StagingWorkspace,
  type DiffResult,
} from '@bob-deploy/agent';
import type { StepContext } from '../jobs/types.js';
import type { SnapshotsRepo } from '../db/repos/snapshots.js';
import { takeSnapshot } from '../snapshots/snapshot.js';
import { forwardBobEvent } from './analyse.js';

const MAX_FIX_ATTEMPTS = 3;
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const FIX_MAX_TURNS = 30;
const FIX_TIMEOUT_MS = 600_000;

/** Minimal redaction surface buildWithFixes needs; core's real Redactor satisfies this. */
export interface RedactorLike {
  redact(text: string): string;
}

export interface BuildWithFixesInput {
  ctx: StepContext;
  staging: StagingWorkspace;
  projectDir: string;
  projectId: string;
  dataDir: string;
  stack: StackInfo;
  runner: AgentRunner;
  redactor: RedactorLike;
  snapshotsRepo: SnapshotsRepo;
  clock: Clock;
}

export interface BuildWithFixesResult {
  /** True once install+build both succeed (possibly after Bob fix attempts). */
  ok: boolean;
  /** True if any file or command from a fix attempt was ever accepted and synced back. */
  fixApplied: boolean;
  attempts: number;
}

function defaultAllowedFor(stack: StackInfo): readonly string[] {
  if (stack.type === 'python') return PYTHON_ALLOWED;
  return NODE_ALLOWED; // static/node both build with npm-family tooling (or nothing at all)
}

function effectiveAllowlist(stack: StackInfo): string[] {
  const base = [...defaultAllowedFor(stack)];
  for (const cmd of [stack.installCmd, stack.buildCmd]) {
    if (cmd && !base.includes(cmd)) base.push(cmd);
  }
  return base;
}

interface RunOutcome {
  ok: boolean;
  command?: string;
  output: string;
}

/** Runs installCmd then buildCmd (either may be absent, e.g. a static site with nothing to
 * install) via runAllowed against the staging copy. Stops at the first failing command. */
async function runInstallAndBuild(
  staging: StagingWorkspace,
  stack: StackInfo,
  allowed: string[],
  ctx: StepContext,
  redactor: RedactorLike,
): Promise<RunOutcome> {
  const commands = [stack.installCmd, stack.buildCmd].filter((c): c is string => Boolean(c));
  for (const cmd of commands) {
    const chunks: string[] = [];
    ctx.log(`Running ${cmd}.`);
    const result = await runAllowed(cmd, {
      cwd: staging.dir,
      allowed,
      timeoutMs: BUILD_TIMEOUT_MS,
      onOutput: (chunk) => {
        chunks.push(chunk);
        const visible = redactor.redact(chunk).trim();
        if (visible) ctx.log(visible, { command: cmd });
      },
    });
    const output = chunks.join('');
    if (result.code !== 0) return { ok: false, command: cmd, output };
    ctx.log(`Finished ${cmd}.`, { command: cmd, code: result.code });
  }
  return { ok: true, output: '' };
}

/** Merges one attempt's accepted diff into the running cumulative diff, tracking each path's net
 * action relative to the ORIGINAL project folder (not just the latest attempt), so a file that
 * was added in attempt 1 and touched again in attempt 2 is still synced as 'added' with its
 * latest content, and a file added then deleted within the fix loop nets out to nothing. */
function mergeDiff(cumulative: DiffResult, incoming: DiffResult): DiffResult {
  const added = new Set(cumulative.added);
  const modified = new Set(cumulative.modified);
  const deleted = new Set(cumulative.deleted);

  for (const path of incoming.added) {
    if (deleted.has(path)) {
      deleted.delete(path);
      modified.add(path); // existed originally, was deleted, now recreated -> net modification
    } else {
      added.add(path);
    }
  }
  for (const path of incoming.modified) {
    if (!added.has(path)) modified.add(path);
  }
  for (const path of incoming.deleted) {
    if (added.has(path)) {
      added.delete(path); // created and deleted within the fix loop -> no-op for the project
    } else {
      modified.delete(path);
      deleted.add(path);
    }
  }
  return { added: [...added], modified: [...modified], deleted: [...deleted] };
}

function isEmptyDiff(diff: DiffResult): boolean {
  return diff.added.length === 0 && diff.modified.length === 0 && diff.deleted.length === 0;
}

/**
 * Runs the install+build commands for a staged copy of the project, and — on failure — drives up
 * to MAX_FIX_ATTEMPTS rounds of Bob's `fix_build` agent task, gating and accepting each round's
 * changes before rebuilding. Every accepted change lives only in `staging` until the very end: on
 * final success (with at least one fix applied), the user's live folder is snapshotted and then
 * synced with the accumulated accepted diff; on final failure, `syncBack` is never called, so the
 * user's folder is left byte-identical to how it started.
 */
export async function buildWithFixes(input: BuildWithFixesInput): Promise<BuildWithFixesResult> {
  const { ctx, staging, stack, runner, redactor, clock } = input;
  const allowed = effectiveAllowlist(stack);

  let outcome = await runInstallAndBuild(staging, stack, allowed, ctx, redactor);
  let cumulativeDiff: DiffResult = { added: [], modified: [], deleted: [] };
  let attempts = 0;

  while (!outcome.ok && attempts < MAX_FIX_ATTEMPTS) {
    attempts++;
    ctx.log(`Build failed (attempt ${attempts}/${MAX_FIX_ATTEMPTS}); asking Bob to fix it.`, {
      command: outcome.command,
    });

    // diagnose.ts (problem:signal, proposedAction 'update_with_fix') stashes Bob's own
    // fixInstructions in ctx.state before delegating into update.ts's step, which calls this
    // function unmodified — this is the one seam that carries them through.
    const extraInstructions = typeof ctx.state.fixInstructions === 'string' ? ctx.state.fixInstructions : undefined;
    const task: AgentTask = {
      kind: 'fix_build',
      cwd: staging.dir,
      instructions: extraInstructions ? `Fix the failing build. ${extraInstructions}` : 'Fix the failing build.',
      context: {
        command: outcome.command,
        output: redactor.redact(outcome.output),
      },
      allowedCommands: allowed,
      maxTurns: FIX_MAX_TURNS,
      timeoutMs: FIX_TIMEOUT_MS,
    };

    let fixResultData: unknown;
    for await (const event of runner.run(task)) {
      forwardBobEvent(ctx, event);
      if (event.type === 'result') fixResultData = event.data;
    }

    // The diff is always computed from the real filesystem, never from Bob's self-reported
    // changedFiles — that field is advisory only and not to be trusted for the gate decision.
    const diff = await diffStaging(staging);
    const gate = await applyGate(staging, input.projectDir, diff);
    for (const rejection of gate.rejected) {
      ctx.log(`Rejected a change from Bob's fix attempt: ${rejection.path} (${rejection.reason})`);
    }
    for (const path of gate.accepted.added) ctx.change({ kind: 'file', path, action: 'added' });
    for (const path of gate.accepted.modified) ctx.change({ kind: 'file', path, action: 'modified' });
    for (const path of gate.accepted.deleted) ctx.change({ kind: 'file', path, action: 'deleted' });
    cumulativeDiff = mergeDiff(cumulativeDiff, gate.accepted);

    const parsedFix = fixResultSchema.safeParse(fixResultData);
    const requestedCommands = parsedFix.success ? parsedFix.data.requestedCommands : [];
    for (const cmd of requestedCommands) {
      try {
        const result = await runAllowed(cmd, { cwd: staging.dir, allowed, timeoutMs: BUILD_TIMEOUT_MS });
        ctx.change({ kind: 'command', cmd, code: result.code ?? -1 });
      } catch {
        ctx.log(`Skipped a command Bob requested that isn't on the allowlist: ${cmd}`);
      }
    }

    outcome = await runInstallAndBuild(staging, stack, allowed, ctx, redactor);
  }

  const fixApplied = attempts > 0 && !isEmptyDiff(cumulativeDiff);

  if (!outcome.ok) {
    // Nothing is synced back on failure — the project folder was never touched, only `staging`.
    return { ok: false, fixApplied, attempts };
  }

  if (fixApplied) {
    await takeSnapshot({
      projectId: input.projectId,
      projectDir: input.projectDir,
      dataDir: input.dataDir,
      reason: 'before Bob fixes',
      snapshotsRepo: input.snapshotsRepo,
      clock,
    });
    for await (const event of syncBack(staging, input.projectDir, cumulativeDiff)) {
      if (event.type === 'file_changed') ctx.log(`Synced ${event.action}: ${event.path}`);
    }
  }

  return { ok: true, fixApplied, attempts };
}
