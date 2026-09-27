import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StackInfo, Clock } from '@bob-deploy/contracts';
import type { RemoteExec } from '../ssh/types.js';
import { HELPER_SCRIPTS, type GeneratedScript } from '../generated/scripts.js';
import { runScript } from '../playbook/run-script.js';
import { mapBdErrorCode } from '../playbook/error-mapping.js';
import { stepFail, stepOk, type PlaybookStep, type PlaybookStepOutcome } from '../playbook/types.js';
import { packageRelease, type PackageKind } from './package.js';
import type { TlsMode } from './proxy-and-https.js';
import type { HttpProbe } from './http-probe.js';
import type { ReleaseStore } from './types.js';

function scriptByName(name: string): GeneratedScript {
  const found = HELPER_SCRIPTS.find((s) => s.name === name);
  if (!found) throw new Error(`No generated helper script named "${name}" (this is a bug).`);
  return found;
}

export const realClock: Clock = {
  now: () => new Date(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.setTimeout(resolve, ms));
}

/** Step a: UTC 'YYYYMMDDTHHMMSSZ'. */
export function generateReleaseId(clock: Clock = realClock): string {
  const d = clock.now();
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

export function appDirFor(app: string): string {
  return `/srv/bob-deploy/apps/${app}`;
}

function envFileContent(env: Record<string, string>): string {
  return (
    Object.entries(env)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join('\n') + '\n'
  );
}

export interface ReleaseInput {
  session: RemoteExec;
  app: string;
  domain: string;
  stack: StackInfo; // stack.startCmd, if set, must already have passed START_CMD_PATTERN
  kind: PackageKind;
  /** Already-built local directory: the staging copy for node/python, or the outputDir for static
   * (release.ts does not build anything itself — steps a/b of the brief: the caller runs
   * installCmd + buildCmd via runAllowed in staging before calling this). */
  sourceDir: string;
  /** The two ports allocated in proxy_and_https for this app. Ignored for static apps. */
  portA: number;
  portB: number;
  /** The port currently serving live traffic, if any (undefined on first deploy). */
  currentLivePort?: number;
  env: Record<string, string>;
  tlsMode: TlsMode;
  releaseStore: ReleaseStore;
  /** Omit to skip the public HTTPS check (e.g. in unit tests with no real network) — the private
   * health check (proxy apps only) still always runs via the SSH session. */
  httpProbe?: HttpProbe;
  clock?: Clock;
  /** Overridable for tests; defaults to the brief's real intervals. */
  healthCheckTries?: number;
  healthCheckIntervalMs?: number;
  publicCheckTries?: number;
  publicCheckIntervalMs?: number;
  keepReleases?: number;
}

export interface ReleaseOutput {
  releaseId: string;
  status: 'live' | 'rolled_back';
  livePort?: number;
  message: string;
  journalTail?: string;
}

async function packageAndUpload(
  session: RemoteExec,
  app: string,
  kind: PackageKind,
  sourceDir: string,
  releaseId: string,
): Promise<{ releaseDir: string; folderHash: string } | { error: string }> {
  const localDir = await mkdtemp(join(tmpdir(), 'bd-release-'));
  try {
    const localTar = join(localDir, `${releaseId}.tar.gz`);
    let packaged;
    try {
      packaged = await packageRelease(sourceDir, kind, localTar);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    const appDir = appDirFor(app);
    const remoteTar = `${appDir}/releases/${releaseId}.tar.gz`;
    const releaseDir = `${appDir}/releases/${releaseId}`;
    try {
      await session.upload(localTar, remoteTar);
    } catch (err) {
      return { error: `Failed to upload the release archive: ${err instanceof Error ? err.message : String(err)}` };
    }
    const extract = await session.exec(
      `mkdir -p '${releaseDir}' && tar -xzf '${remoteTar}' -C '${releaseDir}' && rm -f '${remoteTar}' && chmod -R g+rX '${releaseDir}'`,
      { timeoutMs: 120000 },
    );
    if (extract.code !== 0) {
      return { error: `Failed to extract the release archive: ${extract.stderr || extract.stdout}` };
    }
    return { releaseDir, folderHash: packaged.folderHash };
  } finally {
    await rm(localDir, { recursive: true, force: true });
  }
}

async function writeSharedEnv(session: RemoteExec, app: string, env: Record<string, string>): Promise<string | undefined> {
  const appDir = appDirFor(app);
  const localDir = await mkdtemp(join(tmpdir(), 'bd-env-'));
  try {
    const localPath = join(localDir, '.env');
    await writeFile(localPath, envFileContent(env), { mode: 0o600 });
    await chmod(localPath, 0o600);
    const remoteTmp = `${appDir}/shared/.env.tmp`;
    try {
      await session.upload(localPath, remoteTmp);
    } catch (err) {
      return `Failed to upload the environment file: ${err instanceof Error ? err.message : String(err)}`;
    }
    const move = await session.exec(`mv -f '${remoteTmp}' '${appDir}/shared/.env' && chmod 0640 '${appDir}/shared/.env'`);
    if (move.code !== 0) return `Failed to place the environment file: ${move.stderr || move.stdout}`;
    return undefined;
  } finally {
    await rm(localDir, { recursive: true, force: true });
  }
}

async function installDependencies(
  session: RemoteExec,
  releaseDir: string,
  kind: PackageKind,
): Promise<string | undefined> {
  if (kind === 'static') return undefined;
  let cmd: string;
  if (kind === 'node') {
    const hasLock = await session.exec(`test -f '${releaseDir}/package-lock.json'`);
    cmd = hasLock.code === 0 ? 'npm ci --omit=dev' : 'npm install --omit=dev';
  } else {
    cmd =
      'python3 -m venv .venv && ' +
      '(test -f requirements.txt && .venv/bin/pip install -r requirements.txt || true) && ' +
      '.venv/bin/pip install gunicorn uvicorn';
  }
  const result = await session.exec(`cd '${releaseDir}' && ${cmd}`, { timeoutMs: 15 * 60 * 1000 });
  if (result.code !== 0) return `Dependency install failed: ${result.stderr || result.stdout}`;
  return undefined;
}

/** 0755, not 0750: the service runs as bd-<app>, but this file is created by the admin user after
 * `tar -x` has reset the release dir's setgid bit, so it gets the admin's own group and bd-<app>
 * could not read it (exit 126 on every node/python start). World-readable is safe here: the parent
 * dirs (apps/<app>, releases/, both <admin>:bd-<app> 2750) already keep every other user out. */
async function writeStartScript(session: RemoteExec, releaseDir: string, startCmd: string): Promise<string | undefined> {
  const result = await session.exec(
    `cat > '${releaseDir}/.bd-start' <<'BD_START_EOF'\n#!/usr/bin/env bash\nexec ${startCmd}\nBD_START_EOF\nchmod 0755 '${releaseDir}/.bd-start'`,
  );
  if (result.code !== 0) return `Failed to write the start script: ${result.stderr || result.stdout}`;
  return undefined;
}

export async function bindReleaseToPort(session: RemoteExec, app: string, port: number, releaseId: string): Promise<string | undefined> {
  const appDir = appDirFor(app);
  const result = await session.exec(`printf '%s' '${releaseId}' > '${appDir}/run/${port}.release'`);
  if (result.code !== 0) return `Failed to bind release ${releaseId} to port ${port}: ${result.stderr || result.stdout}`;
  return undefined;
}

export async function privateHealthCheck(
  session: RemoteExec,
  port: number,
  healthPath: string,
  tries: number,
  intervalMs: number,
  clock: Clock,
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const result = await session.exec(
      `curl -s -o /dev/null -w '%{http_code}' --max-time 5 'http://127.0.0.1:${port}${healthPath}'`,
    );
    const code = Number(result.stdout.trim());
    if (Number.isFinite(code) && code >= 200 && code < 400) return true;
    if (i < tries - 1) await sleep(clock, intervalMs);
  }
  return false;
}

export async function publicCheck(
  probe: HttpProbe | undefined,
  domain: string,
  healthPath: string,
  tries: number,
  intervalMs: number,
  clock: Clock,
): Promise<boolean> {
  if (!probe) return true; // no probe configured (e.g. unit tests) -> treat as skipped/healthy
  for (let i = 0; i < tries; i++) {
    const result = await probe.probe(`https://${domain}${healthPath}`, 10000);
    if (result.ok) return true;
    if (i < tries - 1) await sleep(clock, intervalMs);
  }
  return false;
}

export async function stopInstance(session: RemoteExec, app: string, port: number): Promise<void> {
  await runScript(session, scriptByName('bd-service'), [app, String(port), 'stop'], { sudo: true }).catch(() => undefined);
}

/** Exported for the maintenance JobDef's 'clean_old_releases' action (core), which re-runs this
 * on demand outside of a deploy/update/rollback — everywhere else it already runs automatically
 * after every successful release below. */
export async function cleanupOldReleases(
  session: RemoteExec,
  app: string,
  store: ReleaseStore,
  liveId: string,
  keep: number,
): Promise<void> {
  const all = await store.listReleases(app);
  const sorted = [...all].sort((a, b) => b.id.localeCompare(a.id));
  const keepIds = new Set(sorted.slice(0, keep).map((r) => r.id));
  keepIds.add(liveId);
  const appDir = appDirFor(app);
  for (const record of sorted) {
    if (record.status === 'deleted' || keepIds.has(record.id)) continue;
    await session.exec(`rm -rf '${appDir}/releases/${record.id}'`).catch(() => undefined);
    await store.updateReleaseStatus(app, record.id, 'deleted');
  }
}

/**
 * The release procedure (steps a-m of the brief), shared by first deploy, update and rollback.
 * Static apps skip everything process-related (install, .bd-start, private health check, old
 * instance stop) and only ever swap the `current` symlink; node/python apps go through the full
 * blue/green sequence.
 */
export async function releaseProcedure(input: ReleaseInput): Promise<PlaybookStepOutcome<ReleaseOutput>> {
  const clock = input.clock ?? realClock;
  const healthPath = input.stack.healthPath ?? '/';
  const keep = input.keepReleases ?? 3;
  const isStatic = input.kind === 'static';

  // a
  const releaseId = generateReleaseId(clock);

  // c, d
  const staged = await packageAndUpload(input.session, input.app, input.kind, input.sourceDir, releaseId);
  if ('error' in staged) return stepFail('BUILD_FAILED', staged.error);
  await input.releaseStore.recordRelease(input.app, {
    id: releaseId,
    status: 'failed', // optimistic placeholder; promoted to 'live'/'previous' below once healthy
    createdAt: clock.now().toISOString(),
    folderHash: staged.folderHash,
  });

  // e
  const envErr = await writeSharedEnv(input.session, input.app, input.env);
  if (envErr) return stepFail('BUILD_FAILED', envErr);

  if (isStatic) {
    const swap = await input.session.exec(
      `cd '${appDirFor(input.app)}' && ln -sfn 'releases/${releaseId}' current.tmp && mv -Tf current.tmp current`,
    );
    if (swap.code !== 0) {
      return stepFail('BUILD_FAILED', `Failed to switch the static site to the new release: ${swap.stderr || swap.stdout}`);
    }
    if (!(await publicCheck(input.httpProbe, input.domain, healthPath, input.publicCheckTries ?? 10, input.publicCheckIntervalMs ?? 3000, clock))) {
      await input.releaseStore.updateReleaseStatus(input.app, releaseId, 'failed');
      return stepOk({
        releaseId,
        status: 'rolled_back',
        message: 'The new version did not answer correctly over HTTPS, so your site stays on the previous version.',
      });
    }
    await input.releaseStore.updateReleaseStatus(input.app, releaseId, 'live');
    await cleanupOldReleases(input.session, input.app, input.releaseStore, releaseId, keep);
    return stepOk({ releaseId, status: 'live', message: 'Deployed successfully.' });
  }

  // f
  const installErr = await installDependencies(input.session, `${appDirFor(input.app)}/releases/${releaseId}`, input.kind);
  if (installErr) {
    await input.releaseStore.updateReleaseStatus(input.app, releaseId, 'failed');
    return stepFail('BUILD_FAILED', installErr);
  }

  // g
  if (!input.stack.startCmd) return stepFail('UNSUPPORTED_STACK', 'No validated start command was provided for this release.');
  const startErr = await writeStartScript(input.session, `${appDirFor(input.app)}/releases/${releaseId}`, input.stack.startCmd);
  if (startErr) {
    await input.releaseStore.updateReleaseStatus(input.app, releaseId, 'failed');
    return stepFail('BUILD_FAILED', startErr);
  }

  // h
  const newPort = input.currentLivePort === input.portA ? input.portB : input.portA;
  const bindErr = await bindReleaseToPort(input.session, input.app, newPort, releaseId);
  if (bindErr) {
    await input.releaseStore.updateReleaseStatus(input.app, releaseId, 'failed');
    return stepFail('BUILD_FAILED', bindErr);
  }
  const start = await runScript(input.session, scriptByName('bd-service'), [input.app, String(newPort), 'restart'], { sudo: true });
  if (!start.outcome.ok) {
    await input.releaseStore.updateReleaseStatus(input.app, releaseId, 'failed');
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
    const journal = await runScript(input.session, scriptByName('bd-read-journal'), [input.app, String(newPort), '100'], { sudo: true });
    await stopInstance(input.session, input.app, newPort);
    await input.releaseStore.updateReleaseStatus(input.app, releaseId, 'failed');
    const journalTail = journal.outcome.ok ? Buffer.from(journal.outcome.data['content'] ?? '', 'base64').toString('utf8') : undefined;
    return stepOk({
      releaseId,
      status: 'rolled_back',
      message: 'The new version did not start correctly, so your site stays on the previous version.',
      journalTail,
    });
  }

  // j
  const site = await runScript(input.session, scriptByName('bd-caddy-site'), [input.app, input.domain, String(newPort), input.tlsMode], {
    sudo: true,
  });
  if (!site.outcome.ok) {
    await stopInstance(input.session, input.app, newPort);
    await input.releaseStore.updateReleaseStatus(input.app, releaseId, 'failed');
    return stepFail(mapBdErrorCode(site.outcome.code), site.outcome.message, { stderr: site.exec.stderr });
  }
  const swap = await input.session.exec(
    `cd '${appDirFor(input.app)}' && ln -sfn 'releases/${releaseId}' current.tmp && mv -Tf current.tmp current`,
  );
  if (swap.code !== 0) {
    await stopInstance(input.session, input.app, newPort);
    await input.releaseStore.updateReleaseStatus(input.app, releaseId, 'failed');
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
    // Roll back: point Caddy and the symlink back at the old release (still running), then stop
    // the new instance.
    if (typeof input.currentLivePort === 'number') {
      await runScript(input.session, scriptByName('bd-caddy-site'), [input.app, input.domain, String(input.currentLivePort), input.tlsMode], {
        sudo: true,
      }).catch(() => undefined);
    }
    const previousLive = (await input.releaseStore.listReleases(input.app)).find((r) => r.status === 'live');
    if (previousLive) {
      await input.session
        .exec(`cd '${appDirFor(input.app)}' && ln -sfn 'releases/${previousLive.id}' current.tmp && mv -Tf current.tmp current`)
        .catch(() => undefined);
    }
    await stopInstance(input.session, input.app, newPort);
    await input.releaseStore.updateReleaseStatus(input.app, releaseId, 'failed');
    return stepOk({
      releaseId,
      status: 'rolled_back',
      message: 'The new version did not answer correctly over HTTPS, so your site stays on the previous version.',
    });
  }

  // l
  if (typeof input.currentLivePort === 'number') {
    await stopInstance(input.session, input.app, input.currentLivePort);
    const previousLive = (await input.releaseStore.listReleases(input.app)).find((r) => r.status === 'live');
    if (previousLive) await input.releaseStore.updateReleaseStatus(input.app, previousLive.id, 'previous');
  }
  await input.releaseStore.updateReleaseStatus(input.app, releaseId, 'live');

  // m
  await cleanupOldReleases(input.session, input.app, input.releaseStore, releaseId, keep);

  return stepOk({ releaseId, status: 'live', livePort: newPort, message: 'Deployed successfully.' });
}

/** Wraps releaseProcedure in the PlaybookStep shape used elsewhere, for callers that want the
 * uniform id/title/run() interface (e.g. a future job runner iterating over a step list). */
export const firstReleaseStep: PlaybookStep<ReleaseInput, ReleaseOutput> = {
  id: 'first_release',
  title: 'Build and release the first version',
  run: releaseProcedure,
};
