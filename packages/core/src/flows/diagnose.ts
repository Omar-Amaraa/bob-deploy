import type { AgentRunner, AgentTask, HostId, HostProvider, JobKind } from '@bob-deploy/contracts';
import { HELPER_SCRIPTS, runScript, type GeneratedScript, type HttpProbe, type RemoteExec } from '@bob-deploy/ssh-playbooks';
import { diagnosisSchema } from '@bob-deploy/agent';
import type { JobDef, StepContext, StepDef } from '../jobs/types.js';
import type { ProjectsRepo } from '../db/repos/projects.js';
import type { TargetsRepo } from '../db/repos/targets.js';
import type { ReleasesRepo } from '../db/repos/releases.js';
import type { SnapshotsRepo } from '../db/repos/snapshots.js';
import type { JobsRepo } from '../db/repos/jobs.js';
import type { ProblemsRepo } from '../db/repos/problems.js';
import type { VaultLike } from './vault.js';
import type { RedactorLike } from './build.js';
import { reconnectAsAdmin } from './ssh-helpers.js';
import { buildUpdateJobDef } from './update.js';
import { buildRollbackJobDef } from './rollback.js';
import { forwardBobEvent } from './analyse.js';

function scriptByName(name: string): GeneratedScript {
  const found = HELPER_SCRIPTS.find((s) => s.name === name);
  if (!found) throw new Error(`No generated helper script named "${name}" (this is a bug).`);
  return found;
}

export interface DiagnoseInputs {
  note: string;
}

export interface DiagnoseDeps {
  projectsRepo: ProjectsRepo;
  targetsRepo: TargetsRepo;
  releasesRepo: ReleasesRepo;
  snapshotsRepo: SnapshotsRepo;
  jobsRepo: JobsRepo;
  problemsRepo: ProblemsRepo;
  vault: VaultLike;
  redactor: RedactorLike;
  redact: (s: string) => string;
  agentRunner: AgentRunner;
  dataDir: string;
  providers: Record<HostId, HostProvider>;
  httpProbe?: HttpProbe;
  connectAsAdmin?: (target: {
    ip?: string;
    sshPort?: number;
    adminUser?: string;
    hostKeyFingerprint?: string;
    id: string;
  }) => Promise<RemoteExec & { close(): void }>;
}

const DIAGNOSE_MAX_TURNS = 10;
const DIAGNOSE_TIMEOUT_MS = 300_000;

async function readTail(
  session: RemoteExec,
  scriptName: string,
  args: readonly string[],
): Promise<string> {
  const result = await runScript(session, scriptByName(scriptName), args, { sudo: true });
  if (!result.outcome.ok) return '';
  const content = result.outcome.data.content;
  if (!content) return '';
  try {
    return Buffer.from(content, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * problem:signal: gathers the project's recent job history (and, for an own-server target, the
 * systemd journal and app log tails), asks Bob to diagnose it, surfaces a plain-language message,
 * and — depending on what Bob proposes — offers to run a fix-and-update, a rollback, or just
 * points at a maintenance action, all *inline* in this same job/step rather than spawning a
 * separate one (the brief's "run the update/rollback flow inline"): update.ts and rollback.ts's
 * steps don't read anything project-specific from ctx.inputs (env comes from the vault, the target
 * from targetsRepo), so calling their StepDef.run() directly against this diagnose step's own ctx
 * works unmodified. The one exception is fixInstructions, threaded through ctx.state (see build.ts).
 */
export function buildDiagnoseJobDef(deps: DiagnoseDeps): JobDef {
  const kind: JobKind = 'diagnose';
  const connectAsAdmin = deps.connectAsAdmin ?? ((target) => reconnectAsAdmin(deps.vault, deps.redact, target));

  const diagnoseStep: StepDef = {
    key: 'diagnose',
    name: 'Diagnose the problem',
    kind: 'agent',
    idempotent: true,
    async run(ctx: StepContext): Promise<void> {
      const { note } = ctx.inputs as DiagnoseInputs;
      const problem = deps.problemsRepo.create({ projectId: ctx.projectId, note, jobId: ctx.jobId });

      const target = deps.targetsRepo.getByProjectId(ctx.projectId);

      const recentJob = deps.jobsRepo.listForProject(ctx.projectId).find((j) => j.id !== ctx.jobId);
      const jobEvents = recentJob ? deps.jobsRepo.listEvents(recentJob.id).slice(-200) : [];

      let journalTail = '';
      let accessLogTail = '';
      if (target && target.kind === 'own_server') {
        const session = await connectAsAdmin(target);
        try {
          const live = deps.releasesRepo.getLive(ctx.projectId);
          const ports = deps.targetsRepo.getPorts(target.id);
          const port = live?.port ?? ports?.portA;
          if (port !== undefined) {
            journalTail = await readTail(session, 'bd-read-journal', [target.appName ?? '', String(port), '300']);
          }
          accessLogTail = await readTail(session, 'bd-read-log', [target.appName ?? '', '200']);
        } finally {
          session.close();
        }
      }

      const task: AgentTask = {
        kind: 'diagnose',
        cwd: deps.dataDir,
        instructions: '',
        context: {
          hints: {
            userNote: deps.redactor.redact(note),
            jobEvents,
            journalTail: deps.redactor.redact(journalTail),
            accessLogTail: deps.redactor.redact(accessLogTail),
          },
        },
        allowedCommands: [],
        maxTurns: DIAGNOSE_MAX_TURNS,
        timeoutMs: DIAGNOSE_TIMEOUT_MS,
      };

      let diagnosisData: unknown;
      for await (const event of deps.agentRunner.run(task)) {
        forwardBobEvent(ctx, event);
        if (event.type === 'result') diagnosisData = event.data;
      }

      const parsed = diagnosisSchema.safeParse(diagnosisData);
      if (!parsed.success) {
        ctx.fail('BOB_BAD_OUTPUT', "Bob couldn't produce a diagnosis in the expected format.");
      }
      const diagnosis = parsed.data;
      ctx.log(diagnosis.userMessage, { proposedAction: diagnosis.proposedAction });

      switch (diagnosis.proposedAction) {
        case 'update_with_fix': {
          const proceed = await ctx.ask({
            kind: 'confirm',
            title: 'Bob suggests a fix',
            body: `Bob suggests a fix: ${diagnosis.summary}. Apply it and release a new version?`,
          });
          if (!proceed) return;
          if (diagnosis.fixInstructions) ctx.state.fixInstructions = diagnosis.fixInstructions;
          const updateStep = buildUpdateJobDef({
            projectsRepo: deps.projectsRepo,
            targetsRepo: deps.targetsRepo,
            releasesRepo: deps.releasesRepo,
            snapshotsRepo: deps.snapshotsRepo,
            vault: deps.vault,
            redactor: deps.redactor,
            agentRunner: deps.agentRunner,
            dataDir: deps.dataDir,
            redact: deps.redact,
            providers: deps.providers,
            httpProbe: deps.httpProbe,
            connectAsAdmin,
          })
            .build({})
            .find((step) => step.key === 'update');
          // The update job now starts with Bob's analyse step (DEC-021); the fix path runs only the
          // update step itself, which detects the stack on its own when no analyse step ran.
          if (!updateStep) ctx.fail('INTERNAL', 'The update step is missing.');
          await updateStep.run(ctx);
          deps.problemsRepo.resolve(problem.id);
          return;
        }
        case 'rollback': {
          const proceed = await ctx.ask({
            kind: 'confirm',
            title: 'Roll back?',
            body: `Bob suggests rolling back: ${diagnosis.summary}. Roll back to the previous release?`,
          });
          if (!proceed) return;
          const [rollbackStep] = buildRollbackJobDef({
            projectsRepo: deps.projectsRepo,
            targetsRepo: deps.targetsRepo,
            releasesRepo: deps.releasesRepo,
            vault: deps.vault,
            redact: deps.redact,
            httpProbe: deps.httpProbe,
            connectAsAdmin,
          }).build({});
          await rollbackStep!.run(ctx);
          deps.problemsRepo.resolve(problem.id);
          return;
        }
        case 'maintenance':
        case 'none':
        default:
          // Nothing to run automatically; the userMessage (already logged above) is the whole
          // outcome — maintenance:list already surfaces the matching action for the user to run.
          return;
      }
    },
  };

  return { kind, build: () => [diagnoseStep] };
}
