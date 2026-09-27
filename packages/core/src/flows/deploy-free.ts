import type { AgentRunner, FreeHostInputs, HostId, HostProvider, JobKind } from '@bob-deploy/contracts';
import { createStaging, removeStaging } from '@bob-deploy/agent';
import { detectStackStep, nodeHttpProbe, realClock, type HttpProbe } from '@bob-deploy/ssh-playbooks';
import type { JobDef, StepContext, StepDef } from '../jobs/types.js';
import { buildAnalyseStep, forwardBobEvent, sharedStack } from './analyse.js';
import type { ProjectsRepo } from '../db/repos/projects.js';
import type { TargetsRepo } from '../db/repos/targets.js';
import { SECRET_NETLIFY_TOKEN, SECRET_VERCEL_TOKEN, projectEnvSecretKey } from '../account/secret-keys.js';
import { JOB_SECRET_ENV_JSON } from '../jobs/job-secret-keys.js';
import type { VaultLike } from './vault.js';
import { buildWithFixes, type RedactorLike } from './build.js';
import { verifyPublishedFiles } from './verify-upload.js';
import type { SnapshotsRepo } from '../db/repos/snapshots.js';

export interface DeployFreeDeps {
  projectsRepo: ProjectsRepo;
  targetsRepo: TargetsRepo;
  snapshotsRepo: SnapshotsRepo;
  vault: VaultLike;
  redactor: RedactorLike;
  agentRunner: AgentRunner;
  dataDir: string;
  /** Whether Bob is set up; when true the analyse step has Bob review every project (DEC-021). */
  askBob?: () => boolean;
  /** Real Netlify/Vercel providers, keyed by HostId; packages/providers owns the real
   * implementations — tests substitute a FakeHostProvider instead (CLAUDE.md: every external
   * dependency behind an interface with a fake). */
  providers: Record<HostId, HostProvider>;
  httpProbe?: HttpProbe;
}

function tokenKeyFor(host: HostId): string {
  return host === 'netlify' ? SECRET_NETLIFY_TOKEN : SECRET_VERCEL_TOKEN;
}

export function buildDeployFreeJobDef(deps: DeployFreeDeps): JobDef {
  const kind: JobKind = 'deploy_free';
  const httpProbe = deps.httpProbe ?? nodeHttpProbe;

  const deployStep: StepDef = {
    key: 'deploy',
    name: 'Deploy to free hosting',
    kind: 'script',
    idempotent: true,
    async run(ctx: StepContext): Promise<void> {
      // ctx.inputs is "parsed non-secret inputs" only (persisted verbatim to jobs.inputs_json), so
      // the deploy:start IPC handler strips FreeHostInputs.env out and hands it over via
      // ctx.secrets instead — see jobs/job-secret-keys.ts.
      const inputs = ctx.inputs as FreeHostInputs;
      const envJson = ctx.secrets.get(JOB_SECRET_ENV_JSON) ?? '{}';
      const env = JSON.parse(envJson) as Record<string, string>;
      const project = deps.projectsRepo.get(ctx.projectId);
      if (!project) ctx.fail('NOT_FOUND', 'Project not found.');

      let staging: Awaited<ReturnType<typeof createStaging>> | undefined;
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
        ctx.log(`Deploying ${stack.framework ?? stack.type}.`, { outputDir: stack.outputDir ?? '.', buildCmd: stack.buildCmd });

        if (stack.needsBackend) {
          const answer = await ctx.ask({
            kind: 'choice',
            title: 'This app needs a server',
            body: 'Free hosting only serves static sites, and this project needs a backend to run.',
            options: [
              { id: 'own_server', label: 'Use my own server instead' },
              { id: 'cancel', label: 'Cancel' },
            ],
          });
          ctx.fail(
            'CANCELLED',
            answer === 'own_server'
              ? 'This app needs a server. Deploy it to your own server instead of free hosting.'
              : 'Deployment cancelled.',
          );
        }

        const provider = deps.providers[inputs.host];
        if (!provider) ctx.fail('HOST_UNSUPPORTED', `${inputs.host} is not a supported host.`);

        const support = provider.supports(stack);
        if (!support.ok) {
          ctx.fail('HOST_UNSUPPORTED', support.reason ?? `${provider.displayName} does not support this project.`);
        }

        const token = deps.vault.getSecret(tokenKeyFor(inputs.host));
        if (!token) {
          ctx.fail(
            'HOST_AUTH_FAILED',
            `Connect your ${provider.displayName} account first (visit ${provider.tokenPageUrl} to get a token).`,
          );
        }

        if (stack.installCmd || stack.buildCmd) {
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
              'Bob could not fix the build after 3 tries, so nothing has been deployed. Fix the build locally and try again.',
            );
          }
          const outputLabel = stack.outputDir && stack.outputDir !== '.' ? stack.outputDir : 'the project root';
          ctx.log(`Build output is ready in ${outputLabel}.`);
        }

        const existingTarget = deps.targetsRepo.getByProjectId(ctx.projectId);
        let siteUrl: string | undefined;
        let siteId: string | undefined;
        for await (const event of provider.deploy(
          {
            projectDir: staging.dir,
            outputDir: stack.outputDir ? `${staging.dir}/${stack.outputDir}` : undefined,
            token,
            siteName: inputs.siteName,
            siteId: existingTarget?.siteId,
            stack,
            env,
          },
          ctx.signal,
        )) {
          ctx.log(event.message, { phase: event.phase });
          if (event.phase === 'error') ctx.fail('HOST_API_ERROR', event.message);
          if (event.phase === 'ready') {
            siteUrl = event.url;
            siteId = event.siteId;
          }
        }
        if (!siteUrl || !siteId) ctx.fail('HOST_API_ERROR', `${provider.displayName} did not report a live site URL.`);

        deps.targetsRepo.upsert({ projectId: ctx.projectId, kind: inputs.host, siteUrl, siteId });
        // Stored so a later `update` job (which has no FreeHostInputs of its own) can read it back —
        // matches deploy_own_server's bootstrap step.
        deps.vault.setSecret(projectEnvSecretKey(ctx.projectId), envJson);

        const healthy = await httpProbe.probe(siteUrl, 10000);
        if (!healthy.ok) {
          ctx.fail(
            'HEALTHCHECK_FAILED',
            `${provider.displayName} reports the site as deployed, but it did not answer at ${siteUrl}.`,
          );
        }

        // A 200 on the home page is not enough: a host can publish index.html but silently drop
        // every file in a subfolder (JS, CSS, images), leaving a blank page that still "works".
        // Probe a sample of the real build output at the live URL before calling it a success.
        const publishedDir = stack.outputDir ? `${staging.dir}/${stack.outputDir}` : staging.dir;
        const upload = await verifyPublishedFiles(siteUrl, publishedDir, httpProbe);
        if (upload.missing.length > 0) {
          ctx.fail(
            'HEALTHCHECK_FAILED',
            `${provider.displayName} is serving the page at ${siteUrl}, but ${upload.missing.length} of ${upload.checked.length} built files checked are missing online (for example ${upload.missing[0]}), so the site would load blank. Your project built fine; deploy again, and if this keeps happening the upload to ${provider.displayName} is at fault.`,
          );
        }
        if (upload.checked.length > 0) {
          ctx.log(`Checked ${upload.checked.length} built files online; all are being served.`);
        }

        deps.projectsRepo.setStatus(ctx.projectId, 'live');
        ctx.log(`Deployed successfully: ${siteUrl}`);
      } finally {
        if (staging) await removeStaging(staging).catch(() => undefined);
      }
    },
  };

  return { kind, build: () => [buildAnalyseStep(deps), deployStep] };
}
