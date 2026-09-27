import type { Clock } from './common.js';
import type {
  AnalyticsBucket,
  HealthStatus,
  MaintenanceItem,
  MetricSample,
  PollIntervals,
} from './metrics.js';
import type { TargetRecord } from './projects.js';
import type { RemoteExec } from './remote.js';

export interface MetricsSink {
  writeSamples(samples: MetricSample[]): void;
  writeAnalytics(buckets: AnalyticsBucket[]): void;
  setMaintenance(projectId: string, items: MaintenanceItem[]): void;
  setHealth(projectId: string, health: HealthStatus): void;
  getCursor(projectId: string, key: string): string | undefined; // e.g. last processed log ts
  setCursor(projectId: string, key: string, value: string): void;
}
export interface MonitorContext {
  projectId: string;
  target: TargetRecord;
  siteUrl: string;
  getExec(): Promise<RemoteExec>; // throws AppError LOCKED when the vault is locked
  tlsInsecure?: boolean; // true only in testbed mode
}
export interface MonitorService {
  start(ctx: MonitorContext): void;
  stop(projectId: string): void;
  stopAll(): void;
  runNow(projectId: string, what: 'health' | 'resources' | 'analytics' | 'maintenance'): Promise<void>;
}
export type CreateMonitorService = (deps: {
  sink: MetricsSink;
  clock: Clock;
  intervals: PollIntervals;
  log: (msg: string) => void;
}) => MonitorService;
