import type { AgentTask } from '@bob-deploy/contracts';
import { ROLE_AND_RULES } from './role.js';
import { buildTaskPrompt } from './templates.js';
import { wrapUntrusted } from './untrusted.js';

/** The minimal surface of core's Redactor that prompt building needs (S6). Declared locally
 * because packages/agent has no dependency on packages/core (core depends on agent, not the
 * reverse, per CLAUDE.md's ownership rules) — any concrete Redactor satisfies this structurally. */
export interface RedactorLike {
  assertNoSecrets(text: string): void;
}

export interface BuiltPrompt {
  /** Instruction portion sent to `bob run` on stdin. */
  instruction: string;
  /** Untrusted context appended to Bob's stdin. Kept under 200 KB; truncated from the top if longer,
   * keeping the tail, with a note about what was cut. */
  stdin: string;
}

const MAX_INSTRUCTION_CHARS = 6000;
const MAX_STDIN_BYTES = 200 * 1024;

function truncateStdin(stdin: string): string {
  const bytes = Buffer.byteLength(stdin, 'utf8');
  if (bytes <= MAX_STDIN_BYTES) return stdin;
  // Truncate from the top (drop the oldest content), keep the tail, by counting from the end.
  const end = stdin.length;
  let start = 0;
  // Binary-search-free approach: walk back from the end accumulating byte length, good enough for
  // stdin sizes we ever see (a few MB of logs at most).
  let accumulated = 0;
  for (let i = end - 1; i >= 0; i--) {
    accumulated += Buffer.byteLength(stdin[i] ?? '', 'utf8');
    if (accumulated > MAX_STDIN_BYTES) {
      start = i + 1;
      break;
    }
  }
  const kept = stdin.slice(start, end);
  return `[... earlier content truncated to fit the ${MAX_STDIN_BYTES / 1024} KB limit ...]\n${kept}`;
}

function truncateInstruction(instruction: string): string {
  if (instruction.length <= MAX_INSTRUCTION_CHARS) return instruction;
  const suffix = '\n[... truncated to fit the instruction length limit ...]';
  return instruction.slice(0, MAX_INSTRUCTION_CHARS - suffix.length) + suffix;
}

/**
 * Assembles the full prompt for `task` (spec section 4): role and hard rules, task-specific
 * instructions and output contract, plus any untrusted project/log content wrapped in
 * <untrusted_project_data> blocks. BobShellRunner combines both pieces on stdin. Both
 * outputs are passed through redactor.assertNoSecrets (S6) before being returned: this throws
 * rather than silently redacting, because build output and project content need to reach Bob
 * intact to be useful (a silently-redacted error message could hide the actual bug) — the correct
 * response to a registered secret turning up here is to refuse the whole task, which is the
 * caller's job once this throws, not to send a doctored prompt.
 */
export function buildPrompt(task: AgentTask, redactor: RedactorLike): BuiltPrompt {
  const taskPrompt = buildTaskPrompt(task);

  const instructionParts = [ROLE_AND_RULES];
  if (task.instructions) instructionParts.push(task.instructions);
  if (task.allowedCommands.length > 0) {
    instructionParts.push(`If you need to run a command, only these are ever allowed:\n${task.allowedCommands.map((c) => `- ${c}`).join('\n')}`);
  }
  instructionParts.push(taskPrompt.body);
  const instruction = truncateInstruction(instructionParts.join('\n\n'));

  const stdinRaw = taskPrompt.untrustedBlocks.map((b) => wrapUntrusted(b.source, b.content)).join('\n\n');
  const stdin = truncateStdin(stdinRaw);

  redactor.assertNoSecrets(instruction);
  redactor.assertNoSecrets(stdin);

  return { instruction, stdin };
}
