import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunner, HostId, HostProvider, JobKind } from '@bob-deploy/contracts';
import { createStaging, removeStaging } from '@bob-deploy/agent';
import {
  detectStackStep,
  nodeHttpProbe,
  packageRelease,
  releaseProcedure,
  realClock,
  type HttpProbe,
  type RemoteExec,
} from '@bob-deploy/ssh-playbooks';
import type { JobDef, StepContext, StepDef } from '../jobs/types.js';
import { buildAnalyseStep, forwardBobEvent, sharedStack } from './analyse.js';
import type { ProjectsRepo } from '../db/repos/projects.js';
import type { TargetsRepo } from '../db/repos/targets.js';
import type { ReleasesRepo } from '../db/repos/releases.js';
import type { SnapshotsRepo } from '../db/repos/snapshots.js';
import { projectEnvSecretKey, SECRET_NETLIFY_TOKEN, SECRET_VERCEL_TOKEN } from '../account/secret-keys.js';
import type { VaultLike } from './vault.js';
import { CoreReleaseStore } from './release-store.js';
import { buildWithFixes, type RedactorLike } from './build.js';
import { reconnectAsAdmin, packageKindFor } from './ssh-helpers.js';
import { takeSnapshot } from '../snapshots/snapshot.js';

export interface UpdateDeps {
  projectsRepo: ProjectsRepo;
  targetsRepo: TargetsRepo;
  releasesRepo: ReleasesRepo;
  snapshotsRepo: SnapshotsRepo;
  vault: VaultLike;
  redactor: RedactorLike;
  agentRunner: AgentRunner;
  dataDir: string;
  redact: (s: string) => string;
  /** Whether Bob is set up; when true the analyse step has Bob review every project (DEC-021). */
  askBob?: () => boolean;
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

function readEnv(vault: VaultLike, projectId: string): Record<string, string> {
  const raw = vault.getSecret(projectEnvSecretKey(projectId));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export function buildUpdateJobDef(deps: UpdateDeps): JobDef {
  const kind: JobKind = 'update';
  const connectAsAdmin = deps.connectAsAdmin ?? ((target) => reconnectAsAdmin(deps.vault, deps.redact, target));
  const httpProbe = deps.httpProbe ?? nodeHttpProbe;

  const updateStep: StepDef = {
    key: 'update',
    name: 'Update your live release',
    kind: 'script',
    idempotent: true,
    async run(ctx: StepContext): Promise<void> {
      const project = deps.projectsRepo.get(ctx.projectId);
      if (!project) ctx.fail('NOT_FOUND', 'Project not found.');
      const target = deps.targetsRepo.getByProjectId(ctx.projectId);
      if (!target) ctx.fail('NOT_FOUND', 'This project has not been deployed yet — deploy it first.');

      await takeSnapshot({
        projectId: ctx.projectId,
        projectDir: project.folderPath,
        dataDir: deps.dataDir,
        reason: 'before update',
        snapshotsRepo: deps.snapshotsRepo,
        clock: realClock,
      });

      let staging: Awaited<ReturnType<typeof createStaging>> | undefined;
      let hashTarDir: string | undefined;
      try {
        staging = await createStaging(project.folderPath, `${deps.dataDir}/staging/${ctx.projectId}`);

        // The analyse step already had Bob decide the stack (DEC-021); detect again only for jobs
        // created before that step existed and resumed after an upgrade.
        let stack = sharedStack(ctx);
        if (!stack) {
          const detected = await detectStackStep.run({
            projectDir: staging.dir,
            agentRunner: deps.agentRunner,
            onAgentEvent: (event) => forwardBobEvent(ctx, event),
          });
          if (!detected.ok) ctx.fail(detected.code, detected.message);
          stack = detected.data.stack;
          deps.projectsRepo.setStack(ctx.projectId, stack);
        }

        // Static sites with a build step (Vite, CRA, Astro, Next export...) must be built too:
        // otherwise the source folder is uploaded instead of the built output and the page is blank.
        if (stack.type !== 'static' || stack.buildCmd) {
          const build = await buildWithFixes({
            ctx,
            staging,
            projectDir: project.folderPath,
            projectId: ctx.projectId,
            dataDir: deps.dataDir,
            stack,
            runner: deps.agentRunner,
            redactor: deps.redactor,
            snapshotsRepo: deps.snapshotsRepo,
            clock: realClock,
          });
          if (!build.ok) {
            ctx.fail(
              'BUILD_FAILED',
              'Bob could not fix the build after 3 tries, so your live site was not changed.',
            );
          }
        }

        // Compare against the currently-live release's folderHash before doing anything
        // irreversible — if the built output is byte-identical to what's already live, releasing
        // again is (almost certainly) pointless, so confirm before wasting a deploy cycle on it.
        // Only a static site is served from its build output folder; node/python releases need the
        // whole project (package.json, requirements.txt...) to install and start on the server.
        const sourceDir =
          stack.type === 'static' && stack.outputDir ? join(staging.dir, stack.outputDir) : staging.dir;
        const liveRelease = deps.releasesRepo.getLive(ctx.projectId);
        if (liveRelease) {
          hashTarDir = await mkdtemp(join(tmpdir(), 'bd-update-hash-'));
          const { folderHash } = await packageRelease(sourceDir, packageKindFor(stack.type), join(hashTarDir, 'x.tar.gz'));
          if (folderHash === liveRelease.folderHash) {
            const again = await ctx.ask({
              kind: 'confirm',
              title: 'Nothing changed',
              body: 'Nothing changed since the last release. Release again anyway?',
            });
            if (!again) ctx.fail('CANCELLED', 'Update cancelled — nothing had changed.');
          }
        }

        const env = readEnv(deps.vault, ctx.projectId);

        if (target.kind === 'own_server') {
          const ports = deps.targetsRepo.getPorts(target.id);
          if (!ports) ctx.fail('INTERNAL', 'This server target has no allocated ports on record.');
          const session = await connectAsAdmin(target);
          try {
            const releaseStore = new CoreReleaseStore(deps.releasesRepo, ctx.projectId, target.id, realClock);
            const result = await releaseProcedure({
              session,
              app: target.appName ?? '',
              domain: target.domain ?? '',
              stack,
              kind: packageKindFor(stack.type),
              sourceDir,
              portA: ports.portA,
              portB: ports.portB,
              currentLivePort: liveRelease?.port,
              env,
              tlsMode: ports.tlsMode,
              releaseStore,
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
            ctx.log(`Updated successfully: https://${target.domain}`);
          } finally {
            session.close();
          }
        } else {
          const provider = deps.providers[target.kind];
          if (!provider) ctx.fail('HOST_UNSUPPORTED', `${target.kind} is not a supported host.`);
          const token = deps.vault.getSecret(target.kind === 'netlify' ? SECRET_NETLIFY_TOKEN : SECRET_VERCEL_TOKEN);
          if (!token) ctx.fail('HOST_AUTH_FAILED', `Connect your ${provider.displayName} account first.`);

          let siteUrl: string | undefined;
          for await (const event of provider.deploy(
            {
              projectDir: staging.dir,
              outputDir: stack.outputDir ? sourceDir : undefined,
              token,
              siteName: target.appName ?? 'app',
              siteId: target.siteId,
              stack,
              env,
            },
            ctx.signal,
          )) {
            ctx.log(event.message, { phase: event.phase });
            if (event.phase === 'error') ctx.fail('HOST_API_ERROR', event.message);
            if (event.phase === 'ready') siteUrl = event.url;
          }
          if (!siteUrl) ctx.fail('HOST_API_ERROR', `${provider.displayName} did not report a live site URL.`);
          deps.targetsRepo.setSiteUrl(target.id, siteUrl);
          ctx.log(`Updated successfully: ${siteUrl}`);
        }

        deps.projectsRepo.setStatus(ctx.projectId, 'live');
      } finally {
        if (staging) await removeStaging(staging).catch(() => undefined);
        if (hashTarDir) await rm(hashTarDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };

  return { kind, build: () => [buildAnalyseStep(deps), updateStep] };
}
