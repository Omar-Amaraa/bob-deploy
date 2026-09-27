import spawn from 'cross-spawn';
import type { AgentEvent, AgentRunner, AgentTask, AgentTaskKind, BobKeyType } from '@bob-deploy/contracts';
import type { z } from 'zod';
import { buildPrompt, type RedactorLike as AssertOnlyRedactor } from '../prompts/builder.js';
import { installPlanSchema, fixResultSchema, diagnosisSchema, stackInfoSchema } from '../prompts/schemas.js';
import { computeManifest, diffStaging } from '../workspace/diff.js';
import type { StagingWorkspace } from '../workspace/types.js';
import { buildBobArgs } from './args.js';
import { buildScrubbedEnv } from './env.js';
import { classifyBobFailure } from './failure.js';
import { parseBobOutput } from './parse.js';
import { runProcess, type SpawnFn } from './proc.js';
import { resolveBobBinary } from './resolve.js';
import { decodeBobStreamLine } from './stream.js';
import { RESULT_BEGIN, RESULT_END } from '../prompts/output-contract.js';

/** Redactor surface BobShellRunner needs: assertNoSecrets for building the prompt (S6), plus
 * redact for scrubbing Bob's own stdout before it becomes a message event. */
export interface BobRedactor extends AssertOnlyRedactor {
  redact(text: string): string;
}

export interface BobShellRunnerConfig {
  keyType: BobKeyType;
  teamId?: string;
  binaryPath?: string;
  licenseAccepted: boolean;
}

export interface BobShellRunnerOptions {
  getApiKey(): Promise<string>;
  config: BobShellRunnerConfig;
  bobHome: string;
  redactor: BobRedactor;
  clock: { now(): number };
  /** Injectable for tests; defaults to cross-spawn's spawn. */
  spawnFn?: SpawnFn;
}

const MAX_STREAMED_MESSAGES = 500;

const SCHEMA_BY_KIND: Record<AgentTaskKind, z.ZodType> = {
  detect_stack: stackInfoSchema,
  plan_install: installPlanSchema,
  fix_build: fixResultSchema,
  diagnose: diagnosisSchema,
};

const RETRY_NOTICE = '\n\nYour previous answer did not match the format. Reply again, following the output contract exactly.';

/**
 * The real AgentRunner, backed by Bob Shell's headless `run --format stream-json` command.
 * Environment scrubbing, prompt redaction, output validation, timeouts and filesystem diffing stay
 * on our side of the boundary so Bob's self-reported actions are never trusted blindly.
 */
export class BobShellRunner implements AgentRunner {
  private readonly spawnFn: SpawnFn;
  private controller: AbortController | undefined;

  constructor(private readonly options: BobShellRunnerOptions) {
    this.spawnFn = options.spawnFn ?? spawn;
  }

  async *run(task: AgentTask): AsyncGenerator<AgentEvent> {
    const binary = await resolveBobBinary(this.spawnFn, this.options.config.binaryPath);
    const apiKey = await this.options.getApiKey();
    const env = buildScrubbedEnv({ bobHome: this.options.bobHome, apiKey });
    const schema = SCHEMA_BY_KIND[task.kind];

    const beforeManifest = await computeManifest(task.cwd);

    let prompt = buildPrompt(task, this.options.redactor);
    let attempt = 0;
    let messageCount = 0;
    let hiddenNoticeSent = false;
    const controller = new AbortController();
    this.controller = controller;

    // Up to two attempts total: the original, then one retry if the output didn't parse.
    for (attempt = 0; attempt < 2; attempt++) {
      const args = buildBobArgs(this.options.config, { workspace: task.cwd, maxTurns: task.maxTurns });
      const pending: AgentEvent[] = [];
      let responseText = '';
      // Bob Shell 2.x streams the answer as many assistant events WITHOUT `delta: true`, so the
      // newline-joined responseText can split the RESULT markers and JSON strings mid-token.
      // rawText keeps every fragment glued exactly as Bob produced it.
      let rawText = '';
      let finalText: string | undefined;
      let wake: (() => void) | undefined;
      let settled = false;
      let result: Awaited<ReturnType<typeof runProcess>> | undefined;
      let processError: unknown;
      // Streamed assistant text arrives in fragments; buffer until a full line is available so the
      // job log shows sentences, not word salad.
      let partialLine = '';
      // Bob prints the machine-readable RESULT block last; it is parsed, never shown.
      let insideResultBlock = false;
      const openCommands = new Map<string, string>();
      let lastCommand: string | undefined;

      const wakeUp = (): void => {
        wake?.();
        wake = undefined;
      };

      const pushMessage = (text: string): void => {
        const clean = this.options.redactor.redact(text).trim();
        if (!clean) return;
        if (messageCount >= MAX_STREAMED_MESSAGES) {
          if (!hiddenNoticeSent) {
            hiddenNoticeSent = true;
            pending.push({ type: 'message', text: '(more output hidden)' });
          }
        } else {
          messageCount++;
          pending.push({ type: 'message', text: clean });
        }
        wakeUp();
      };

      const showLine = (line: string): void => {
        if (line.includes(RESULT_BEGIN)) {
          insideResultBlock = true;
          return;
        }
        if (line.includes(RESULT_END)) {
          insideResultBlock = false;
          return;
        }
        if (insideResultBlock || /^\s*```(json)?\s*$/.test(line)) return;
        pushMessage(line);
      };

      const flushPartial = (): void => {
        if (!partialLine) return;
        const rest = partialLine;
        partialLine = '';
        showLine(rest);
      };

      const enqueue = (text: string, delta = false): void => {
        if (!delta) flushPartial();
        const combined = delta ? partialLine + text : text;
        const lines = combined.split(/\r?\n/);
        partialLine = delta ? (lines.pop() ?? '') : '';
        for (const line of lines) showLine(line);
      };

      const pushCommand = (cmd: string, code: number): void => {
        pending.push({ type: 'command', cmd: this.options.redactor.redact(cmd), code });
        wakeUp();
      };

      const promptInput = prompt.stdin
        ? `${prompt.instruction}\n\n${prompt.stdin}`
        : prompt.instruction;
      const completion = runProcess(this.spawnFn, binary, args, {
        cwd: task.cwd,
        env,
        timeoutMs: task.timeoutMs,
        stdin: promptInput,
        signal: controller.signal,
        onLine: (line, stream) => {
          if (stream === 'stderr') {
            enqueue(`Bob: ${line}`);
            return;
          }
          const decoded = decodeBobStreamLine(line, { workspace: task.cwd });
          if (decoded.responseText) {
            rawText += decoded.responseText;
            responseText += decoded.delta
              ? decoded.responseText
              : `${responseText && !responseText.endsWith('\n') ? '\n' : ''}${decoded.responseText}`;
          }
          if (decoded.finalText) finalText = decoded.finalText;
          // Assistant text is always buffered into whole lines (fragments or not); tool and status
          // lines are shown as-is and flush whatever sentence was pending.
          if (decoded.displayText) enqueue(decoded.displayText, decoded.delta === true || decoded.responseText !== undefined);
          if (decoded.toolUse?.command) {
            lastCommand = decoded.toolUse.command;
            if (decoded.toolUse.id) openCommands.set(decoded.toolUse.id, decoded.toolUse.command);
          }
          if (decoded.toolResult) {
            const id = decoded.toolResult.id;
            const cmd = id && openCommands.has(id) ? openCommands.get(id) : id ? undefined : lastCommand;
            if (id) openCommands.delete(id);
            lastCommand = undefined;
            if (cmd) pushCommand(cmd, decoded.toolResult.ok ? 0 : 1);
          }
        },
      })
        .then((value) => {
          result = value;
        })
        .catch((error: unknown) => {
          processError = error;
        })
        .finally(() => {
          flushPartial();
          settled = true;
          wakeUp();
        });

      // Yield progress as Bob emits it instead of buffering everything until the process exits.
      while (!settled || pending.length > 0) {
        const event = pending.shift();
        if (event) {
          yield event;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      await completion;
      if (processError) {
        throw processError instanceof Error ? processError : new Error('Bob Shell process failed.');
      }
      if (!result) throw new Error('Bob Shell ended without a process result.');

      if (result.code !== 0) {
        const failure = classifyBobFailure({ code: result.code, timedOut: result.timedOut, stderrTail: result.stderr.slice(-2000) });
        yield { type: 'result', ok: false, summary: failure.message, data: { code: failure.code } };
        return;
      }

      let parsed = parseBobOutput(responseText, schema);
      if (!parsed.ok && rawText !== responseText) parsed = parseBobOutput(rawText, schema);
      if (!parsed.ok && finalText) parsed = parseBobOutput(finalText, schema);
      if (!parsed.ok) parsed = parseBobOutput(result.stdout, schema);
      if (parsed.ok) {
        if (task.kind === 'fix_build') {
          const staging: StagingWorkspace = { dir: task.cwd, manifest: beforeManifest, skipped: [] };
          const diff = await diffStaging(staging);
          for (const path of diff.added) yield { type: 'file_changed', path, action: 'added' };
          for (const path of diff.modified) yield { type: 'file_changed', path, action: 'modified' };
          for (const path of diff.deleted) yield { type: 'file_changed', path, action: 'deleted' };
        }
        yield { type: 'result', ok: true, summary: `Bob completed "${task.kind}"`, data: parsed.data };
        return;
      }

      if (attempt === 0) {
        prompt = { instruction: prompt.instruction + RETRY_NOTICE, stdin: prompt.stdin };
        continue;
      }
      yield { type: 'result', ok: false, summary: `Bob's output did not match the expected format (${parsed.reason}).`, data: { code: 'BOB_BAD_OUTPUT' } };
      return;
    }
  }

  cancel(): Promise<void> {
    this.controller?.abort();
    return Promise.resolve();
  }
}
