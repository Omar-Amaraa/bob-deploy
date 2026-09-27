import { join } from 'node:path';
import { cp, mkdir } from 'node:fs/promises';
import type {
  AgentRunner,
  AnalyticsSummary,
  AppError,
  AppSettings,
  BobCheckResult,
  BobKeyType,
  BobSetupInput,
  BobStatus,
  Clock,
  CoreHandle,
  CoreOptions,
  DeployStartInput,
  DnsCheckResult,
  ErrorCode,
  FreeHostInputs,
  HealthStatus,
  HostId,
  HostProvider,
  HostTokenStatus,
  IpcChannel,
  IpcContract,
  IpcHost,
  JobEvent,
  JobKind,
  MaintenanceItem,
  MetricKind,
  MetricSample,
  OwnServerInputs,
  ProjectRecord,
  RemoteExec as ContractsRemoteExec,
  Result,
  TargetRecord,
  TimeRange,
} from '@bob-deploy/contracts';
import { IPC_CHANNELS, IPC_INPUT_SCHEMAS } from '@bob-deploy/contracts';
import { BobShellRunner, checkBob } from '@bob-deploy/agent';
import {
  connectSsh,
  ConnectionPool,
  nodeDnsResolver,
  testbedDnsResolver,
  sslipDomainFor,
  nodeHttpProbe,
  testbedHttpProbe,
  realClock,
  type SshSession,
  type RemoteExec as SshRemoteExec,
  type ExecOptions as SshExecOptions,
} from '@bob-deploy/ssh-playbooks';
import { openDatabase } from './db/db.js';
import { RepoError } from './util.js';
import { ProjectsRepo } from './db/repos/projects.js';
import { TargetsRepo } from './db/repos/targets.js';
import { ReleasesRepo } from './db/repos/releases.js';
import { SnapshotsRepo } from './db/repos/snapshots.js';
import { JobsRepo } from './db/repos/jobs.js';
import { MetricsRepo } from './db/repos/metrics.js';
import { ProblemsRepo } from './db/repos/problems.js';
import { SettingsRepo } from './db/repos/settings.js';
import { deleteProject } from './db/delete-project.js';
import { JobEngine } from './jobs/engine.js';
import { StepError, type JobDef } from './jobs/types.js';
import { JOB_SECRET_ENV_JSON, JOB_SECRET_ROOT_KEY_PASSPHRASE, JOB_SECRET_ROOT_PASSWORD } from './jobs/job-secret-keys.js';
import { Redactor } from './security/redactor.js';
import { Logger } from './logging/logger.js';
import { buildSshKeyExport, derivePublicKey } from './security/sshkey.js';
import { AccountService } from './account/account-service.js';
import { AccountError } from './account/errors.js';
import {
  SECRET_BOB_API_KEY,
  SECRET_NETLIFY_TOKEN,
  SECRET_VERCEL_TOKEN,
  projectEnvSecretKey,
  sshPassphraseSecretKey,
  sshPrivateKeySecretKey,
} from './account/secret-keys.js';
import { FakeHostProvider } from './fakes/host-provider.js';
import { takeSnapshot } from './snapshots/snapshot.js';
import {
  buildDeployOwnServerJobDef,
  buildDeployFreeJobDef,
  buildUpdateJobDef,
  buildRollbackJobDef,
  buildMaintenanceJobDef,
  buildDiagnoseJobDef,
} from './flows/index.js';

/** A plain, typed carrier for a Result-mappable failure that isn't tied to accounts, jobs or repos
 * (e.g. a monitor's getExec() call against a locked vault or an unsupported free-host target). */
class AppException extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppException';
    this.code = code;
    this.details = details;
  }
}

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

/** Dashboards a free-host provider doesn't expose an API for — matches rollback.ts's own copy;
 * duplicated rather than shared since the two call sites (rollback vs analytics) are unrelated. */
const FREE_HOST_DASHBOARD_URL: Record<string, string> = {
  netlify: 'https://app.netlify.com',
  vercel: 'https://vercel.com/dashboard',
};

function tokenKeyFor(host: HostId): string {
  return host === 'netlify' ? SECRET_NETLIFY_TOKEN : SECRET_VERCEL_TOKEN;
}

interface StoredBobConfig {
  keyType: BobKeyType;
  teamId?: string;
  binaryPath?: string;
  licenseAccepted: boolean;
  bobVersion?: string;
  nodeVersion?: string;
  lastCheckAt?: string;
  lastCheckOk?: boolean;
}
const BOB_CONFIG_KEY = 'bob_config';
const DEFAULT_BOB_CONFIG: StoredBobConfig = { keyType: 'inference', licenseAccepted: false };

interface StoredHostMeta {
  accountName?: string;
  teamId?: string;
  savedAt?: string;
}
function hostMetaKey(host: HostId): string {
  return `host_meta:${host}`;
}

function unitForKind(kind: MetricKind): string {
  switch (kind) {
    case 'http':
      return 'status';
    case 'response_ms':
      return 'ms';
    case 'cpu':
    case 'memory':
    case 'disk':
      return '%';
    case 'requests':
      return 'count';
    case 'cert':
      return 'days';
  }
}

function rangeToHours(range: TimeRange): number {
  return range === '24h' ? 24 : range === '7d' ? 24 * 7 : 24 * 30;
}

/** Adapts ssh-playbooks' RemoteExec (sync close(), one-object onOutput chunk, extra truncated
 * flags) to packages/contracts' frozen RemoteExec (async close(), two-arg onOutput). Needed because
 * MonitorContext.getExec() is typed against the contracts shape but ConnectionPool/connectSsh only
 * ever produce ssh-playbooks' own shape. */
function toContractsRemoteExec(session: SshRemoteExec): ContractsRemoteExec {
  return {
    async exec(cmd, opts) {
      const sshOpts: SshExecOptions | undefined = opts
        ? {
            sudo: opts.sudo,
            timeoutMs: opts.timeoutMs,
            stdin: opts.stdin,
            onOutput: opts.onOutput ? (chunk) => opts.onOutput?.(chunk.text, chunk.stream) : undefined,
          }
        : undefined;
      const result = await session.exec(cmd, sshOpts);
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    },
    upload: (localPath, remotePath) => session.upload(localPath, remotePath),
    close: () => {
      session.close();
      return Promise.resolve();
    },
  };
}

/**
 * createCore(): the single entry point app-shell (Codex) calls to boot Bob Deploy's business logic.
 * See packages/contracts/src/core-api.ts for the frozen CreateCore type this satisfies.
 */
export async function createCore(
  opts: CoreOptions,
): Promise<CoreHandle & { registerIpc(host: IpcHost): void }> {
  const dataDir = opts.dataDir;
  const bobHome = join(dataDir, 'bob-home');
  // Bob Shell is launched with bobHome as its cwd. On Windows, cross-spawn reports a missing cwd
  // as `spawn ...\\cmd.exe ENOENT`, which looks like cmd.exe is missing even when it is installed.
  await mkdir(bobHome, { recursive: true });
  const testbed = process.env.BOB_DEPLOY_TESTBED === '1';
  const clock: Clock =
    opts.clock ?? {
      now: () => new Date(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    };

  const db = openDatabase(join(dataDir, 'bob-deploy.sqlite'));
  const redactor = new Redactor();
  const logger = new Logger(dataDir, redactor, clock);
  const redact = (s: string): string => redactor.redact(s);

  const projectsRepo = new ProjectsRepo(db);
  const targetsRepo = new TargetsRepo(db);
  const releasesRepo = new ReleasesRepo(db);
  const snapshotsRepo = new SnapshotsRepo(db);
  const jobsRepo = new JobsRepo(db);
  const metricsRepo = new MetricsRepo(db);
  const problemsRepo = new ProblemsRepo(db);
  const settingsRepo = new SettingsRepo(db);

  const connectionPool = new ConnectionPool();

  // Set once registerIpc(host) is called; every push (`ipcHost?.emit(...)`) is a no-op until then.
  let ipcHost: IpcHost | undefined;
  // Resolved after jobEngine is constructed below (AccountService's `busy` option needs it, and
  // JobEngine's registry needs `accountService` as the flows' VaultLike — a small, deliberate
  // circular wiring resolved by this forward reference). Assigned exactly once, after
  // construction, so eslint's static analysis can't see the closures that read it in between —
  // `let` is required here, not a style preference.
  // eslint-disable-next-line prefer-const
  let jobEngineRef: JobEngine | undefined;

  const accountService = new AccountService({
    dataDir,
    redactor,
    logger,
    clock,
    keyProtector: opts.keyProtector,
    busy: () => jobEngineRef?.isBusy() ?? false,
    onLocked: (reason) => {
      monitorService.stopAll();
      connectionPool.closeAll();
      ipcHost?.emit('account:locked', { reason });
    },
  });
  // AccountService satisfies flows' VaultLike (getSecret/setSecret/deleteSecret/listKeys) structurally.
  const vault = accountService;

  function loadBobConfig(): StoredBobConfig {
    const raw = settingsRepo.getRaw(BOB_CONFIG_KEY);
    return raw ? { ...DEFAULT_BOB_CONFIG, ...(JSON.parse(raw) as Partial<StoredBobConfig>) } : DEFAULT_BOB_CONFIG;
  }
  function saveBobConfig(cfg: StoredBobConfig): void {
    settingsRepo.setRaw(BOB_CONFIG_KEY, JSON.stringify(cfg));
  }
  function computeBobStatus(): BobStatus {
    const cfg = loadBobConfig();
    const keySaved = vault.getSecret(SECRET_BOB_API_KEY) !== undefined;
    return {
      configured: keySaved && cfg.licenseAccepted,
      keySaved,
      ...(cfg.keyType ? { keyType: cfg.keyType } : {}),
      teamIdSet: Boolean(cfg.teamId),
      ...(cfg.binaryPath ? { binaryPath: cfg.binaryPath } : {}),
      ...(cfg.bobVersion ? { bobVersion: cfg.bobVersion } : {}),
      ...(cfg.nodeVersion ? { nodeVersion: cfg.nodeVersion } : {}),
      licenseAccepted: cfg.licenseAccepted,
      ...(cfg.lastCheckAt ? { lastCheckAt: cfg.lastCheckAt } : {}),
      ...(cfg.lastCheckOk !== undefined ? { lastCheckOk: cfg.lastCheckOk } : {}),
    };
  }

  /** A BobShellRunner is stateless configuration wrapped in a class; this wrapper rebuilds one from
   * the latest stored config/vault key on every run() call, so a settings/bob:save change takes
   * effect on the very next job step without needing to rebuild the JobEngine's whole registry. */
  function createDynamicBobRunner(): AgentRunner {
    let lastCancel: (() => Promise<void>) | undefined;
    return {
      run(task) {
        const cfg = loadBobConfig();
        const runner = new BobShellRunner({
          getApiKey: () => Promise.resolve(vault.getSecret(SECRET_BOB_API_KEY) ?? ''),
          config: {
            keyType: cfg.keyType,
            teamId: cfg.teamId,
            binaryPath: cfg.binaryPath,
            licenseAccepted: cfg.licenseAccepted,
          },
          bobHome,
          redactor,
          clock: { now: () => clock.now().getTime() },
        });
        lastCancel = () => runner.cancel();
        return runner.run(task);
      },
      cancel: () => lastCancel?.() ?? Promise.resolve(),
    };
  }
  const agentRunner = createDynamicBobRunner();

  function buildHostProviders(): Record<HostId, HostProvider> {
    const map: Partial<Record<HostId, HostProvider>> = {};
    for (const p of opts.hostProviders ?? []) map[p.id] = p;
    if (testbed) {
      map.netlify ??= new FakeHostProvider('netlify');
      map.vercel ??= new FakeHostProvider('vercel');
    }
    // Deliberately possibly-partial at runtime (HOST_UNSUPPORTED when a key is missing); every
    // flow already guards with `if (!provider) ctx.fail('HOST_UNSUPPORTED', ...)`.
    return map as Record<HostId, HostProvider>;
  }
  const hostProviders = buildHostProviders();

  function pushMetricsUpdated(projectId: string, kinds: MetricKind[]): void {
    ipcHost?.emit('metrics:updated', { projectId, kinds });
  }

  const metricsSink = {
    writeSamples(samples: MetricSample[]): void {
      const kindsByProject = new Map<string, Set<MetricKind>>();
      for (const sample of samples) {
        metricsRepo.record(sample);
        const set = kindsByProject.get(sample.projectId) ?? new Set<MetricKind>();
        set.add(sample.kind);
        kindsByProject.set(sample.projectId, set);
      }
      for (const [projectId, kinds] of kindsByProject) pushMetricsUpdated(projectId, [...kinds]);
    },
    writeAnalytics(buckets: Parameters<MetricsRepo['recordAnalyticsBucket']>[0][]): void {
      for (const bucket of buckets) metricsRepo.recordAnalyticsBucket(bucket);
    },
    setMaintenance(projectId: string, items: MaintenanceItem[]): void {
      metricsRepo.setMaintenanceItems(projectId, items);
    },
    setHealth(projectId: string, health: HealthStatus): void {
      metricsRepo.setHealth(projectId, health);
      pushMetricsUpdated(projectId, []);
    },
    getCursor: (projectId: string, key: string) => metricsRepo.getCursor(projectId, key),
    setCursor: (projectId: string, key: string, value: string) => metricsRepo.setCursor(projectId, key, value),
  };

  const noopMonitorService = {
    start: () => undefined,
    stop: () => undefined,
    stopAll: () => undefined,
    runNow: () => Promise.resolve(),
  };
  const monitorFactory = opts.monitorFactory ?? (() => noopMonitorService);
  const monitorService = monitorFactory({
    sink: metricsSink,
    clock,
    intervals: settingsRepo.get().pollIntervals,
    log: (msg: string) => logger.info(msg),
  });

  async function connectAsAdminSession(target: TargetRecord): Promise<SshSession> {
    if (!target.ip || !target.adminUser) {
      throw new AppException('INTERNAL', 'This server target is missing its ip/adminUser.');
    }
    const privateKey = vault.getSecret(sshPrivateKeySecretKey(target.id));
    const passphrase = vault.getSecret(sshPassphraseSecretKey(target.id));
    if (!privateKey || !passphrase) {
      throw new AppException('INTERNAL', 'No admin SSH key on record for this target.');
    }
    return connectSsh({
      host: target.ip,
      port: target.sshPort ?? 22,
      username: target.adminUser,
      auth: { privateKey, passphrase },
      expectedFingerprint: target.hostKeyFingerprint,
      redact,
    });
  }

  function startMonitorForTarget(projectId: string, target: TargetRecord): void {
    if (!target.siteUrl) return; // nothing to health-check yet
    monitorService.start({
      projectId,
      target,
      siteUrl: target.siteUrl,
      getExec: async () => {
        if (!accountService.status().unlocked) {
          throw new AppException('LOCKED', 'Unlock Bob Deploy first.');
        }
        if (target.kind !== 'own_server') {
          throw new AppException('HOST_UNSUPPORTED', 'Resource monitoring is only available for your own server.');
        }
        const session = await connectionPool.getSession(target.id, () => connectAsAdminSession(target));
        return toContractsRemoteExec(session);
      },
      tlsInsecure: testbed,
    });
  }

  function startAllMonitors(): void {
    for (const project of projectsRepo.list()) {
      const target = targetsRepo.getByProjectId(project.id);
      if (target) startMonitorForTarget(project.id, target);
    }
  }

  function restartMonitorForProject(projectId: string): void {
    const target = targetsRepo.getByProjectId(projectId);
    monitorService.stop(projectId);
    if (target) startMonitorForTarget(projectId, target);
  }

  // --- JobEngine ------------------------------------------------------------------------------

  const registry = new Map<JobKind, JobDef>();
  const flowDeps = {
    projectsRepo,
    targetsRepo,
    releasesRepo,
    snapshotsRepo,
    vault,
    redactor,
    redact,
    agentRunner,
    // DEC-021: once Bob is set up, he analyses every project at the start of each deploy/update,
    // even when the built-in checks are already confident, so the user sees him at work.
    askBob: () => computeBobStatus().configured,
    dataDir,
    providers: hostProviders,
    // Testbed mode: *.bd.test sites are probed on the testbed's mapped HTTPS port (8443 for the
    // ubuntu2404 box; BOB_DEPLOY_TESTBED_HTTPS_PORT for another), every other URL as usual.
    httpProbe: testbed ? testbedHttpProbe(Number(process.env.BOB_DEPLOY_TESTBED_HTTPS_PORT ?? '8443')) : nodeHttpProbe,
    // Same resolver as the dns:check handler below, so a *.bd.test domain that passed "Check DNS"
    // in testbed mode (DEC-020) also passes deploy_own_server's own DNS step.
    ...(testbed ? { dns: testbedDnsResolver(nodeDnsResolver()) } : {}),
  };
  registry.set('deploy_own_server', buildDeployOwnServerJobDef(flowDeps));
  registry.set('deploy_free', buildDeployFreeJobDef(flowDeps));
  registry.set('update', buildUpdateJobDef(flowDeps));
  registry.set('rollback', buildRollbackJobDef(flowDeps));
  registry.set('maintenance', buildMaintenanceJobDef({
    ...flowDeps,
    runMaintenanceCheck: (projectId) => monitorService.runNow(projectId, 'maintenance'),
  }));
  registry.set('diagnose', buildDiagnoseJobDef({ ...flowDeps, jobsRepo, problemsRepo }));

  let hasResumedOnce = false;

  const jobEngine = new JobEngine({
    db,
    redact,
    clock,
    registry,
    emit: (event: JobEvent) => {
      ipcHost?.emit('job:events', event);
      if (event.type !== 'done') return;
      accountService.onJobFinished();
      const summary = jobsRepo.getSummary(event.jobId);
      if (!summary) return;
      const project = projectsRepo.get(summary.projectId);
      if (project) ipcHost?.emit('project:status', { projectId: project.id, status: project.status });
      if (accountService.status().unlocked) restartMonitorForProject(summary.projectId);
    },
  });
  jobEngineRef = jobEngine;

  function toFullProjectRecord(projectId: string): ProjectRecord | undefined {
    const project = projectsRepo.get(projectId);
    if (!project) return undefined;
    const target = targetsRepo.getByProjectId(projectId);
    const lastRelease = releasesRepo.listForProject(projectId)[0];
    return { ...project, ...(target ? { target } : {}), ...(lastRelease ? { lastRelease } : {}) };
  }

  async function restoreSnapshot(projectId: string, snapshotId: string): Promise<void> {
    const project = projectsRepo.get(projectId);
    if (!project) throw new AppException('NOT_FOUND', 'Project not found.');
    const snapshot = snapshotsRepo.get(snapshotId);
    const path = snapshotsRepo.getPath(snapshotId);
    if (!snapshot || !path || snapshot.projectId !== projectId) {
      throw new AppException('NOT_FOUND', 'Snapshot not found.');
    }
    await takeSnapshot({
      projectId,
      projectDir: project.folderPath,
      dataDir,
      reason: 'before restore',
      snapshotsRepo,
      clock: realClock,
    });
    await mkdir(project.folderPath, { recursive: true });
    await cp(path, project.folderPath, { recursive: true, force: true });
  }

  function computeAnalyticsSummary(projectId: string, range: TimeRange): AnalyticsSummary {
    const target = targetsRepo.getByProjectId(projectId);
    if (!target) {
      return { range, source: 'unavailable', visits: 0, uniqueVisitors: 0, topPages: [], statusCodes: {}, series: [] };
    }
    if (target.kind !== 'own_server') {
      const provider = hostProviders[target.kind];
      return {
        range,
        source: 'provider_dashboard',
        visits: 0,
        uniqueVisitors: 0,
        topPages: [],
        statusCodes: {},
        series: [],
        providerDashboardUrl: FREE_HOST_DASHBOARD_URL[target.kind] ?? provider?.tokenPageUrl,
      };
    }
    const sinceTs = new Date(clock.now().getTime() - rangeToHours(range) * 3600_000).toISOString();
    const buckets = metricsRepo.listAnalyticsBuckets(projectId, sinceTs);
    let visits = 0;
    let uniqueVisitors = 0;
    const byPath = new Map<string, number>();
    const statusCodes: Record<string, number> = {};
    const byBucket = new Map<string, number>();
    const dailyBuckets = range === '30d';
    for (const b of buckets) {
      visits += b.count;
      uniqueVisitors += b.visitors;
      byPath.set(b.path, (byPath.get(b.path) ?? 0) + b.count);
      const cls = `${Math.floor(b.status / 100)}xx`;
      statusCodes[cls] = (statusCodes[cls] ?? 0) + b.count;
      const key = dailyBuckets ? b.hourTs.slice(0, 10) : b.hourTs;
      byBucket.set(key, (byBucket.get(key) ?? 0) + b.count);
    }
    const topPages = [...byPath.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([path, count]) => ({ path, count }));
    const series = [...byBucket.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ts, count]) => ({ ts, visits: count }));
    return { range, source: 'caddy', visits, uniqueVisitors, topPages, statusCodes, series };
  }

  function mapError(err: unknown): AppError {
    if (err instanceof AccountError || err instanceof StepError || err instanceof AppException) {
      return { code: err.code, message: err.message, ...('details' in err && err.details ? { details: err.details } : {}) };
    }
    if (err instanceof RepoError) {
      return { code: err.code as ErrorCode, message: err.message };
    }
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
    logger.error('Unhandled IPC handler error', { stack });
    return { code: 'INTERNAL', message: 'Something went wrong. Details are in the log.' };
  }

  // Channels that must work while the vault is locked (per the brief's gating rule); every other
  // channel returns LOCKED before its handler is even invoked.
  const LOCK_EXEMPT: ReadonlySet<IpcChannel> = new Set([
    'account:status',
    'account:checkPassword',
    'account:create',
    'account:unlock',
    'account:recover',
    'settings:get',
  ]);

  // --- Channel handlers -------------------------------------------------------------------------

  type Handlers = { [C in IpcChannel]: (input: IpcContract[C]['in']) => Promise<IpcContract[C]['out']> };

  const jobSubscriptions = new Map<string, () => void>();

  const handlers: Handlers = {
    'account:status': () => Promise.resolve(accountService.status()),
    'account:checkPassword': (input) => Promise.resolve(accountService.checkPassword(input.password, input.userInputs)),
    'account:create': (input) => accountService.create(input),
    'account:unlock': async (input) => {
      const status = await accountService.unlock(input.password);
      if (status.unlocked) {
        if (!hasResumedOnce) {
          hasResumedOnce = true;
          jobEngine.resumeAll();
        }
        startAllMonitors();
      }
      return status;
    },
    'account:lock': () => Promise.resolve(accountService.lock('manual')),
    'account:touch': () => {
      accountService.touch();
      return Promise.resolve();
    },
    'account:changePassword': async (input) => {
      await accountService.changePassword(input);
    },
    'account:recover': (input) => accountService.recover(input),
    'account:regenerateRecoveryCode': (input) => accountService.regenerateRecoveryCode(input.password),
    'account:completeOnboarding': () => Promise.resolve(accountService.completeOnboarding()),

    'bob:status': () => Promise.resolve(computeBobStatus()),
    'bob:save': (input: BobSetupInput) => {
      if (input.apiKey) vault.setSecret(SECRET_BOB_API_KEY, input.apiKey);
      const cfg = loadBobConfig();
      saveBobConfig({
        ...cfg,
        keyType: input.keyType,
        teamId: input.teamId,
        binaryPath: input.binaryPath,
        licenseAccepted: input.acceptLicense,
      });
      return Promise.resolve(computeBobStatus());
    },
    'bob:check': async () => {
      const cfg = loadBobConfig();
      const results: BobCheckResult[] = await checkBob(
        { keyType: cfg.keyType, teamId: cfg.teamId, binaryPath: cfg.binaryPath, licenseAccepted: cfg.licenseAccepted },
        () => Promise.resolve(vault.getSecret(SECRET_BOB_API_KEY) ?? ''),
        bobHome,
      );
      const binary = results.find((r) => r.step === 'binary');
      const node = results.find((r) => r.step === 'node');
      saveBobConfig({
        ...cfg,
        bobVersion: binary?.value ?? cfg.bobVersion,
        nodeVersion: node?.value ?? cfg.nodeVersion,
        lastCheckAt: clock.now().toISOString(),
        lastCheckOk: results.every((r) => r.ok),
      });
      return results;
    },
    'bob:clear': () => {
      vault.deleteSecret(SECRET_BOB_API_KEY);
      saveBobConfig(DEFAULT_BOB_CONFIG);
      return Promise.resolve(computeBobStatus());
    },

    'hosts:status': () => Promise.resolve((['netlify', 'vercel'] as HostId[]).map(computeHostTokenStatus)),
    'hosts:saveToken': async (input) => {
      const provider = hostProviders[input.host];
      if (!provider) throw new AppException('HOST_UNSUPPORTED', `${input.host} is not a supported host.`);
      const check = await provider.validateToken(input.token, input.teamId);
      if (!check.ok) {
        throw new AppException('HOST_AUTH_FAILED', check.message ?? 'That token was rejected.');
      }
      vault.setSecret(tokenKeyFor(input.host), input.token);
      const meta: StoredHostMeta = { accountName: check.accountName, teamId: input.teamId, savedAt: clock.now().toISOString() };
      settingsRepo.setRaw(hostMetaKey(input.host), JSON.stringify(meta));
      return computeHostTokenStatus(input.host);
    },
    'hosts:revokeToken': (input) => {
      vault.deleteSecret(tokenKeyFor(input.host));
      const provider = hostProviders[input.host];
      // HostTokenStatus (frozen contract) has no field for this, so the revoke-upstream reminder
      // (S10) goes to the log rather than the response.
      logger.info('Revoked a host token locally; revoke it upstream too.', {
        host: input.host,
        tokenPageUrl: provider?.tokenPageUrl,
      });
      return Promise.resolve(computeHostTokenStatus(input.host));
    },

    'settings:get': () => Promise.resolve(settingsRepo.get()),
    'settings:set': (patch: Partial<AppSettings>) => {
      const next = settingsRepo.update(patch);
      if (typeof patch.autoLockMinutes === 'number') accountService.setAutoLockMinutes(patch.autoLockMinutes);
      return Promise.resolve(next);
    },

    'security:targetInfo': (input) => {
      const target = targetsRepo.get(input.targetId);
      if (!target) throw new AppException('NOT_FOUND', 'Target not found.');
      const privateKey = vault.getSecret(sshPrivateKeySecretKey(target.id));
      const passphrase = vault.getSecret(sshPassphraseSecretKey(target.id));
      if (!privateKey || !passphrase) throw new AppException('NOT_FOUND', 'No admin key on record for this target.');
      const { publicKeyOpenSsh } = derivePublicKey(privateKey, passphrase);
      return Promise.resolve({
        hostKeyFingerprint: target.hostKeyFingerprint ?? '',
        adminUser: target.adminUser ?? '',
        publicKey: publicKeyOpenSsh,
      });
    },
    'security:revealSshPassphrase': async (input) => {
      // Re-verifies the master password (through the same path/backoff as account:unlock) before
      // revealing anything, per the brief — this counts as a real attempt toward lockout.
      await accountService.unlock(input.password);
      const target = targetsRepo.get(input.targetId);
      if (!target) throw new AppException('NOT_FOUND', 'Target not found.');
      const passphrase = vault.getSecret(sshPassphraseSecretKey(target.id));
      if (!passphrase) throw new AppException('NOT_FOUND', 'No admin key on record for this target.');
      logger.info('security.revealSshPassphrase', { targetId: input.targetId });
      return { passphrase };
    },
    'security:exportSshKey': async (input) => {
      // DEC-022. Same gate as revealSshPassphrase: the master password is re-verified (a real attempt
      // toward lockout) before anything leaves the vault. Only the target id is logged, never the key.
      await accountService.unlock(input.password);
      const target = targetsRepo.get(input.targetId);
      if (!target) throw new AppException('NOT_FOUND', 'Target not found.');
      const privateKey = vault.getSecret(sshPrivateKeySecretKey(target.id));
      const passphrase = vault.getSecret(sshPassphraseSecretKey(target.id));
      if (!privateKey || !passphrase) throw new AppException('NOT_FOUND', 'No admin key on record for this target.');
      const exported = buildSshKeyExport(target, privateKey, passphrase);
      logger.info('security.exportSshKey', { targetId: input.targetId });
      return exported;
    },

    'projects:list': () => Promise.resolve(projectsRepo.list().map((p) => toFullProjectRecord(p.id)).filter((p): p is ProjectRecord => Boolean(p))),
    'projects:create': (input) => {
      const created = projectsRepo.create(input);
      return Promise.resolve(toFullProjectRecord(created.id) ?? created);
    },
    'projects:get': (input) => {
      const record = toFullProjectRecord(input.projectId);
      if (!record) throw new AppException('NOT_FOUND', 'Project not found.');
      return Promise.resolve(record);
    },
    'projects:remove': (input) => {
      const project = projectsRepo.get(input.projectId);
      if (!project) throw new AppException('NOT_FOUND', 'Project not found.');
      monitorService.stop(input.projectId);
      deleteProject(db, input.projectId, { deleteHistory: input.deleteHistory });
      return Promise.resolve();
    },
    'projects:getEnvKeys': (input) => {
      if (!projectsRepo.get(input.projectId)) throw new AppException('NOT_FOUND', 'Project not found.');
      const raw = vault.getSecret(projectEnvSecretKey(input.projectId));
      const env = raw ? (JSON.parse(raw) as Record<string, string>) : {};
      return Promise.resolve({ keys: Object.keys(env) });
    },
    'projects:setEnv': (input) => {
      if (!projectsRepo.get(input.projectId)) throw new AppException('NOT_FOUND', 'Project not found.');
      vault.setSecret(projectEnvSecretKey(input.projectId), JSON.stringify(input.env));
      return Promise.resolve({ keys: Object.keys(input.env) });
    },

    'snapshots:list': (input) => Promise.resolve(snapshotsRepo.listForProject(input.projectId)),
    'snapshots:restore': (input) => restoreSnapshot(input.projectId, input.snapshotId),

    'dns:check': async (input) => {
      const resolver = testbed ? testbedDnsResolver(nodeDnsResolver()) : nodeDnsResolver();
      const resolved = await resolver.resolveA(input.domain);
      const result: DnsCheckResult = {
        domain: input.domain,
        expectedIp: input.ip,
        resolved,
        matches: resolved.includes(input.ip),
        sslipAlternative: sslipDomainFor(input.ip),
      };
      return result;
    },

    'deploy:start': (input: DeployStartInput) => {
      const secrets = new Map<string, string>();
      if (input.target === 'own_server') {
        const oi: OwnServerInputs = input.inputs;
        if (oi.rootAuth.method === 'password') {
          secrets.set(JOB_SECRET_ROOT_PASSWORD, oi.rootAuth.password);
        } else if (oi.rootAuth.keyPassphrase) {
          secrets.set(JOB_SECRET_ROOT_KEY_PASSPHRASE, oi.rootAuth.keyPassphrase);
        }
        secrets.set(JOB_SECRET_ENV_JSON, JSON.stringify(oi.env));
        const sanitizedRootAuth =
          oi.rootAuth.method === 'password'
            ? { method: 'password' as const }
            : { method: 'key' as const, privateKeyPath: oi.rootAuth.privateKeyPath };
        const sanitizedInputs = {
          domain: oi.domain,
          useSslipFallback: oi.useSslipFallback,
          serverIp: oi.serverIp,
          sshPort: oi.sshPort,
          rootUser: oi.rootUser,
          rootAuth: sanitizedRootAuth,
          adminUser: oi.adminUser,
          acmeEmail: oi.acmeEmail,
        };
        const jobId = jobEngine.start(input.projectId, 'deploy_own_server', sanitizedInputs, secrets);
        return Promise.resolve({ jobId });
      }
      const fi: FreeHostInputs = input.inputs;
      secrets.set(JOB_SECRET_ENV_JSON, JSON.stringify(fi.env));
      const sanitizedInputs = { host: fi.host, siteName: fi.siteName };
      const jobId = jobEngine.start(input.projectId, 'deploy_free', sanitizedInputs, secrets);
      return Promise.resolve({ jobId });
    },
    'update:start': (input) => Promise.resolve({ jobId: jobEngine.start(input.projectId, 'update', {}) }),
    'rollback:start': (input) =>
      Promise.resolve({ jobId: jobEngine.start(input.projectId, 'rollback', { releaseId: input.releaseId }) }),
    'releases:list': (input) => Promise.resolve(releasesRepo.listForProject(input.projectId)),

    'job:list': (input) => Promise.resolve(jobEngine.listJobs(input.projectId, input.limit)),
    'job:get': (input) => {
      const result = jobEngine.getJob(input.jobId);
      if (!result) throw new AppException('NOT_FOUND', 'Job not found.');
      return Promise.resolve(result);
    },
    'job:subscribe': (input) => {
      jobSubscriptions.get(input.jobId)?.();
      let lastSeq = input.fromSeq ?? 0;
      const unsubscribe = jobEngine.subscribe(input.jobId, input.fromSeq ?? 0, (event) => {
        lastSeq = event.seq;
        ipcHost?.emit('job:events', event);
      });
      jobSubscriptions.set(input.jobId, unsubscribe);
      return Promise.resolve({ lastSeq });
    },
    'job:unsubscribe': (input) => {
      jobSubscriptions.get(input.jobId)?.();
      jobSubscriptions.delete(input.jobId);
      return Promise.resolve();
    },
    'job:answer': (input) => {
      jobEngine.answer(input.jobId, input.questionId, input.value);
      return Promise.resolve();
    },
    'job:cancel': (input) => {
      jobEngine.cancel(input.jobId);
      return Promise.resolve();
    },

    'metrics:latest': (input) => {
      const sinceTs = new Date(clock.now().getTime() - 24 * 3600_000).toISOString();
      const samples = input.kinds
        .map((kind) => metricsRepo.listRawSince(input.projectId, kind, sinceTs).at(-1))
        .filter((s): s is MetricSample => Boolean(s));
      return Promise.resolve(samples);
    },
    'metrics:series': (input) => {
      const sinceTs = new Date(clock.now().getTime() - rangeToHours(input.range) * 3600_000).toISOString();
      if (input.range === '24h') {
        return Promise.resolve(metricsRepo.listRawSince(input.projectId, input.kind, sinceTs));
      }
      const hourly = metricsRepo.listHourly(input.projectId, input.kind, sinceTs);
      const samples: MetricSample[] = hourly.map((h) => ({
        projectId: input.projectId,
        kind: input.kind,
        value: h.avg,
        unit: unitForKind(input.kind),
        ts: h.hour_ts,
      }));
      return Promise.resolve(samples);
    },
    'health:get': (input) => {
      const health = metricsRepo.getHealth(input.projectId);
      const pollMs = settingsRepo.get().pollIntervals.healthMs;
      if (!health) {
        return Promise.resolve({ up: false, failedServices: [], stale: true });
      }
      const stale = !health.checkedAt || clock.now().getTime() - new Date(health.checkedAt).getTime() > pollMs * 3;
      return Promise.resolve({ ...health, stale });
    },
    'analytics:get': (input) => Promise.resolve(computeAnalyticsSummary(input.projectId, input.range)),
    'maintenance:list': (input) => Promise.resolve(metricsRepo.getMaintenanceItems(input.projectId)),
    'maintenance:run': (input) =>
      Promise.resolve({ jobId: jobEngine.start(input.projectId, 'maintenance', { actionId: input.actionId }) }),
    'problem:signal': (input) => Promise.resolve({ jobId: jobEngine.start(input.projectId, 'diagnose', { note: input.note }) }),
    'problems:list': (input) => Promise.resolve(problemsRepo.listForProject(input.projectId)),
  };

  function computeHostTokenStatus(host: HostId): HostTokenStatus {
    const connected = vault.getSecret(tokenKeyFor(host)) !== undefined;
    const raw = settingsRepo.getRaw(hostMetaKey(host));
    const meta: StoredHostMeta = raw ? (JSON.parse(raw) as StoredHostMeta) : {};
    return {
      host,
      connected,
      ...(connected && meta.accountName ? { accountName: meta.accountName } : {}),
      ...(connected && meta.teamId ? { teamId: meta.teamId } : {}),
      ...(connected && meta.savedAt ? { savedAt: meta.savedAt } : {}),
    };
  }

  function registerIpc(host: IpcHost): void {
    ipcHost = host;
    for (const channel of IPC_CHANNELS) {
      host.handle(channel, async (rawPayload: unknown): Promise<Result<unknown>> => {
        const schema = IPC_INPUT_SCHEMAS[channel];
        const parsed = schema.safeParse(rawPayload);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const message = issue ? (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message) : 'Invalid input.';
          return { ok: false, error: { code: 'VALIDATION', message } };
        }
        if (!LOCK_EXEMPT.has(channel) && !accountService.status().unlocked) {
          return { ok: false, error: { code: 'LOCKED', message: 'Unlock Bob Deploy first.' } };
        }
        try {
          // Per-channel input/output typing already happened at `handlers` definition time; this
          // dispatch loop is untyped plumbing over a schema-validated payload (see IPC_INPUT_SCHEMAS).
          const handler = handlers[channel] as (input: unknown) => Promise<unknown>;
          const data = await handler(parsed.data);
          if (channel !== 'account:touch') accountService.touch();
          return ok(data);
        } catch (err) {
          return { ok: false, error: mapError(err) };
        }
      });
    }
  }

  return {
    registerIpc,
    // eslint-disable-next-line @typescript-eslint/require-await -- CoreHandle.shutdown is Promise<void>; db.close() is synchronous.
    async shutdown(): Promise<void> {
      monitorService.stopAll();
      connectionPool.closeAll();
      db.close();
    },
  };
}
