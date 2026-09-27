import type { AgentEvent, AgentRunner, StackInfo } from '@bob-deploy/contracts';
import { createStaging, removeStaging } from '@bob-deploy/agent';
import { detectStackStep, type DetectStackOutput } from '@bob-deploy/ssh-playbooks';
import type { StepContext, StepDef } from '../jobs/types.js';
import type { ProjectsRepo } from '../db/repos/projects.js';

/** ctx.shared key holding the StackInfo the analyse step settled on; release/deploy/update steps
 * reuse it instead of detecting a second time. Plain JSON, so it survives a job resume. */
export const SHARED_STACK_KEY = 'stack';

/**
 * Sends Bob's live activity to the job screen (DEC-021): his sentences and "Bob is reading
 * `package.json`"-style progress become step_log lines, and every shell command he ran becomes a
 * `change` event, which the "What Bob changed" panel lists with its exit code.
 */
export function forwardBobEvent(ctx: StepContext, event: AgentEvent): void {
  if (event.type === 'message') ctx.log(event.text);
  else if (event.type === 'command') ctx.change({ kind: 'command', cmd: event.cmd, code: event.code });
}

const TYPE_LABEL: Record<StackInfo['type'], string> = {
  static: 'a static website',
  node: 'a Node.js app',
  python: 'a Python app',
};

/** One plain-language sentence describing a stack, e.g. "a Node.js app (nextjs) — build with
 * `npm run build`, start with `npm start`". */
export function describeStack(stack: StackInfo): string {
  const parts: string[] = [];
  if (stack.installCmd) parts.push(`install with \`${stack.installCmd}\``);
  if (stack.buildCmd) parts.push(`build with \`${stack.buildCmd}\``);
  if (stack.type === 'static' && stack.outputDir && stack.outputDir !== '.')
    parts.push(`serve the \`${stack.outputDir}\` folder`);
  if (stack.startCmd) parts.push(`start with \`${stack.startCmd}\``);
  if (stack.runtimeVersion)
    parts.push(`${stack.type === 'python' ? 'Python' : 'Node.js'} ${stack.runtimeVersion}`);
  const head = `${TYPE_LABEL[stack.type]}${stack.framework ? ` (${stack.framework})` : ''}`;
  return parts.length ? `${head}: ${parts.join(', ')}` : head;
}

export interface AnalyseStepDeps {
  projectsRepo: ProjectsRepo;
  agentRunner: AgentRunner;
  dataDir: string;
  /** Whether Bob is set up (key saved + license accepted). When true, Bob reviews every project
   * even if the built-in checks are already sure (DEC-021); when false, the built-in checks run
   * alone and the log says how to turn Bob on. Defaults to false so tests stay deterministic. */
  askBob?: () => boolean;
}

/**
 * First step of every deploy/update: Bob reads a staging copy of the project and decides how to
 * build and run it. Kind 'agent' and its own step name, so the user can see in the step list when
 * Bob is working, and follow his progress live in that step's messages.
 */
export function buildAnalyseStep(deps: AnalyseStepDeps): StepDef {
  return {
    key: 'analyse',
    name: 'Bob analyses your project',
    kind: 'agent',
    idempotent: true,
    async run(ctx: StepContext): Promise<void> {
      const project = deps.projectsRepo.get(ctx.projectId);
      if (!project) ctx.fail('NOT_FOUND', 'Project not found.');

      const askBob = deps.askBob?.() ?? false;
      if (askBob) {
        ctx.log(
          'Bob is reading a copy of your project to work out how to build and run it. Your own folder is not touched.',
        );
      } else {
        ctx.log(
          "Bob isn't set up yet, so Bob Deploy is using its built-in checks. Add your Bob key in Settings to have Bob review every deploy.",
        );
      }

      let staging: Awaited<ReturnType<typeof createStaging>> | undefined;
      let detected: DetectStackOutput;
      try {
        staging = await createStaging(project.folderPath, `${deps.dataDir}/staging/${ctx.projectId}-analyse`);
        const outcome = await detectStackStep.run({
          projectDir: staging.dir,
          ...(askBob ? { agentRunner: deps.agentRunner, alwaysAskBob: true } : {}),
          onAgentEvent: (event) => forwardBobEvent(ctx, event),
        });
        if (!outcome.ok) ctx.fail(outcome.code, outcome.message);
        detected = outcome.data;
      } finally {
        if (staging) await removeStaging(staging);
      }

      const { stack } = detected;
      if (detected.bobError) {
        ctx.log(
          `Bob couldn't finish his review (${detected.bobError}), so the built-in result is used instead.`,
        );
      }
      const who = detected.usedBob && !detected.bobError ? "Bob's conclusion" : 'Built-in check';
      ctx.log(`${who}: this is ${describeStack(stack)}.`, {
        stack,
        usedBob: detected.usedBob && !detected.bobError,
      });

      deps.projectsRepo.setStack(ctx.projectId, stack);
      ctx.shared[SHARED_STACK_KEY] = stack;
    },
  };
}

/** The stack the analyse step stored, if this job ran one (jobs created before DEC-021 did not). */
export function sharedStack(ctx: StepContext): StackInfo | undefined {
  const value = ctx.shared[SHARED_STACK_KEY];
  return value && typeof value === 'object' && typeof (value as StackInfo).type === 'string'
    ? (value as StackInfo)
    : undefined;
}
