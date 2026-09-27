import type { StackInfo, AgentEvent, AgentRunner, AgentTask } from '@bob-deploy/contracts';
import { START_CMD_PATTERN } from '@bob-deploy/contracts';
import { detectHeuristic, stackInfoSchema, type HeuristicResult } from '@bob-deploy/agent';
import { stepFail, stepOk, type PlaybookStep, type PlaybookStepOutcome } from '../playbook/types.js';

/** Confidence at or above which the local heuristics are trusted outright, skipping Bob entirely
 * (brief step 6: "heuristics first; if confidence >= 0.9 skip Bob"). */
const HEURISTIC_CONFIDENCE_THRESHOLD = 0.9;

export interface DetectStackInput {
  /** The staging copy of the user's project (already created/diff-gated by the agent adapter). */
  projectDir: string;
  /** Only used when the heuristics aren't confident enough on their own. */
  agentRunner?: AgentRunner;
  allowedCommands?: string[];
  timeoutMs?: number;
  /** Receives Bob's live progress when heuristics need agent assistance. */
  onAgentEvent?: (event: AgentEvent) => void;
  /** DEC-021: consult Bob even when the heuristics are confident, so every deploy gets Bob's
   * review. If Bob then fails, a confident heuristic result is used instead of failing the job. */
  alwaysAskBob?: boolean;
}

export interface DetectStackOutput {
  stack: StackInfo;
  /** Whether Bob was actually consulted (false when the heuristics alone were confident enough). */
  usedBob: boolean;
  confidence: number;
  evidence: string[];
  /** Set when Bob was consulted, failed, and the confident heuristic result was used instead. */
  bobError?: string;
}

function packageJsonHasStartScript(stack: Partial<StackInfo>): boolean {
  // heuristics.ts already records whether package.json declares `scripts.start` via a note; we
  // can't inspect the file again here without re-implementing that reader, so this is inferred
  // from the heuristic's own startCmd guess for node apps: it already synthesises 'npm start' when
  // scripts.start exists (see detect/heuristics.ts). If a node app reaches this function without a
  // startCmd at all, there's no start script to fall back to either.
  return stack.type === 'node' && typeof stack.startCmd === 'string' && stack.startCmd.length > 0;
}

/**
 * Derives a startCmd that will pass START_CMD_PATTERN when the detected/proposed one doesn't,
 * per the brief: "node: 'npm run start' if scripts.start exists; python: gunicorn/uvicorn per
 * framework (with the required .venv/bin/ prefix)". Returns undefined when nothing safe can be
 * derived, in which case the caller fails UNSUPPORTED_STACK.
 */
export function deriveSafeStartCmd(stack: Partial<StackInfo>): string | undefined {
  if (stack.startCmd && START_CMD_PATTERN.test(stack.startCmd)) return stack.startCmd;

  if (stack.type === 'node') {
    // A node app with *some* startCmd guess (even one missing the .venv-only python constraints
    // doesn't apply here) is assumed to have a package.json `scripts.start`; heuristics only ever
    // proposes 'npm start'/'npm run start' style commands for node, both of which already match
    // START_CMD_PATTERN, so reaching here means the guess was something else entirely (e.g.
    // 'node server.js' with an unexpected path) — try the safest universal fallback instead.
    if (packageJsonHasStartScript(stack)) return 'npm start';
    return undefined;
  }

  if (stack.type === 'python') {
    const framework = (stack.framework ?? '').toLowerCase();
    if (framework === 'django') {
      // Gunicorn needs the WSGI module path, which we don't know generically; Bob (or the user)
      // must supply it. Nothing safe to derive.
      return undefined;
    }
    if (framework === 'fastapi') {
      // uvicorn does not read $PORT itself; the systemd instance exports PORT (and HOST=127.0.0.1).
      return '.venv/bin/uvicorn main:app --host 127.0.0.1 --port $PORT';
    }
    // Flask and any other unrecognised WSGI-style python app: gunicorn against the conventional
    // `app:app` entry point is the safest generic guess.
    return '.venv/bin/gunicorn app:app --bind 127.0.0.1:$PORT';
  }

  return undefined;
}

function toStackInfo(partial: Partial<StackInfo>): StackInfo | undefined {
  if (!partial.type) return undefined;
  return {
    needsBackend: partial.type !== 'static',
    ...partial,
    type: partial.type,
  };
}

async function runBobDetect(
  runner: AgentRunner,
  cwd: string,
  heuristic: HeuristicResult,
  allowedCommands: string[],
  timeoutMs: number,
  onAgentEvent?: (event: AgentEvent) => void,
): Promise<{ stack: StackInfo } | { error: string }> {
  const task: AgentTask = {
    kind: 'detect_stack',
    cwd,
    instructions: '',
    context: { hints: { heuristicStack: heuristic.stack, confidence: heuristic.confidence, evidence: heuristic.evidence } },
    allowedCommands,
    // Enough turns to open the few files that decide the stack (package.json, lockfile, config).
    maxTurns: 6,
    timeoutMs,
  };
  let lastResult: { ok: boolean; data?: unknown; summary: string } | undefined;
  for await (const event of runner.run(task)) {
    onAgentEvent?.(event);
    if (event.type === 'result') lastResult = event;
  }
  if (!lastResult) return { error: 'Bob returned no result for detect_stack.' };
  if (!lastResult.ok) return { error: lastResult.summary || 'Bob failed to detect the stack.' };
  const parsed = stackInfoSchema.safeParse(lastResult.data);
  if (!parsed.success) {
    return { error: `Bob's detect_stack result did not match the expected shape: ${parsed.error.message}` };
  }
  return { stack: parsed.data };
}

/**
 * Step 6 (Flow 1): detect_stack. Heuristics first; Bob only consulted when heuristics aren't
 * confident, with the heuristic guess passed as a hint. Validates/derives a safe startCmd before
 * returning, since nothing downstream (bd-app-setup, systemd) may ever receive a command that
 * fails START_CMD_PATTERN.
 */
export const detectStackStep: PlaybookStep<DetectStackInput, DetectStackOutput> = {
  id: 'detect_stack',
  title: 'Detect the project stack',
  async run(input): Promise<PlaybookStepOutcome<DetectStackOutput>> {
    const heuristic = await detectHeuristic(input.projectDir);

    let stack: StackInfo | undefined;
    let usedBob = false;
    let bobError: string | undefined;
    const confident = heuristic.confidence >= HEURISTIC_CONFIDENCE_THRESHOLD;
    const heuristicStack = toStackInfo(heuristic.stack);

    if (input.agentRunner && (input.alwaysAskBob === true || !confident)) {
      usedBob = true;
      const result = await runBobDetect(
        input.agentRunner,
        input.projectDir,
        heuristic,
        input.allowedCommands ?? [],
        input.timeoutMs ?? 180000,
        input.onAgentEvent,
      );
      if ('error' in result) {
        if (!confident || !heuristicStack) {
          return stepFail('UNSUPPORTED_STACK', `Could not determine how to run this project: ${result.error}`);
        }
        bobError = result.error;
        stack = heuristicStack;
      } else {
        stack = result.stack;
      }
    } else {
      stack = heuristicStack;
    }

    if (!stack || !stack.type) {
      return stepFail(
        'UNSUPPORTED_STACK',
        "This doesn't look like a static site, Node app or Python app Bob Deploy recognises.",
      );
    }

    // Static sites have no process to start; only node/python need a validated startCmd.
    if (stack.type !== 'static') {
      const safeCmd = deriveSafeStartCmd(stack);
      if (!safeCmd) {
        return stepFail(
          'UNSUPPORTED_STACK',
          stack.startCmd
            ? `The detected start command ("${stack.startCmd}") isn't one Bob Deploy can run safely, and no safe equivalent could be derived automatically.`
            : "Bob Deploy couldn't determine how to start this app automatically.",
        );
      }
      stack = { ...stack, startCmd: safeCmd };
    }

    return stepOk({
      stack,
      usedBob,
      confidence: heuristic.confidence,
      evidence: heuristic.evidence,
      ...(bobError ? { bobError } : {}),
    });
  },
};
