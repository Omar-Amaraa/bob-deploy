import {
  MONITOR_COMMANDS,
  type CreateMonitorService,
  type HealthStatus,
  type MaintenanceItem,
  type MetricSample,
  type MonitorContext,
  type MonitorService,
  type PollIntervals,
} from '@bob-deploy/contracts';
import { checkSite, type SiteCheck, type SiteCheckOptions } from './http/checker.js';
import { parseAccessLog } from './parsers/caddy.js';
import { certificateMaintenance, diskMaintenance, parseRebootRequired } from './parsers/maintenance.js';
import { parseReleases, releasesMaintenance } from './parsers/releases.js';
import { parseResources } from './parsers/resources.js';
import { parseServices } from './parsers/services.js';
import { parseUpgradable, securityMaintenance } from './parsers/upgradable.js';

type MonitorKind = 'health' | 'resources' | 'analytics' | 'maintenance';
interface Entry {
  ctx: MonitorContext;
  timers: Map<MonitorKind, unknown>;
  inFlight: Map<MonitorKind, Promise<void>>;
  stopped: boolean;
  healthBackoffMs: number;
}

type Dependencies = Parameters<CreateMonitorService>[0] & {
  checkSite?: (url: string, options: SiteCheckOptions) => Promise<SiteCheck>;
};

function isLocked(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'LOCKED';
}

function requireSuccess(result: { code: number; stdout: string; stderr: string }, operation: string): string {
  if (result.code !== 0) throw new Error(`${operation} failed.`);
  return result.stdout;
}

export function createMonitorService(dependencies: Dependencies): MonitorService {
  const { sink, clock, intervals, log } = dependencies;
  const siteChecker = dependencies.checkSite ?? checkSite;
  const projects = new Map<string, Entry>();

  function intervalFor(kind: MonitorKind, values: PollIntervals): number {
    if (kind === 'health') return values.healthMs;
    if (kind === 'resources') return values.resourcesMs;
    if (kind === 'analytics') return values.analyticsMs;
    return values.maintenanceMs;
  }

  function enabled(entry: Entry, kind: MonitorKind): boolean {
    return kind === 'health' || entry.ctx.target.kind === 'own_server';
  }

  function clearEntry(entry: Entry) {
    entry.stopped = true;
    for (const timer of entry.timers.values()) clock.clearTimeout(timer);
    entry.timers.clear();
  }

  function schedule(entry: Entry, kind: MonitorKind) {
    if (entry.stopped || !enabled(entry, kind)) return;
    const normal = intervalFor(kind, intervals);
    const base = kind === 'health' ? Math.max(normal, entry.healthBackoffMs) : normal;
    const delay = Math.max(1, Math.round(base * (0.9 + Math.random() * 0.2)));
    const timer = clock.setTimeout(() => {
      entry.timers.delete(kind);
      void execute(entry, kind).catch((error: unknown) => {
        if (!isLocked(error)) log(`${kind} monitor failed for ${entry.ctx.projectId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }).finally(() => schedule(entry, kind));
    }, delay);
    entry.timers.set(kind, timer);
  }

  async function health(entry: Entry) {
    const checkedAt = clock.now().toISOString();
    const checked = await siteChecker(entry.ctx.siteUrl, { tlsInsecure: entry.ctx.tlsInsecure, timeoutMs: 10_000 });
    let failedServices: string[] = [];
    if (entry.ctx.target.kind === 'own_server') {
      const exec = await entry.ctx.getExec();
      const appName = entry.ctx.target.appName ?? entry.ctx.projectId;
      const result = await exec.exec(MONITOR_COMMANDS.services(appName));
      failedServices = parseServices(requireSuccess(result, 'Service check'));
    }
    const status: HealthStatus = { up: checked.status >= 200 && checked.status < 500, httpStatus: checked.status, responseMs: checked.responseMs, certDaysLeft: checked.certDaysLeft, failedServices, checkedAt, stale: checked.status === 0 };
    sink.setHealth(entry.ctx.projectId, status);
    const samples: MetricSample[] = [
      { projectId: entry.ctx.projectId, kind: 'http', value: checked.status, unit: 'status', ts: checkedAt },
      { projectId: entry.ctx.projectId, kind: 'response_ms', value: checked.responseMs, unit: 'ms', ts: checkedAt },
    ];
    if (checked.certDaysLeft !== undefined) samples.push({ projectId: entry.ctx.projectId, kind: 'cert', value: checked.certDaysLeft, unit: 'days', ts: checkedAt });
    sink.writeSamples(samples);
    if (entry.ctx.target.kind !== 'own_server') {
      const certificate = certificateMaintenance(entry.ctx.projectId, checked.certDaysLeft, checkedAt);
      sink.setMaintenance(entry.ctx.projectId, certificate ? [certificate] : []);
    }
    entry.healthBackoffMs = checked.status === 0 ? Math.min(600_000, Math.max(intervals.healthMs, entry.healthBackoffMs || intervals.healthMs) * 2) : 0;
  }

  async function resources(entry: Entry): Promise<MetricSample[]> {
    const exec = await entry.ctx.getExec();
    const result = await exec.exec(MONITOR_COMMANDS.resources);
    const samples = parseResources(requireSuccess(result, 'Resource check'), clock.now().toISOString(), entry.ctx.projectId);
    sink.writeSamples(samples);
    return samples;
  }

  async function analytics(entry: Entry) {
    const exec = await entry.ctx.getExec();
    const cursor = sink.getCursor(entry.ctx.projectId, 'caddy.lastTs');
    const lines = cursor ? 5_000 : 20_000;
    const appName = entry.ctx.target.appName ?? entry.ctx.projectId;
    const result = await exec.exec(MONITOR_COMMANDS.accessLog(appName, lines), { sudo: true });
    const parsed = parseAccessLog(requireSuccess(result, 'Analytics check'), cursor, entry.ctx.projectId);
    if (parsed.buckets.length) sink.writeAnalytics(parsed.buckets);
    if (parsed.nextCursor) sink.setCursor(entry.ctx.projectId, 'caddy.lastTs', parsed.nextCursor);
  }

  async function maintenance(entry: Entry) {
    const exec = await entry.ctx.getExec();
    const appName = entry.ctx.target.appName ?? entry.ctx.projectId;
    const [upgradesResult, rebootResult, releasesResult, resourceResult] = await Promise.all([
      exec.exec(MONITOR_COMMANDS.upgradable),
      exec.exec(MONITOR_COMMANDS.rebootRequired),
      exec.exec(MONITOR_COMMANDS.releases(appName)),
      exec.exec(MONITOR_COMMANDS.resources),
    ]);
    const detectedAt = clock.now().toISOString();
    const items: (MaintenanceItem | undefined)[] = [
      securityMaintenance(entry.ctx.projectId, parseUpgradable(requireSuccess(upgradesResult, 'Update check')), detectedAt),
      parseRebootRequired(requireSuccess(rebootResult, 'Restart check'), entry.ctx.projectId, detectedAt),
      releasesMaintenance(entry.ctx.projectId, parseReleases(requireSuccess(releasesResult, 'Release check')), detectedAt),
      diskMaintenance(entry.ctx.projectId, parseResources(requireSuccess(resourceResult, 'Disk check'), detectedAt, entry.ctx.projectId), detectedAt),
    ];
    const checked = await siteChecker(entry.ctx.siteUrl, { tlsInsecure: entry.ctx.tlsInsecure, timeoutMs: 10_000 });
    items.push(certificateMaintenance(entry.ctx.projectId, checked.certDaysLeft, detectedAt));
    sink.setMaintenance(entry.ctx.projectId, items.filter((item): item is MaintenanceItem => item !== undefined));
  }

  async function perform(entry: Entry, kind: MonitorKind) {
    if (kind === 'health') await health(entry);
    else if (kind === 'resources') await resources(entry);
    else if (kind === 'analytics') await analytics(entry);
    else await maintenance(entry);
  }

  function execute(entry: Entry, kind: MonitorKind): Promise<void> {
    const current = entry.inFlight.get(kind);
    if (current) return current;
    if (!enabled(entry, kind)) return Promise.resolve();
    const run = perform(entry, kind).catch((error: unknown) => {
      if (isLocked(error)) clearEntry(entry);
      throw error;
    }).finally(() => entry.inFlight.delete(kind));
    entry.inFlight.set(kind, run);
    return run;
  }

  return {
    start(ctx) {
      const existing = projects.get(ctx.projectId);
      if (existing) clearEntry(existing);
      const entry: Entry = { ctx, timers: new Map(), inFlight: new Map(), stopped: false, healthBackoffMs: 0 };
      projects.set(ctx.projectId, entry);
      for (const kind of ['health', 'resources', 'analytics', 'maintenance'] as const) schedule(entry, kind);
      void execute(entry, 'health').catch((error: unknown) => {
        if (!isLocked(error)) {
          log(`health monitor failed for ${entry.ctx.projectId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      });
    },
    stop(projectId) {
      const entry = projects.get(projectId);
      if (!entry) return;
      clearEntry(entry);
      projects.delete(projectId);
    },
    stopAll() {
      for (const entry of projects.values()) clearEntry(entry);
      projects.clear();
    },
    async runNow(projectId, what) {
      const entry = projects.get(projectId);
      if (!entry) throw new Error(`No monitor is running for project ${projectId}.`);
      await execute(entry, what);
    },
  };
}
