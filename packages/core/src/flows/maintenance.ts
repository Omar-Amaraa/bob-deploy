import type { JobKind, MaintenanceActionId } from '@bob-deploy/contracts';
import {
  HELPER_SCRIPTS,
  runScript,
  mapBdErrorCode,
  cleanupOldReleases,
  nodeHttpProbe,
  type GeneratedScript,
  type HttpProbe,
  type RemoteExec,
} from '@bob-deploy/ssh-playbooks';
import type { JobDef, StepContext, StepDef } from '../jobs/types.js';
import type { ProjectsRepo } from '../db/repos/projects.js';
import type { TargetsRepo } from '../db/repos/targets.js';
import type { ReleasesRepo } from '../db/repos/releases.js';
import type { VaultLike } from './vault.js';
import { CoreReleaseStore } from './release-store.js';
import { reconnectAsAdmin } from './ssh-helpers.js';
import { realClock } from '@bob-deploy/ssh-playbooks';

function scriptByName(name: string): GeneratedScript {
  const found = HELPER_SCRIPTS.find((s) => s.name === name);
  if (!found) throw new Error(`No generated helper script named "${name}" (this is a bug).`);
  return found;
}

export interface MaintenanceInputs {
  actionId: MaintenanceActionId;
}

export interface MaintenanceDeps {
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
  /** Best-effort re-check after an action completes, so maintenance:list reflects the new state
   * without waiting for the next poll interval. Wired to MonitorService.runNow(projectId,
   * 'maintenance') by registerIpc; a no-op default keeps this flow independently testable. */
  runMaintenanceCheck?: (projectId: string) => Promise<void>;
  /** How long to wait for SSH to come back after bd-reboot, and how often to retry. Overridable
   * only for tests — production always uses the real (long) defaults. */
  rebootPollMs?: number;
  rebootTimeoutMs?: number;
}

const DEFAULT_REBOOT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_REBOOT_POLL_MS = 5000;

export function buildMaintenanceJobDef(deps: MaintenanceDeps): JobDef {
  const kind: JobKind = 'maintenance';
  const connectAsAdmin = deps.connectAsAdmin ?? ((target) => reconnectAsAdmin(deps.vault, deps.redact, target));
  const httpProbe = deps.httpProbe ?? nodeHttpProbe;
  const runMaintenanceCheck = deps.runMaintenanceCheck ?? (() => Promise.resolve());

  const maintenanceStep: StepDef = {
    key: 'maintenance',
    name: 'Run maintenance',
    kind: 'script',
    idempotent: true,
    async run(ctx: StepContext): Promise<void> {
      const { actionId } = ctx.inputs as MaintenanceInputs;
      const target = deps.targetsRepo.getByProjectId(ctx.projectId);
      if (!target) ctx.fail('NOT_FOUND', 'This project has no deployed target.');
      if (target.kind !== 'own_server') {
        ctx.fail('HOST_UNSUPPORTED', 'Maintenance actions are only available for your own server.');
      }

      const session = await connectAsAdmin(target);
      try {
        switch (actionId) {
          case 'apply_security_updates': {
            const result = await runScript(session, scriptByName('bd-security-upgrade'), [], { sudo: true });
            if (!result.outcome.ok) {
              ctx.fail(mapBdErrorCode(result.outcome.code), result.outcome.message);
            }
            ctx.log('Security updates applied.', { rebootRequired: result.outcome.data.rebootRequired });
            break;
          }
          case 'clean_old_releases': {
            const releaseStore = new CoreReleaseStore(deps.releasesRepo, ctx.projectId, target.id, realClock);
            const live = deps.releasesRepo.getLive(ctx.projectId);
            if (!live) {
              ctx.fail('NOT_FOUND', 'No live release to keep while cleaning up old ones.');
            }
            await cleanupOldReleases(session, target.appName ?? '', releaseStore, live.releaseId, 3);
            ctx.log('Old releases cleaned up.');
            break;
          }
          case 'renew_certificate': {
            const ports = deps.targetsRepo.getPorts(target.id);
            const live = deps.releasesRepo.getLive(ctx.projectId);
            const port = live?.port ?? ports?.portA;
            if (!ports || port === undefined) {
              ctx.fail('INTERNAL', 'This server target has no allocated ports on record.');
            }
            // Caddy renews certificates automatically; re-applying the site config just forces a
            // reload, which is a cheap and safe way to force a re-check / recovery from a stuck cert.
            const result = await runScript(
              session,
              scriptByName('bd-caddy-site'),
              [target.appName ?? '', target.domain ?? '', String(port), ports.tlsMode],
              { sudo: true },
            );
            if (!result.outcome.ok) {
              ctx.fail(mapBdErrorCode(result.outcome.code), result.outcome.message);
            }
            ctx.log('Certificate configuration reapplied and reloaded.');
            break;
          }
          case 'clean_disk': {
            const result = await runScript(session, scriptByName('bd-clean-disk'), [], { sudo: true });
            if (!result.outcome.ok) {
              ctx.fail(mapBdErrorCode(result.outcome.code), result.outcome.message);
            }
            ctx.log('Disk cleaned up.', { freedApproxMb: result.outcome.data.freedApproxMb });
            break;
          }
          case 'reboot_server': {
            const proceed = await ctx.ask({
              kind: 'confirm',
              title: 'Reboot the server?',
              body: 'Your site will be offline for about a minute while the server restarts.',
            });
            if (!proceed) ctx.fail('CANCELLED', 'Reboot cancelled.');

            const result = await runScript(session, scriptByName('bd-reboot'), [], { sudo: true });
            if (!result.outcome.ok) {
              ctx.fail(mapBdErrorCode(result.outcome.code), result.outcome.message);
            }
            session.close();
            ctx.log('Reboot scheduled; waiting for the server to come back...');

            const pollMs = deps.rebootPollMs ?? DEFAULT_REBOOT_POLL_MS;
            const timeoutMs = deps.rebootTimeoutMs ?? DEFAULT_REBOOT_TIMEOUT_MS;
            const deadline = Date.now() + timeoutMs;
            let backUp = false;
            while (Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, pollMs));
              try {
                const probe = await connectAsAdmin(target);
                probe.close();
                backUp = true;
                break;
              } catch {
                // still rebooting; keep polling until the deadline
              }
            }
            if (!backUp) {
              ctx.fail('SSH_TIMEOUT', 'The server did not come back within 5 minutes after rebooting.');
            }
            ctx.log('The server is back up.');

            if (target.siteUrl) {
              const healthy = await httpProbe.probe(target.siteUrl, 10000);
              if (!healthy.ok) {
                ctx.fail('HEALTHCHECK_FAILED', 'The server rebooted, but the site is not answering yet.');
              }
            }
            ctx.log('Health check passed after reboot.');
            // session already closed above; nothing left to close in the finally block.
            await runMaintenanceCheck(ctx.projectId);
            return;
          }
        }
      } finally {
        if (actionId !== 'reboot_server') session.close();
      }
      await runMaintenanceCheck(ctx.projectId);
    },
  };

  return { kind, build: () => [maintenanceStep] };
}
