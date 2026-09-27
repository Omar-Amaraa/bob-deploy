import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_POLL_INTERVALS,
  MONITOR_COMMANDS,
  type AnalyticsBucket,
  type Clock,
  type HealthStatus,
  type MaintenanceItem,
  type MetricSample,
  type MetricsSink,
  type MonitorContext,
  type RemoteExec,
} from '@bob-deploy/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMonitorService } from './service.js';
import type { SiteCheck, SiteCheckOptions } from './http/checker.js';

const fixtureRoot = join(import.meta.dirname, '..', '..', '..', 'fixtures');
const fixture = (...parts: string[]) => readFileSync(join(fixtureRoot, ...parts), 'utf8');

class FakeClock implements Clock {
  private nextId = 1;
  readonly timers = new Map<number, { fn: () => void; ms: number }>();
  now(): Date { return new Date('2026-09-25T18:00:00.000Z'); }
  setTimeout(fn: () => void, ms: number): unknown { const id = this.nextId++; this.timers.set(id, { fn, ms }); return id; }
  clearTimeout(handle: unknown): void { this.timers.delete(Number(handle)); }
  run(id: number) { const timer = this.timers.get(id); if (!timer) throw new Error('Timer missing'); this.timers.delete(id); timer.fn(); }
}

class FakeSink implements MetricsSink {
  readonly samples: MetricSample[][] = [];
  readonly analytics: AnalyticsBucket[][] = [];
  readonly maintenance: MaintenanceItem[][] = [];
  readonly health: HealthStatus[] = [];
  readonly cursors = new Map<string, string>();
  writeSamples(samples: MetricSample[]): void { this.samples.push(samples); }
  writeAnalytics(buckets: AnalyticsBucket[]): void { this.analytics.push(buckets); }
  setMaintenance(_projectId: string, items: MaintenanceItem[]): void { this.maintenance.push(items); }
  setHealth(_projectId: string, health: HealthStatus): void { this.health.push(health); }
  getCursor(projectId: string, key: string): string | undefined { return this.cursors.get(`${projectId}:${key}`); }
  setCursor(projectId: string, key: string, value: string): void { this.cursors.set(`${projectId}:${key}`, value); }
}

function fakeExec(): RemoteExec & { calls: { cmd: string; sudo?: boolean }[] } {
  const calls: { cmd: string; sudo?: boolean }[] = [];
  return {
    calls,
    exec(cmd, options) {
      calls.push({ cmd, sudo: options?.sudo });
      let stdout = '';
      if (cmd === MONITOR_COMMANDS.resources) stdout = fixture('remote', 'ubuntu-24.04', 'resources', 'disk-nearly-full.txt');
      else if (cmd === MONITOR_COMMANDS.upgradable) stdout = fixture('remote', 'ubuntu-24.04', 'upgradable', 'security-3.txt');
      else if (cmd === MONITOR_COMMANDS.rebootRequired) stdout = fixture('remote', 'ubuntu-24.04', 'reboot-required', 'yes.txt');
      else if (cmd === MONITOR_COMMANDS.releases('demo')) stdout = fixture('remote', 'ubuntu-24.04', 'releases', 'seven.txt');
      else if (cmd === MONITOR_COMMANDS.services('demo')) stdout = fixture('remote', 'ubuntu-24.04', 'services', 'one-failed.txt');
      else if (cmd.startsWith('/usr/local/lib/bob-deploy/bin/bd-read-log')) stdout = fixture('caddy', 'access-rotated-boundary.jsonl');
      return Promise.resolve({ code: 0, stdout, stderr: '' });
    },
    upload() { return Promise.resolve(); },
    close() { return Promise.resolve(); },
  };
}

function ownContext(exec: RemoteExec): MonitorContext {
  return { projectId: 'p1', target: { id: 't1', kind: 'own_server', appName: 'demo' }, siteUrl: 'https://app.example.test', getExec() { return Promise.resolve(exec); } };
}

function freeContext(): MonitorContext {
  return { projectId: 'free', target: { id: 't2', kind: 'netlify' }, siteUrl: 'https://free.example.test', getExec() { return Promise.reject(new Error('must not connect')); } };
}

function setup(siteStatus = 200) {
  const sink = new FakeSink();
  const clock = new FakeClock();
  const logs: string[] = [];
  const checker = vi.fn((_url: string, _options: SiteCheckOptions): Promise<SiteCheck> => Promise.resolve({ status: siteStatus, responseMs: 42, certDaysLeft: 6 }));
  const service = createMonitorService({ sink, clock, intervals: { ...DEFAULT_POLL_INTERVALS, healthMs: 100, resourcesMs: 200, analyticsMs: 300, maintenanceMs: 400 }, log: (message) => logs.push(message), checkSite: checker });
  return { sink, clock, logs, checker, service };
}

beforeEach(() => vi.spyOn(Math, 'random').mockReturnValue(0.5));
afterEach(() => vi.restoreAllMocks());

describe('monitor service', () => {
  it('checks a newly started target immediately', async () => {
    const state = setup();
    state.service.start(freeContext());
    await vi.waitFor(() => expect(state.sink.health).toHaveLength(1));
    expect(state.checker).toHaveBeenCalledWith('https://free.example.test', {
      tlsInsecure: undefined,
      timeoutMs: 10_000,
    });
  });

  it('schedules own-server intervals with ±10% jitter and free-host health only', () => {
    const own = setup();
    own.service.start(ownContext(fakeExec()));
    expect([...own.clock.timers.values()].map((timer) => timer.ms).sort((a, b) => a - b)).toEqual([100, 200, 300, 400]);
    own.service.stopAll();
    expect(own.clock.timers.size).toBe(0);
    const free = setup();
    free.service.start(freeContext());
    expect([...free.clock.timers.values()].map((timer) => timer.ms)).toEqual([100]);
  });

  it('collects resources and all maintenance rules from fixtures', async () => {
    const state = setup();
    state.service.start(ownContext(fakeExec()));
    await state.service.runNow('p1', 'resources');
    expect(state.sink.samples.flat().find((sample) => sample.kind === 'disk')?.value).toBe(93);
    await state.service.runNow('p1', 'maintenance');
    expect(state.sink.maintenance[0]?.map((item) => item.kind)).toEqual(['security_patches', 'reboot_required', 'old_releases', 'disk_nearly_full', 'cert_renewal']);
  });

  it('uses the 20,000-line first read, advances caddy.lastTs, then uses 5,000 lines', async () => {
    const exec = fakeExec();
    const state = setup();
    state.service.start(ownContext(exec));
    await state.service.runNow('p1', 'analytics');
    expect(exec.calls.filter((call) => call.cmd.startsWith('/usr/local/lib/bob-deploy/bin/bd-read-log'))[0])
      .toEqual({ cmd: MONITOR_COMMANDS.accessLog('demo', 20_000), sudo: true });
    expect(state.sink.cursors.get('p1:caddy.lastTs')).toBe('1790215546');
    await state.service.runNow('p1', 'analytics');
    expect(exec.calls.filter((call) => call.cmd.startsWith('/usr/local/lib/bob-deploy/bin/bd-read-log'))[1])
      .toEqual({ cmd: MONITOR_COMMANDS.accessLog('demo', 5_000), sudo: true });
    expect(state.sink.analytics).toHaveLength(1);
  });

  it('writes health, service failures and metric samples', async () => {
    const state = setup();
    state.service.start(ownContext(fakeExec()));
    await state.service.runNow('p1', 'health');
    expect(state.sink.health[0]).toMatchObject({ up: true, stale: false, failedServices: ['bd-demo@worker.service', 'bd-demo@scheduler.service'] });
    expect(state.sink.samples[0]?.map((sample) => sample.kind)).toEqual(['http', 'response_ms', 'cert']);
  });

  it('checks health and certificate maintenance without remote access for a free host', async () => {
    const state = setup();
    state.service.start(freeContext());
    await state.service.runNow('free', 'health');
    expect(state.sink.health[0]?.up).toBe(true);
    expect(state.sink.maintenance[0]?.[0]?.kind).toBe('cert_renewal');
    await state.service.runNow('free', 'resources');
    expect(state.sink.samples).toHaveLength(1);
  });

  it('keeps one run per kind in flight', async () => {
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const state = setup();
    state.checker.mockImplementation(() => wait.then(() => ({ status: 200, responseMs: 1 })));
    state.service.start(freeContext());
    const first = state.service.runNow('free', 'health');
    const second = state.service.runNow('free', 'health');
    expect(state.checker).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.all([first, second]);
  });

  it('backs unreachable health checks off exponentially and marks stale', async () => {
    const state = setup(0);
    state.service.start(freeContext());
    const firstId = [...state.clock.timers.keys()][0];
    expect(firstId).toBeDefined();
    state.clock.run(firstId as number);
    await vi.waitFor(() => expect(state.sink.health).toHaveLength(1));
    await vi.waitFor(() => expect([...state.clock.timers.values()][0]?.ms).toBe(200));
    expect(state.sink.health[0]?.stale).toBe(true);
  });

  it('pauses silently on LOCKED and stop clears one project', async () => {
    const state = setup();
    const locked = ownContext(fakeExec());
    locked.getExec = () => Promise.reject(Object.assign(new Error('locked'), { code: 'LOCKED' }));
    state.service.start(locked);
    await expect(state.service.runNow('p1', 'resources')).rejects.toMatchObject({ code: 'LOCKED' });
    expect(state.clock.timers.size).toBe(0);
    expect(state.logs).toEqual([]);
    state.service.stop('missing');
  });

  it('rejects runNow for a project that is not running', async () => {
    await expect(setup().service.runNow('missing', 'health')).rejects.toThrow('No monitor is running');
  });
});
