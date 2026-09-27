import type { TimeRange } from './common.js';

export type MetricKind = 'http' | 'response_ms' | 'cpu' | 'memory' | 'disk' | 'requests' | 'cert';
// units: http='status' (0 = unreachable), response_ms='ms', cpu='%' (load1/nproc*100, capped 100),
//        memory='%' (meta.usedMb, meta.totalMb), disk='%' (meta.usedBytes, meta.totalBytes),
//        requests='count' (per 5-minute bucket), cert='days'
export interface MetricSample {
  projectId: string;
  kind: MetricKind;
  value: number;
  unit: string;
  ts: string;
  meta?: Record<string, number>;
}
export interface HealthStatus {
  up: boolean;
  httpStatus?: number;
  responseMs?: number;
  certDaysLeft?: number;
  failedServices: string[];
  checkedAt?: string;
  stale: boolean;
}
export interface AnalyticsBucket {
  projectId: string;
  hourTs: string;
  path: string;
  status: number;
  count: number;
  visitors: number;
}
export interface AnalyticsSummary {
  range: TimeRange;
  source: 'caddy' | 'provider_dashboard' | 'unavailable';
  visits: number;
  uniqueVisitors: number;
  topPages: { path: string; count: number }[];
  statusCodes: Record<string, number>; // '2xx' | '3xx' | '4xx' | '5xx'
  series: { ts: string; visits: number }[];
  providerDashboardUrl?: string;
}
export type MaintenanceActionId =
  'apply_security_updates' | 'clean_old_releases' | 'renew_certificate' | 'clean_disk' | 'reboot_server';
export interface MaintenanceItem {
  id: string;
  projectId: string;
  kind: 'security_patches' | 'disk_nearly_full' | 'cert_renewal' | 'old_releases' | 'reboot_required';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  actionId?: MaintenanceActionId;
  detectedAt: string;
}
export interface PollIntervals {
  healthMs: number;
  resourcesMs: number;
  analyticsMs: number;
  maintenanceMs: number;
}
export const DEFAULT_POLL_INTERVALS: PollIntervals = {
  healthMs: 60_000,
  resourcesMs: 60_000,
  analyticsMs: 300_000,
  maintenanceMs: 21_600_000,
};

// Fixed remote commands. Codex records fixtures with exactly these commands.
export const REMOTE_PATHS = { helpers: '/usr/local/lib/bob-deploy/bin', apps: '/srv/apps' } as const;
export const MONITOR_COMMANDS = {
  resources:
    'free -m; echo ---BD---; cat /proc/loadavg; echo ---BD---; nproc; echo ---BD---; cat /proc/uptime; echo ---BD---; df -P -B1 /',
  services: (app: string) => `systemctl list-units 'bd-${app}@*' --all --no-legend --plain --no-pager`,
  upgradable: 'apt list --upgradable 2>/dev/null',
  rebootRequired: 'test -f /var/run/reboot-required && echo yes || echo no',
  releases: (app: string) => `ls -1 /srv/apps/${app}/releases`,
  accessLog: (app: string, lines: number) => `/usr/local/lib/bob-deploy/bin/bd-read-log ${app} ${lines}`, // run with sudo: true
} as const;
