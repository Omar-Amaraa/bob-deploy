import {
  DEFAULT_POLL_INTERVALS,
  IPC_CHANNELS,
  type AccountStatus,
  type AnalyticsSummary,
  type AppSettings,
  type BobCheckResult,
  type BobSetupInput,
  type BobStatus,
  type DeployStartInput,
  type HealthStatus,
  type HostId,
  type HostTokenStatus,
  type IpcChannel,
  type IpcTransport,
  type JobAnswer,
  type JobEvent,
  type JobKind,
  type JobQuestion,
  type JobStatus,
  type JobStepView,
  type JobSummary,
  type MaintenanceItem,
  type MetricKind,
  type MetricSample,
  type ProblemRecord,
  type ProjectCreateInput,
  type ProjectRecord,
  type PushEvent,
  type ReleaseRecord,
  type Result,
  type SnapshotRecord,
  type TimeRange,
} from '@bob-deploy/contracts';

export type MockScenario =
  | 'fresh'
  | 'locked'
  | 'onboarded-empty'
  | 'live-own-server'
  | 'live-free-host'
  | 'server-down'
  | 'failed-update'
  | 'bob-missing';

type PushListener = (payload: unknown) => void;

const NOW = '2026-09-25T16:00:00.000Z';
const RECOVERY_CODE = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KNOWN_PASSWORD = 'correct horse battery staple';

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

function fail(
  code: 'BAD_PASSWORD' | 'TOO_MANY_ATTEMPTS' | 'NOT_FOUND' | 'VALIDATION' | 'HOST_AUTH_FAILED',
  message: string,
  details?: Record<string, unknown>,
): Result<never> {
  return { ok: false, error: { code, message, details } };
}

function liveProject(kind: 'own_server' | 'netlify' = 'own_server'): ProjectRecord {
  const projectId = kind === 'own_server' ? 'project-own' : 'project-free';
  const targetId = `${projectId}-target`;
  return {
    id: projectId,
    name: kind === 'own_server' ? 'Studio portfolio' : 'Launch page',
    folderPath: kind === 'own_server' ? 'C:\\Projects\\studio' : 'C:\\Projects\\launch-page',
    createdAt: '2026-09-01T09:00:00.000Z',
    stack: { type: 'static', framework: 'vite', outputDir: 'dist', needsBackend: false },
    target: {
      id: targetId,
      kind,
      appName: 'studio-portfolio',
      domain: kind === 'own_server' ? 'studio.example.test' : undefined,
      ip: kind === 'own_server' ? '192.0.2.18' : undefined,
      adminUser: kind === 'own_server' ? 'deploy' : undefined,
      sshPort: kind === 'own_server' ? 22 : undefined,
      siteUrl: kind === 'own_server' ? 'https://studio.example.test' : 'https://launch-page.netlify.app',
      siteId: kind === 'netlify' ? 'site-netlify-1' : undefined,
      hostKeyFingerprint: kind === 'own_server' ? 'SHA256:mockFingerprint' : undefined,
    },
    status: 'live',
    lastRelease: {
      id: 'release-live',
      projectId,
      targetId,
      releaseId: '20260925T154500Z',
      status: 'live',
      folderHash: 'mock-folder-hash',
      createdAt: '2026-09-25T15:45:00.000Z',
    },
  };
}

function metrics(projectId: string): MetricSample[] {
  const samples: MetricSample[] = [];
  for (let hour = 23; hour >= 0; hour -= 1) {
    const ts = new Date(Date.parse(NOW) - hour * 3_600_000).toISOString();
    samples.push(
      {
        projectId,
        kind: 'memory',
        value: 42 + (hour % 8),
        unit: '%',
        ts,
        meta: { usedMb: 830, totalMb: 1970 },
      },
      { projectId, kind: 'cpu', value: 18 + (hour % 12), unit: '%', ts },
      { projectId, kind: 'disk', value: 38, unit: '%', ts, meta: { usedBytes: 10_000, totalBytes: 26_000 } },
      { projectId, kind: 'response_ms', value: 90 + (hour % 25), unit: 'ms', ts },
      { projectId, kind: 'requests', value: 20 + (hour % 11), unit: 'count', ts },
    );
  }
  return samples;
}

function initialAccount(scenario: MockScenario): AccountStatus {
  if (scenario === 'fresh') {
    return { exists: false, unlocked: false, onboardingComplete: false, autoLockMinutes: 15 };
  }
  return {
    exists: true,
    unlocked: scenario !== 'locked',
    onboardingComplete: !['locked'].includes(scenario),
    displayName: 'Ada',
    email: 'ada@example.test',
    autoLockMinutes: 15,
  };
}

function initialBob(scenario: MockScenario): BobStatus {
  if (scenario === 'bob-missing') {
    return { configured: false, keySaved: false, teamIdSet: false, licenseAccepted: false };
  }
  return {
    configured: true,
    keySaved: true,
    keyType: 'inference',
    teamIdSet: false,
    binaryPath: '/usr/local/bin/bob',
    bobVersion: '1.4.0',
    nodeVersion: '22.15.0',
    licenseAccepted: true,
    lastCheckAt: NOW,
    lastCheckOk: true,
  };
}

export interface MockCoreOptions {
  delay?: number | [number, number];
  siteUrl?: string;
  dnsResolved?: string[];
}

export class MockCore implements IpcTransport {
  readonly scenario: MockScenario;
  private account: AccountStatus;
  private bob: BobStatus;
  private settings: AppSettings = {
    autoLockMinutes: 15,
    theme: 'system',
    pollIntervals: DEFAULT_POLL_INTERVALS,
  };
  private projects: ProjectRecord[];
  private hosts: HostTokenStatus[] = [
    { host: 'netlify', connected: true, accountName: 'Ada Example', savedAt: NOW },
    { host: 'vercel', connected: false },
  ];
  private jobs = new Map<string, JobSummary>();
  private jobSteps = new Map<string, JobStepView[]>();
  private pendingQuestions = new Map<string, JobQuestion>();
  private events = new Map<string, JobEvent[]>();
  private envKeys = new Map<string, string[]>();
  private problems: ProblemRecord[] = [];
  private readonly listeners = new Map<PushEvent, Set<PushListener>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly delay: number | [number, number];
  private readonly dnsResolved?: string[];
  private unlockFailures = 0;

  constructor(scenario: MockScenario = 'live-own-server', options: MockCoreOptions = {}) {
    this.scenario = scenario;
    this.delay = options.delay ?? [150, 600];
    this.dnsResolved = options.dnsResolved;
    this.account = initialAccount(scenario);
    this.bob = initialBob(scenario);
    if (scenario === 'onboarded-empty' || scenario === 'fresh' || scenario === 'locked') this.projects = [];
    else if (scenario === 'live-free-host') this.projects = [liveProject('netlify')];
    else {
      const project = liveProject();
      if (options.siteUrl && project.target) project.target.siteUrl = options.siteUrl;
      if (scenario === 'server-down') project.status = 'down';
      if (scenario === 'failed-update') project.status = 'live';
      this.projects = [project];
    }
    if (scenario === 'failed-update' && this.projects[0]) this.seedFailedUpdate(this.projects[0].id);
  }

  async invoke(channel: IpcChannel, rawPayload: unknown): Promise<unknown> {
    await this.wait();
    const payload = rawPayload as Record<string, unknown> | undefined;

    switch (channel) {
      case 'account:status':
        return ok({ ...this.account });
      case 'account:checkPassword': {
        const password = typeof payload?.password === 'string' ? payload.password : '';
        const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/].filter((pattern) =>
          pattern.test(password),
        ).length;
        const score = Math.min(4, Math.floor(password.length / 6) + Math.floor(variety / 2)) as
          0 | 1 | 2 | 3 | 4;
        return ok({
          ok: password.length >= 12 && score >= 3,
          score,
          warning: password.length < 12 ? 'Use at least 12 characters.' : undefined,
          suggestions: score < 3 ? ['Add another uncommon word.'] : [],
        });
      }
      case 'account:create':
        this.account = {
          exists: true,
          unlocked: true,
          onboardingComplete: false,
          displayName: typeof payload?.displayName === 'string' ? payload.displayName : 'Ada',
          email: typeof payload?.email === 'string' ? payload.email : 'ada@example.test',
          autoLockMinutes: 15,
        };
        return ok({ recoveryCode: RECOVERY_CODE });
      case 'account:unlock':
        if (payload?.password !== KNOWN_PASSWORD) {
          this.unlockFailures += 1;
          if (this.unlockFailures >= 3)
            return fail('TOO_MANY_ATTEMPTS', 'Too many attempts.', { retryAfterSeconds: 30 });
          return fail('BAD_PASSWORD', 'That password is not right.');
        }
        this.unlockFailures = 0;
        this.account.unlocked = true;
        return ok({ ...this.account });
      case 'account:lock':
        this.account.unlocked = false;
        this.emit('account:locked', { reason: 'manual' });
        return ok({ ...this.account });
      case 'account:touch':
        return ok(undefined);
      case 'account:changePassword':
        return payload?.currentPassword === KNOWN_PASSWORD
          ? ok(undefined)
          : fail('BAD_PASSWORD', 'That password is not right.');
      case 'account:recover':
        return (typeof payload?.recoveryCode === 'string' ? payload.recoveryCode : '')
          .replace(/[\s-]/g, '')
          .toUpperCase() === RECOVERY_CODE
          ? ok({ recoveryCode: 'ZYXWVTSRQPNMKJHGFEDCBA9876543210' })
          : { ok: false, error: { code: 'BAD_RECOVERY_CODE', message: 'That recovery code is not right.' } };
      case 'account:regenerateRecoveryCode':
        return payload?.password === KNOWN_PASSWORD
          ? ok({ recoveryCode: RECOVERY_CODE })
          : fail('BAD_PASSWORD', 'That password is not right.');
      case 'account:completeOnboarding':
        this.account.onboardingComplete = true;
        return ok({ ...this.account });
      case 'bob:status':
        return ok({ ...this.bob });
      case 'bob:save': {
        const input = payload as unknown as BobSetupInput;
        this.bob = {
          configured: true,
          keySaved: true,
          keyType: input.keyType,
          teamIdSet: Boolean(input.teamId),
          binaryPath: input.binaryPath ?? '/usr/local/bin/bob',
          bobVersion: '1.4.0',
          nodeVersion: '22.15.0',
          licenseAccepted: input.acceptLicense,
          lastCheckAt: NOW,
          lastCheckOk: input.acceptLicense,
        };
        return ok({ ...this.bob });
      }
      case 'bob:check':
        return ok(this.bobChecks());
      case 'bob:clear':
        this.bob = initialBob('bob-missing');
        return ok({ ...this.bob });
      case 'hosts:status':
        return ok(this.hosts.map((host) => ({ ...host })));
      case 'hosts:saveToken': {
        const host = String(payload?.host) as HostId;
        if (payload?.token === 'bad-token') return fail('HOST_AUTH_FAILED', 'That token was not accepted.');
        const next: HostTokenStatus = {
          host,
          connected: true,
          accountName: host === 'netlify' ? 'Ada Example' : 'ada-example',
          teamId: typeof payload?.teamId === 'string' ? payload.teamId : undefined,
          savedAt: NOW,
        };
        this.hosts = this.hosts.filter((item) => item.host !== host).concat(next);
        return ok(next);
      }
      case 'hosts:revokeToken': {
        const host = String(payload?.host) as HostId;
        const next: HostTokenStatus = { host, connected: false };
        this.hosts = this.hosts.filter((item) => item.host !== host).concat(next);
        return ok(next);
      }
      case 'settings:get':
        return ok({ ...this.settings, pollIntervals: { ...this.settings.pollIntervals } });
      case 'settings:set':
        this.settings = { ...this.settings, ...payload };
        return ok({ ...this.settings });
      case 'security:targetInfo':
        return ok({
          hostKeyFingerprint: 'SHA256:mockFingerprint',
          adminUser: 'deploy',
          publicKey: 'ssh-ed25519 AAAA mock',
        });
      case 'security:revealSshPassphrase':
        return payload?.password === KNOWN_PASSWORD
          ? ok({ passphrase: 'amber-lantern-orbit-meadow-cobalt-river-sparrow' })
          : fail('BAD_PASSWORD', 'That password is not right.');
      case 'security:exportSshKey':
        return payload?.password === KNOWN_PASSWORD
          ? ok({
              privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nmock\n-----END OPENSSH PRIVATE KEY-----\n',
              fileName: 'bob-deploy-mock-site',
              adminUser: 'deploy',
              host: '203.0.113.10',
              sshPort: 22,
            })
          : fail('BAD_PASSWORD', 'That password is not right.');
      case 'projects:list':
        return ok(this.projects.map((project) => ({ ...project })));
      case 'projects:create': {
        const input = payload as unknown as ProjectCreateInput;
        if (this.projects.some((project) => project.folderPath === input.folderPath)) {
          return { ok: false, error: { code: 'CONFLICT', message: 'That folder is already a project.' } };
        }
        const project: ProjectRecord = {
          id: `project-${this.projects.length + 1}`,
          name: input.name,
          folderPath: input.folderPath,
          createdAt: NOW,
          status: 'not_deployed',
        };
        this.projects.push(project);
        return ok(project);
      }
      case 'projects:get': {
        const project = this.project(String(payload?.projectId));
        return project ? ok(project) : fail('NOT_FOUND', 'That project could not be found.');
      }
      case 'projects:remove':
        this.projects = this.projects.filter((project) => project.id !== payload?.projectId);
        return ok(undefined);
      case 'projects:getEnvKeys':
        return ok({ keys: this.envKeys.get(String(payload?.projectId)) ?? [] });
      case 'projects:setEnv': {
        const keys = Object.keys((payload?.env as Record<string, string> | undefined) ?? {});
        this.envKeys.set(String(payload?.projectId), keys);
        return ok({ keys });
      }
      case 'snapshots:list':
        return ok(this.snapshots(String(payload?.projectId)));
      case 'snapshots:restore':
        return ok(undefined);
      case 'dns:check': {
        const ip = String(payload?.ip);
        const domain = String(payload?.domain);
        const resolved = this.dnsResolved ?? [ip];
        return ok({
          domain,
          expectedIp: ip,
          resolved,
          matches: resolved.includes(ip),
          sslipAlternative: `${ip}.sslip.io`,
        });
      }
      case 'deploy:start': {
        const input = payload as unknown as DeployStartInput;
        const kind: JobKind = input.target === 'own_server' ? 'deploy_own_server' : 'deploy_free';
        const project = this.project(input.projectId);
        if (project) {
          project.status = 'deploying';
          project.target =
            input.target === 'own_server'
              ? {
                  id: `${project.id}-target`,
                  kind: 'own_server',
                  appName: project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
                  domain: input.inputs.domain,
                  ip: input.inputs.serverIp,
                  adminUser: input.inputs.adminUser,
                  sshPort: input.inputs.sshPort,
                  siteUrl: `https://${input.inputs.useSslipFallback ? `${input.inputs.serverIp}.sslip.io` : input.inputs.domain}`,
                }
              : {
                  id: `${project.id}-target`,
                  kind: input.inputs.host,
                  appName: input.inputs.siteName,
                  siteId: `site-${input.inputs.host}-${this.jobs.size + 1}`,
                  siteUrl: `https://${input.inputs.siteName}.${input.inputs.host === 'netlify' ? 'netlify.app' : 'vercel.app'}`,
                };
        }
        return ok({ jobId: this.startJob(kind, input.projectId) });
      }
      case 'update:start':
        return ok({ jobId: this.startJob('update', String(payload?.projectId)) });
      case 'rollback:start':
        return ok({ jobId: this.startJob('rollback', String(payload?.projectId)) });
      case 'releases:list':
        return ok(this.releases(String(payload?.projectId)));
      case 'job:list': {
        const projectId = String(payload?.projectId);
        const limit = Number(payload?.limit ?? 20);
        return ok([...this.jobs.values()].filter((job) => job.projectId === projectId).slice(0, limit));
      }
      case 'job:get': {
        const jobId = String(payload?.jobId);
        const job = this.jobs.get(jobId);
        if (!job) return fail('NOT_FOUND', 'That task could not be found.');
        return ok({
          job,
          steps: this.jobSteps.get(jobId) ?? [],
          pendingQuestion: this.pendingQuestions.get(jobId),
        });
      }
      case 'job:subscribe':
        this.playJob(String(payload?.jobId), Number(payload?.fromSeq ?? 0));
        return ok({ lastSeq: this.events.get(String(payload?.jobId))?.at(-1)?.seq ?? 0 });
      case 'job:unsubscribe':
        return ok(undefined);
      case 'job:answer': {
        const answer = payload as unknown as JobAnswer;
        this.pendingQuestions.delete(answer.jobId);
        return ok(undefined);
      }
      case 'job:cancel': {
        const job = this.jobs.get(String(payload?.jobId));
        if (job) job.status = 'cancelled';
        return ok(undefined);
      }
      case 'metrics:latest': {
        const projectId = String(payload?.projectId);
        const kinds = (payload?.kinds as MetricKind[] | undefined) ?? [];
        const all = metrics(projectId);
        return ok(
          kinds
            .map((kind) => [...all].reverse().find((sample) => sample.kind === kind))
            .filter((sample): sample is MetricSample => Boolean(sample)),
        );
      }
      case 'metrics:series':
        return ok(metrics(String(payload?.projectId)).filter((sample) => sample.kind === payload?.kind));
      case 'health:get':
        return ok(this.health());
      case 'analytics:get':
        return ok(this.analytics(String(payload?.projectId), String(payload?.range) as TimeRange));
      case 'maintenance:list':
        return ok(this.maintenance(String(payload?.projectId)));
      case 'maintenance:run':
        return ok({ jobId: this.startJob('maintenance', String(payload?.projectId)) });
      case 'problem:signal': {
        const projectId = String(payload?.projectId);
        const jobId = this.startJob('diagnose', projectId);
        this.problems.push({
          id: `problem-${this.problems.length + 1}`,
          projectId,
          note: String(payload?.note),
          jobId,
          createdAt: NOW,
        });
        return ok({ jobId });
      }
      case 'problems:list':
        return ok(this.problems.filter((problem) => problem.projectId === payload?.projectId));
      default:
        return fail('VALIDATION', `MockCore does not implement ${String(channel)}.`);
    }
  }

  on(event: PushEvent, listener: PushListener): () => void {
    const listeners = this.listeners.get(event) ?? new Set<PushListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener);
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.listeners.clear();
  }

  private wait(): Promise<void> {
    const milliseconds = Array.isArray(this.delay)
      ? this.delay[0] + Math.random() * (this.delay[1] - this.delay[0])
      : this.delay;
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private emit(event: PushEvent, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  private project(projectId: string): ProjectRecord | undefined {
    return this.projects.find((project) => project.id === projectId);
  }

  private bobChecks(): BobCheckResult[] {
    return [
      {
        step: 'binary',
        ok: this.bob.configured,
        message: this.bob.configured ? 'Bob found.' : 'Bob was not found.',
        value: this.bob.bobVersion,
      },
      {
        step: 'node',
        ok: this.bob.configured,
        message: this.bob.configured ? 'Node.js is ready.' : 'Node.js could not be checked.',
        value: this.bob.nodeVersion,
      },
      {
        step: 'license',
        ok: this.bob.licenseAccepted,
        message: this.bob.licenseAccepted ? 'License accepted.' : 'Accept the license to continue.',
      },
      {
        step: 'auth',
        ok: this.bob.keySaved,
        message: this.bob.keySaved ? 'Key works.' : 'Add your Bob API key.',
      },
    ];
  }

  private health(): HealthStatus {
    const down = this.scenario === 'server-down';
    return {
      up: !down,
      httpStatus: down ? 0 : 200,
      responseMs: down ? undefined : 104,
      certDaysLeft: 63,
      failedServices: down ? ['web'] : [],
      checkedAt: NOW,
      stale: down,
    };
  }

  private analytics(projectId: string, range: TimeRange): AnalyticsSummary {
    const free = this.project(projectId)?.target?.kind !== 'own_server';
    return {
      range,
      source: free ? 'provider_dashboard' : 'caddy',
      visits: 438,
      uniqueVisitors: 312,
      topPages: [
        { path: '/', count: 220 },
        { path: '/about', count: 91 },
      ],
      statusCodes: { '2xx': 410, '3xx': 12, '4xx': 14, '5xx': 2 },
      series: Array.from({ length: 24 }, (_, index) => ({
        ts: new Date(Date.parse(NOW) - (23 - index) * 3_600_000).toISOString(),
        visits: 10 + (index % 9),
      })),
      providerDashboardUrl: free ? 'https://app.netlify.com/sites/launch-page' : undefined,
    };
  }

  private maintenance(projectId: string): MaintenanceItem[] {
    if (this.project(projectId)?.target?.kind !== 'own_server') return [];
    return [
      {
        id: 'maintenance-1',
        projectId,
        kind: 'security_patches',
        severity: 'warning',
        title: 'Three updates are ready',
        detail: 'These updates improve server security.',
        actionId: 'apply_security_updates',
        detectedAt: NOW,
      },
    ];
  }

  private snapshots(projectId: string): SnapshotRecord[] {
    return [
      {
        id: 'snapshot-1',
        projectId,
        createdAt: '2026-09-24T12:00:00.000Z',
        reason: 'Before update',
        sizeBytes: 1_240_000,
      },
    ];
  }

  private releases(projectId: string): ReleaseRecord[] {
    const project = this.project(projectId);
    return project?.lastRelease ? [project.lastRelease] : [];
  }

  private startJob(kind: JobKind, projectId: string): string {
    const jobId = `job-${kind}-${this.jobs.size + 1}`;
    const job: JobSummary = {
      id: jobId,
      projectId,
      kind,
      status: 'running',
      startedAt: NOW,
      summary: 'Working on your site',
    };
    this.jobs.set(jobId, job);
    const names =
      kind === 'deploy_own_server'
        ? [
            'Reach server',
            'Check address',
            'Create admin',
            'Secure server',
            'Prepare server',
            'Understand project',
            'Install tools',
            'Set up HTTPS',
            'Publish site',
          ]
        : kind === 'update'
          ? ['Understand changes', 'Ask Bob to prepare a fix', 'Publish update']
          : kind === 'rollback'
            ? ['Choose previous version', 'Restore previous version', 'Check site']
            : ['Understand project', 'Build site', 'Publish site'];
    this.jobSteps.set(
      jobId,
      names.map((name, index) => ({
        id: `step-${index + 1}`,
        name,
        kind: index === 0 ? 'agent' : 'script',
        status: 'pending',
        attempt: 1,
      })),
    );
    const question: JobQuestion | undefined =
      kind === 'deploy_own_server'
        ? {
            questionId: 'fingerprint',
            kind: 'confirm',
            title: 'Confirm this server',
            body: 'The server identity is SHA256:mockFingerprint.',
            confirmLabel: 'Continue',
            cancelLabel: 'Cancel',
          }
        : undefined;
    const events: JobEvent[] = [];
    let seq = 1;
    names.forEach((name, index) => {
      events.push({
        jobId,
        seq: seq++,
        ts: NOW,
        type: 'step_started',
        stepId: `step-${index + 1}`,
        message: name,
      });
      events.push({
        jobId,
        seq: seq++,
        ts: NOW,
        type: 'step_log',
        stepId: `step-${index + 1}`,
        message: `${name} is in progress.`,
      });
      if (index === 0 && question)
        events.push({
          jobId,
          seq: seq++,
          ts: NOW,
          type: 'question',
          stepId: 'step-1',
          message: question.title,
          data: question as unknown as Record<string, unknown>,
        });
      if (kind === 'update' && index === 1) {
        events.push({
          jobId,
          seq: seq++,
          ts: NOW,
          type: 'change',
          stepId: `step-${index + 1}`,
          message: 'Updated one file.',
          data: { change: { kind: 'file', path: 'src/app.ts', action: 'modified' } },
        });
        events.push({
          jobId,
          seq: seq++,
          ts: NOW,
          type: 'change',
          stepId: `step-${index + 1}`,
          message: 'Checked the project.',
          data: { change: { kind: 'command', cmd: 'pnpm test', code: 0 } },
        });
      }
      events.push({
        jobId,
        seq: seq++,
        ts: NOW,
        type: 'step_finished',
        stepId: `step-${index + 1}`,
        message: `${name} finished.`,
      });
    });
    if (kind === 'update' && this.scenario === 'failed-update') {
      events.push({
        jobId,
        seq: seq++,
        ts: NOW,
        type: 'error',
        stepId: 'step-2',
        message: 'The update could not be prepared.',
        data: { code: 'BUILD_FAILED' },
      });
      events.push({
        jobId,
        seq,
        ts: NOW,
        type: 'done',
        message: 'The previous version stayed live.',
        data: { status: 'rolled_back', siteUrl: this.project(projectId)?.target?.siteUrl },
      });
    } else {
      events.push({
        jobId,
        seq,
        ts: NOW,
        type: 'done',
        message: 'Your site is live.',
        data: {
          status: 'succeeded',
          siteUrl: this.project(projectId)?.target?.siteUrl ?? 'https://example.test',
        },
      });
    }
    this.events.set(jobId, events);
    return jobId;
  }

  private playJob(jobId: string, fromSeq: number): void {
    const events = (this.events.get(jobId) ?? []).filter((event) => event.seq > fromSeq);
    events.forEach((event, index) => {
      const timer = setTimeout(
        () => {
          if (event.type === 'question')
            this.pendingQuestions.set(jobId, event.data as unknown as JobQuestion);
          if (event.type === 'done') {
            const job = this.jobs.get(jobId);
            if (job) job.status = String(event.data?.status) as JobStatus;
            const project = job ? this.project(job.projectId) : undefined;
            if (project) project.status = event.data?.status === 'succeeded' ? 'live' : project.status;
          }
          this.emit('job:events', event);
          this.timers.delete(timer);
        },
        (index + 1) * 180,
      );
      this.timers.add(timer);
    });
  }

  private seedFailedUpdate(projectId: string): void {
    const jobId = 'job-failed-update';
    this.jobs.set(jobId, {
      id: jobId,
      projectId,
      kind: 'update',
      status: 'rolled_back',
      startedAt: '2026-09-24T10:00:00.000Z',
      finishedAt: '2026-09-24T10:04:00.000Z',
      summary: 'The update failed, so the previous version stayed live.',
    });
    this.jobSteps.set(jobId, [
      { id: 'step-1', name: 'Build site', kind: 'agent', status: 'failed', attempt: 3 },
    ]);
    this.events.set(jobId, [
      { jobId, seq: 1, ts: NOW, type: 'step_started', stepId: 'step-1', message: 'Build site' },
      { jobId, seq: 2, ts: NOW, type: 'step_log', stepId: 'step-1', message: 'Bob tried a safe fix.' },
      {
        jobId,
        seq: 3,
        ts: NOW,
        type: 'error',
        stepId: 'step-1',
        message: 'The update could not be prepared.',
        data: { code: 'BUILD_FAILED' },
      },
      {
        jobId,
        seq: 4,
        ts: NOW,
        type: 'done',
        message: 'The previous version stayed live.',
        data: { status: 'rolled_back', siteUrl: this.project(projectId)?.target?.siteUrl },
      },
    ]);
  }
}

export function scenarioFromUrl(search = globalThis.location?.search ?? ''): MockScenario {
  const requested = new URLSearchParams(search).get('scenario');
  const scenarios: readonly string[] = [
    'fresh',
    'locked',
    'onboarded-empty',
    'live-own-server',
    'live-free-host',
    'server-down',
    'failed-update',
    'bob-missing',
  ];
  return scenarios.includes(requested ?? '') ? (requested as MockScenario) : 'live-own-server';
}

export function implementedMockChannels(): readonly IpcChannel[] {
  return IPC_CHANNELS;
}
