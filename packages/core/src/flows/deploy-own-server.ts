import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { AgentRunner, JobKind, OwnServerInputs } from '@bob-deploy/contracts';
import { slugifyAppName } from '@bob-deploy/contracts';
import { createStaging, removeStaging } from '@bob-deploy/agent';
import {
  reachServerStep,
  checkDnsStep,
  createAdminStep,
  lockDownStep,
  firewallAndPatchesStep,
  nodeDnsResolver,
  detectStackStep,
  installRuntimeStep,
  proxyAndHttpsStep,
  releaseProcedure,
  realClock,
  nodeHttpProbe,
  type RemoteExec,
  type ReachServerInput,
  type ReachServerOutput,
  type LockDownInput,
  type LockDownOutput,
  type PlaybookStepOutcome,
  type DnsResolver,
  type HttpProbe,
} from '@bob-deploy/ssh-playbooks';
import type { JobDef, StepContext, StepDef } from '../jobs/types.js';
import { buildAnalyseStep, forwardBobEvent, sharedStack } from './analyse.js';
import type { ProjectsRepo } from '../db/repos/projects.js';
import type { TargetsRepo } from '../db/repos/targets.js';
import type { ReleasesRepo } from '../db/repos/releases.js';
import type { SnapshotsRepo } from '../db/repos/snapshots.js';
import { generateAdminKey, storeTargetKey } from '../security/sshkey.js';
import { projectEnvSecretKey } from '../account/secret-keys.js';
import { JOB_SECRET_ENV_JSON, JOB_SECRET_ROOT_KEY_PASSPHRASE, JOB_SECRET_ROOT_PASSWORD } from '../jobs/job-secret-keys.js';
import type { VaultLike } from './vault.js';
import { CoreReleaseStore } from './release-store.js';
import { buildWithFixes, type RedactorLike } from './build.js';
import { reconnectAsAdmin, packageKindFor } from './ssh-helpers.js';

export interface DeployOwnServerDeps {
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
  /** Test seams: real reachServerStep.run / lockDownStep.run / a connectSsh-based reconnect by
   * default. Both real functions dial a live SSH connection (ssh-playbooks exposes no way to
   * inject a fake transport into them), so unit tests substitute these instead of touching ssh2. */
  reachServer?: (input: ReachServerInput) => Promise<PlaybookStepOutcome<ReachServerOutput>>;
  lockDown?: (input: LockDownInput) => Promise<PlaybookStepOutcome<LockDownOutput>>;
  connectAsAdmin?: (target: {
    ip?: string;
    sshPort?: number;
    adminUser?: string;
    hostKeyFingerprint?: string;
    id: string;
  }) => Promise<RemoteExec & { close(): void }>;
  /** DNS is an external dependency too (CLAUDE.md); real lookups by default, a FakeDnsResolver in tests. */
  dns?: DnsResolver;
  /** Public HTTPS checks. nodeHttpProbe by default; create-core passes testbedHttpProbe in
   * BOB_DEPLOY_TESTBED mode (the testbed serves HTTPS on a mapped port, not 443). */
  httpProbe?: HttpProbe;
}

/** `*.bd.test` only exists in testbed mode (DEC-020): no public CA can issue a certificate for it,
 * so Caddy must use its own internal CA there. Every real domain gets a real (ACME) certificate. */
export function tlsModeForDomain(domain: string): 'auto' | 'internal' {
  return domain.endsWith('.bd.test') ? 'internal' : 'auto';
}

/** The server-side app user is `bd-<appName>` and Linux user names are at most 32 characters
 * (useradd refuses longer ones), so the app name gets 29 of them, suffix included. appSlugSchema
 * alone allows 31, which made bd-app-setup fail "Failed to create app user" on long names. */
export const APP_NAME_MAX_LENGTH = 29;

function capAppName(slug: string, maxLength: number): string {
  return slug.slice(0, maxLength).replace(/-+$/g, '') || 'app';
}

/** Picks a per-server-unique appName from the project's *name*: slugifyAppName's output capped to
 * APP_NAME_MAX_LENGTH, with a numeric suffix only if another project's target on the same server
 * (ip:port) already claims it. This project's own earlier target (a previous, failed attempt) does
 * not count, so a retry keeps the same name instead of drifting to "-2". */
export function uniqueAppName(
  targetsRepo: TargetsRepo,
  ip: string,
  sshPort: number,
  projectName: string,
  projectId: string,
): string {
  const base = capAppName(slugifyAppName(projectName), APP_NAME_MAX_LENGTH);
  const ownTargetId = targetsRepo.getByProjectId(projectId)?.id;
  const taken = new Set(
    targetsRepo
      .listByServer(ip, sshPort)
      .filter((t) => t.id !== ownTargetId)
      .map((t) => t.appName)
      .filter((n): n is string => Boolean(n)),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${capAppName(base, APP_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}


export function buildDeployOwnServerJobDef(deps: DeployOwnServerDeps): JobDef {
  const kind: JobKind = 'deploy_own_server';
  const reachServer = deps.reachServer ?? ((input) => reachServerStep.run(input));
  const lockDown = deps.lockDown ?? ((input) => lockDownStep.run(input));
  const connectAsAdmin = deps.connectAsAdmin ?? ((target) => reconnectAsAdmin(deps.vault, deps.redact, target));
  const dnsResolver = deps.dns ?? nodeDnsResolver();
  const httpProbe = deps.httpProbe ?? nodeHttpProbe;

  const bootstrapStep: StepDef = {
    key: 'bootstrap',
    name: 'Prepare the server',
    kind: 'script',
    idempotent: true,
    async run(ctx: StepContext): Promise<void> {
      // ctx.inputs is "parsed non-secret inputs" only — JobsRepo persists it verbatim to
      // jobs.inputs_json, so the root password/key-passphrase and the app's env vars never travel
      // through it. The deploy:start IPC handler strips them out and hands them over via ctx.secrets
      // instead (see jobs/job-secret-keys.ts).
      const inputs = ctx.inputs as OwnServerInputs;
      const rootAuth =
        inputs.rootAuth.method === 'password'
          ? { password: ctx.secrets.get(JOB_SECRET_ROOT_PASSWORD) ?? '' }
          : {
              privateKey: await readFile(inputs.rootAuth.privateKeyPath, 'utf8'),
              passphrase: ctx.secrets.get(JOB_SECRET_ROOT_KEY_PASSPHRASE),
            };

      const reach = await reachServer({
        host: inputs.serverIp,
        port: inputs.sshPort,
        rootUser: inputs.rootUser,
        auth: rootAuth,
        onUnknownHostKey: async (fingerprint) => {
          const answer = await ctx.ask({
            kind: 'confirm',
            title: 'Verify this server',
            body: `This is the first time connecting to ${inputs.serverIp}. Its key fingerprint is ${fingerprint}. Continue only if you recognize this server.`,
          });
          return answer === true;
        },
        redact: deps.redact,
      });
      if (!reach.ok) ctx.fail(reach.code, reach.message);
      const { session: rootSession, fingerprint, rootUser } = reach.data;
      ctx.log(`Connected to ${inputs.serverIp} as ${rootUser}.`);

      const dns = await checkDnsStep.run({
        domain: inputs.domain,
        serverIp: inputs.serverIp,
        dns: dnsResolver,
        useSslipFallback: inputs.useSslipFallback,
      });
      if (!dns.ok) {
        rootSession.close();
        ctx.fail(dns.code, dns.message);
      }
      const { domain } = dns.data;

      const adminKey = await generateAdminKey(`bob-deploy-${ctx.projectId}`);
      const rootSudo = rootUser !== 'root';

      const admin = await createAdminStep.run({
        session: rootSession,
        sudo: rootSudo,
        adminUser: inputs.adminUser,
        publicKey: adminKey.publicKeyOpenSsh,
      });
      if (!admin.ok) {
        rootSession.close();
        ctx.fail(admin.code, admin.message);
      }

      const lockDownResult = await lockDown({
        rootSession,
        rootSudo,
        adminUser: inputs.adminUser,
        host: inputs.serverIp,
        port: inputs.sshPort,
        adminAuth: { privateKey: adminKey.privateKeyOpenSsh, passphrase: adminKey.passphrase },
        redact: deps.redact,
      });
      rootSession.close();
      if (!lockDownResult.ok) ctx.fail(lockDownResult.code, lockDownResult.message);
      const { adminSession } = lockDownResult.data;
      ctx.log('The server is now hardened: root login disabled, a dedicated admin user created.');

      const firewall = await firewallAndPatchesStep.run({ session: adminSession, adminUser: inputs.adminUser });
      if (!firewall.ok) {
        adminSession.close();
        ctx.fail(firewall.code, firewall.message);
      }
      adminSession.close();

      // The project's name, not its id: the id is a UUID, which gave names like
      // "app-4262b446-2ce2-47f9-85c3-8d6" (and, with "bd-", a user name too long for Linux).
      const projectName = deps.projectsRepo.get(ctx.projectId)?.name ?? ctx.projectId;
      const appName = uniqueAppName(deps.targetsRepo, inputs.serverIp, inputs.sshPort, projectName, ctx.projectId);
      const target = deps.targetsRepo.upsert({
        projectId: ctx.projectId,
        kind: 'own_server',
        appName,
        domain,
        ip: inputs.serverIp,
        adminUser: inputs.adminUser,
        sshPort: inputs.sshPort,
        hostKeyFingerprint: fingerprint,
        tlsMode: tlsModeForDomain(domain),
      });
      storeTargetKey(deps.vault, target.id, adminKey);
      deps.vault.setSecret(projectEnvSecretKey(ctx.projectId), ctx.secrets.get(JOB_SECRET_ENV_JSON) ?? '{}');

      // Bootstrapping has fully succeeded and is not undone by anything downstream — recorded so
      // onFinalFailure can explain that the server stays hardened even if the release itself fails.
      ctx.shared.bootstrapped = true;
      ctx.shared.targetId = target.id;
      ctx.shared.domain = domain;
      ctx.shared.appName = appName;
    },
  };

  const releaseStep: StepDef = {
    key: 'release',
    name: 'Build and release your app',
    kind: 'script',
    idempotent: true,
    async run(ctx: StepContext): Promise<void> {
      const inputs = ctx.inputs as OwnServerInputs;
      const targetId = ctx.shared.targetId as string;
      const target = deps.targetsRepo.get(targetId);
      if (!target) ctx.fail('NOT_FOUND', 'The server target for this project could not be found.');
      const appName = ctx.shared.appName as string;
      const domain = ctx.shared.domain as string;

      const session = await connectAsAdmin(target);
      let staging: Awaited<ReturnType<typeof createStaging>> | undefined;
      try {
        const project = deps.projectsRepo.get(ctx.projectId);
        if (!project) ctx.fail('NOT_FOUND', 'Project not found.');
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

        const installed = await installRuntimeStep.run({
          session,
          stack,
          agentRunner: deps.agentRunner,
          projectDir: staging.dir,
          onAgentEvent: (event) => forwardBobEvent(ctx, event),
        });
        if (!installed.ok) ctx.fail(installed.code, installed.message);

        const proxy = await proxyAndHttpsStep.run({
          session,
          app: appName,
          adminUser: target.adminUser ?? inputs.adminUser,
          domain,
          stack,
          tlsMode: tlsModeForDomain(domain),
          httpProbe,
        });
        if (!proxy.ok) ctx.fail(proxy.code, proxy.message);
        const { portA, portB } = proxy.data;
        deps.targetsRepo.setPorts(target.id, portA, portB);

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
              'The server is ready, but Bob could not fix the build after 3 tries, so nothing has been deployed yet. Fix the build locally and try again.',
            );
          }
        }

        // Read env back from the vault (bootstrapStep already stored it there) rather than
        // ctx.inputs.env — this also makes the release step correct after a resume, where
        // ctx.secrets is reset to empty but the vault isn't.
        const envJson = deps.vault.getSecret(projectEnvSecretKey(ctx.projectId));
        const env = envJson ? (JSON.parse(envJson) as Record<string, string>) : {};

        const releaseStore = new CoreReleaseStore(deps.releasesRepo, ctx.projectId, target.id, realClock);
        const result = await releaseProcedure({
          session,
          app: appName,
          domain,
          stack,
          kind: packageKindFor(stack.type),
          sourceDir: stack.type === 'static' && stack.outputDir ? join(staging.dir, stack.outputDir) : staging.dir,
          portA,
          portB,
          env,
          tlsMode: tlsModeForDomain(domain),
          releaseStore,
          httpProbe,
        });
        if (!result.ok) ctx.fail(result.code, result.message);

        if (result.data.status === 'rolled_back') {
          ctx.fail(
            'HEALTHCHECK_FAILED',
            'The server was hardened and set up, but the first release did not pass its health checks, so nothing is live yet.',
          );
        }

        const release = deps.releasesRepo.getByReleaseId(ctx.projectId, result.data.releaseId);
        if (release && typeof result.data.livePort === 'number') {
          deps.releasesRepo.setPort(release.id, result.data.livePort);
        }
        deps.targetsRepo.setSiteUrl(target.id, `https://${domain}`);
        deps.projectsRepo.setStatus(ctx.projectId, 'live');
        ctx.log(`Deployed successfully: https://${domain}`);
      } finally {
        if (staging) await removeStaging(staging).catch(() => undefined);
        session.close();
      }
    },
  };

  return {
    kind,
    build: () => [buildAnalyseStep(deps), bootstrapStep, releaseStep],
    // no async work needed; the return type is Promise<...> to match JobDef's contract.
    // eslint-disable-next-line @typescript-eslint/require-await
    async onFinalFailure(): Promise<'failed' | 'rolled_back'> {
      // There is never a previous release to roll back to on a first deploy — failure just means
      // failure. If bootstrapping succeeded, the hardened server itself is left in place (nothing
      // downstream ever undoes it), which the release step's own failure message already explains.
      return 'failed';
    },
  };
}
