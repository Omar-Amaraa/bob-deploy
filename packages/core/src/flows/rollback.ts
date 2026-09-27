import type { JobKind } from '@bob-deploy/contracts';
import { rollbackTo, realClock, nodeHttpProbe, type HttpProbe, type RemoteExec } from '@bob-deploy/ssh-playbooks';
import type { JobDef, StepContext, StepDef } from '../jobs/types.js';
import type { ProjectsRepo } from '../db/repos/projects.js';
import type { TargetsRepo } from '../db/repos/targets.js';
import type { ReleasesRepo } from '../db/repos/releases.js';
import type { VaultLike } from './vault.js';
import { CoreReleaseStore } from './release-store.js';
import { reconnectAsAdmin } from './ssh-helpers.js';

/** Where the person manages a free-host site directly — rollback there isn't something Bob Deploy
 * can drive (no HostProvider exposes a rollback/history API), so this points them at the host's own
 * dashboard rather than silently failing with no next step. */
const FREE_HOST_DASHBOARD_URL: Record<string, string> = {
  netlify: 'https://app.netlify.com',
  vercel: 'https://vercel.com/dashboard',
};

export interface RollbackDeps {
  projectsRepo: ProjectsRepo;
  targetsRepo: TargetsRepo;
  releasesRepo: ReleasesRepo;
  vault: VaultLike;
  redact: (s: string) => string;
  httpProbe?: HttpProbe;
  connectAsAdmin?: (target: {
    ip?: string;
    sshPort?: number;
    adminUser?: string;
    hostKeyFingerprint?: string;
    id: string;
  }) => Promise<RemoteExec & { close(): void }>;
}

/** Rollback never touches an AgentRunner at all — matching ssh-playbooks' rollbackTo, which takes no
 * such parameter: it only swaps an already-built, already-on-disk release back into place. */
export function buildRollbackJobDef(deps: RollbackDeps): JobDef {
  const kind: JobKind = 'rollback';
  const connectAsAdmin = deps.connectAsAdmin ?? ((target) => reconnectAsAdmin(deps.vault, deps.redact, target));
  const httpProbe = deps.httpProbe ?? nodeHttpProbe;

  const rollbackStep: StepDef = {
    key: 'rollback',
    name: 'Roll back to a previous release',
    kind: 'script',
    idempotent: true,
    async run(ctx: StepContext): Promise<void> {
      const inputs = ctx.inputs as { releaseId?: string };
      const project = deps.projectsRepo.get(ctx.projectId);
      if (!project) ctx.fail('NOT_FOUND', 'Project not found.');
      const target = deps.targetsRepo.getByProjectId(ctx.projectId);
      if (!target) ctx.fail('NOT_FOUND', 'This project has not been deployed yet — deploy it first.');

      if (target.kind !== 'own_server') {
        const dashboardUrl = FREE_HOST_DASHBOARD_URL[target.kind] ?? '';
        ctx.fail(
          'HOST_UNSUPPORTED',
          `Rolling back isn't available for free hosts from here. Use your ${target.kind} dashboard to roll back${dashboardUrl ? `: ${dashboardUrl}` : '.'}`,
        );
      }

      const ports = deps.targetsRepo.getPorts(target.id);
      if (!ports) ctx.fail('INTERNAL', 'This server target has no allocated ports on record.');
      const liveRelease = deps.releasesRepo.getLive(ctx.projectId);

      const session = await connectAsAdmin(target);
      try {
        const releaseStore = new CoreReleaseStore(deps.releasesRepo, ctx.projectId, target.id, realClock);
        const result = await rollbackTo({
          session,
          app: target.appName ?? '',
          domain: target.domain ?? '',
          isStatic: project.stack?.type === 'static',
          portA: ports.portA,
          portB: ports.portB,
          currentLivePort: liveRelease?.port,
          tlsMode: ports.tlsMode,
          releaseStore,
          releaseId: inputs.releaseId,
          httpProbe,
        });
        if (!result.ok) ctx.fail(result.code, result.message);

        if (result.data.status === 'rolled_back') {
          ctx.fail('HEALTHCHECK_FAILED', result.data.message);
        }

        const release = deps.releasesRepo.getByReleaseId(ctx.projectId, result.data.releaseId);
        if (release && typeof result.data.livePort === 'number') {
          deps.releasesRepo.setPort(release.id, result.data.livePort);
        }
        // rollbackTo only promotes the target release to 'live' — it doesn't know about (or demote)
        // whatever release was 'live' before, so that's on the caller. Without this, two releases
        // could both be marked 'live' at once, which ReleasesRepo.getLive isn't equipped to resolve.
        if (liveRelease && liveRelease.releaseId !== result.data.releaseId) {
          deps.releasesRepo.setStatus(liveRelease.id, 'previous');
        }
        deps.projectsRepo.setStatus(ctx.projectId, 'live');
        ctx.log(result.data.message);
      } finally {
        session.close();
      }
    },
  };

  return { kind, build: () => [rollbackStep] };
}
