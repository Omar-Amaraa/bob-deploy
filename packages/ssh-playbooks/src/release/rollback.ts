import type { Clock } from '@bob-deploy/contracts';
import type { RemoteExec } from '../ssh/types.js';
import { HELPER_SCRIPTS, type GeneratedScript } from '../generated/scripts.js';
import { runScript } from '../playbook/run-script.js';
import { mapBdErrorCode } from '../playbook/error-mapping.js';
import { stepFail, stepOk, type PlaybookStepOutcome } from '../playbook/types.js';
import type { TlsMode } from './proxy-and-https.js';
import type { HttpProbe } from './http-probe.js';
import type { ReleaseStore } from './types.js';
import { appDirFor, bindReleaseToPort, privateHealthCheck, publicCheck, realClock, stopInstance } from './release.js';

function scriptByName(name: string): GeneratedScript {
  const found = HELPER_SCRIPTS.find((s) => s.name === name);
  if (!found) throw new Error(`No generated helper script named "${name}" (this is a bug).`);
  return found;
}

export interface RollbackInput {
  session: RemoteExec;
  app: string;
  domain: string;
  /** Static apps have no process to restart/health-check; only the symlink is swapped. */
  isStatic: boolean;
  healthPath?: string;
  /** The two ports allocated for this app in proxy_and_https. Ignored for static apps. */
  portA: number;
  portB: number;
  currentLivePort?: number;
  tlsMode: TlsMode;
  releaseStore: ReleaseStore;
  /** The release to roll back to. Defaults to the newest 'previous' release still on disk. */
  releaseId?: string;
  httpProbe?: HttpProbe;
  clock?: Clock;
  healthCheckTries?: number;
  healthCheckIntervalMs?: number;
  publicCheckTries?: number;
  publicCheckIntervalMs?: number;
}

export interface RollbackOutput {
  releaseId: string;
  status: 'live' | 'rolled_back';
  livePort?: number;
  message: string;
}

async function releaseStillOnDisk(session: RemoteExec, app: string, releaseId: string): Promise<boolean> {
  const result = await session.exec(`test -d '${appDirFor(app)}/releases/${releaseId}'`);
  return result.code === 0;
}

/**
 * rollbackTo (brief's ROLLBACK): reuses steps h-l of the release procedure against an *existing*
 * release (its .bd-start and dependencies are already on disk from when it was first deployed) —
 * no Bob call, no build, no packaging. Defaults to the newest 'previous' release still present on
 * disk when no releaseId is given.
 */
export async function rollbackTo(input: RollbackInput): Promise<PlaybookStepOutcome<RollbackOutput>> {
  const clock = input.clock ?? realClock;
  const healthPath = input.healthPath ?? '/';

  let targetId = input.releaseId;
  if (!targetId) {
    const all = await input.releaseStore.listReleases(input.app);
    const candidates = all.filter((r) => r.status === 'previous').sort((a, b) => b.id.localeCompare(a.id));
    for (const candidate of candidates) {
      if (await releaseStillOnDisk(input.session, input.app, candidate.id)) {
        targetId = candidate.id;
        break;
      }
    }
  }
  if (!targetId) {
    return stepFail('BUILD_FAILED', 'No previous release is available to roll back to.');
  }
  if (!(await releaseStillOnDisk(input.session, input.app, targetId))) {
    return stepFail('BUILD_FAILED', `Release ${targetId} is no longer available on disk.`);
  }

  if (input.isStatic) {
    const swap = await input.session.exec(
      `cd '${appDirFor(input.app)}' && ln -sfn 'releases/${targetId}' current.tmp && mv -Tf current.tmp current`,
    );
    if (swap.code !== 0) {
      return stepFail('BUILD_FAILED', `Failed to switch the static site back to ${targetId}: ${swap.stderr || swap.stdout}`);
    }
    await input.releaseStore.updateReleaseStatus(input.app, targetId, 'live');
    return stepOk({ releaseId: targetId, status: 'live', message: `Rolled back to release ${targetId}.` });
  }

  // h
  const newPort = input.currentLivePort === input.portA ? input.portB : input.portA;
  const bindErr = await bindReleaseToPort(input.session, input.app, newPort, targetId);
  if (bindErr) return stepFail('BUILD_FAILED', bindErr);
  const start = await runScript(input.session, scriptByName('bd-service'), [input.app, String(newPort), 'restart'], { sudo: true });
  if (!start.outcome.ok) {
    return stepFail(mapBdErrorCode(start.outcome.code), start.outcome.message, { stderr: start.exec.stderr });
  }

  // i
  const healthy = await privateHealthCheck(
    input.session,
    newPort,
    healthPath,
    input.healthCheckTries ?? 30,
    input.healthCheckIntervalMs ?? 2000,
    clock,
  );
  if (!healthy) {
    await stopInstance(input.session, input.app, newPort);
    return stepOk({
      releaseId: targetId,
      status: 'rolled_back',
      message: `Release ${targetId} did not start correctly either; the site stays on whatever was running before this rollback was attempted.`,
    });
  }

  // j
  const site = await runScript(input.session, scriptByName('bd-caddy-site'), [input.app, input.domain, String(newPort), input.tlsMode], {
    sudo: true,
  });
  if (!site.outcome.ok) {
    await stopInstance(input.session, input.app, newPort);
    return stepFail(mapBdErrorCode(site.outcome.code), site.outcome.message, { stderr: site.exec.stderr });
  }
  const swap = await input.session.exec(
    `cd '${appDirFor(input.app)}' && ln -sfn 'releases/${targetId}' current.tmp && mv -Tf current.tmp current`,
  );
  if (swap.code !== 0) {
    await stopInstance(input.session, input.app, newPort);
    return stepFail('BUILD_FAILED', `Failed to switch the "current" symlink: ${swap.stderr || swap.stdout}`);
  }

  // k
  const publiclyHealthy = await publicCheck(
    input.httpProbe,
    input.domain,
    healthPath,
    input.publicCheckTries ?? 10,
    input.publicCheckIntervalMs ?? 3000,
    clock,
  );
  if (!publiclyHealthy) {
    await stopInstance(input.session, input.app, newPort);
    return stepOk({
      releaseId: targetId,
      status: 'rolled_back',
      message: `Release ${targetId} did not answer correctly over HTTPS either.`,
    });
  }

  // l
  if (typeof input.currentLivePort === 'number') {
    await stopInstance(input.session, input.app, input.currentLivePort);
  }
  await input.releaseStore.updateReleaseStatus(input.app, targetId, 'live');

  return stepOk({ releaseId: targetId, status: 'live', livePort: newPort, message: `Rolled back to release ${targetId}.` });
}
