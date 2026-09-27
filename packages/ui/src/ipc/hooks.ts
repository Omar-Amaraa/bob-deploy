import type { AppError, MetricKind, Result, TimeRange } from '@bob-deploy/contracts';
import { useQuery } from '@tanstack/react-query';
import { useIpc } from './context.js';

export class IpcQueryError extends Error {
  readonly appError: AppError;
  constructor(error: AppError) {
    super(error.message);
    this.appError = error;
  }
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new IpcQueryError(result.error);
  return result.data;
}

export function useAccountStatus() {
  const ipc = useIpc();
  return useQuery({ queryKey: ['account'], queryFn: async () => unwrap(await ipc['account:status']()) });
}

export function useProjects() {
  const ipc = useIpc();
  return useQuery({ queryKey: ['projects'], queryFn: async () => unwrap(await ipc['projects:list']()) });
}

export function useSettings() {
  const ipc = useIpc();
  return useQuery({ queryKey: ['settings'], queryFn: async () => unwrap(await ipc['settings:get']()) });
}

export function useBobStatus() {
  const ipc = useIpc();
  return useQuery({ queryKey: ['bob-status'], queryFn: async () => unwrap(await ipc['bob:status']()) });
}

export function useHosts() {
  const ipc = useIpc();
  return useQuery({ queryKey: ['hosts'], queryFn: async () => unwrap(await ipc['hosts:status']()) });
}

export function useTargetInfo(targetId: string) {
  const ipc = useIpc();
  return useQuery({
    queryKey: ['target-info', targetId],
    queryFn: async () => unwrap(await ipc['security:targetInfo']({ targetId })),
    enabled: Boolean(targetId),
  });
}

export function useHealth(projectId: string) {
  const ipc = useIpc();
  return useQuery({
    queryKey: ['project-data', projectId, 'health'],
    queryFn: async () => unwrap(await ipc['health:get']({ projectId })),
    enabled: Boolean(projectId),
  });
}

export function useMetrics(projectId: string, kind: MetricKind, range: TimeRange = '24h') {
  const ipc = useIpc();
  return useQuery({
    queryKey: ['project-data', projectId, 'metrics', kind, range],
    queryFn: async () => unwrap(await ipc['metrics:series']({ projectId, kind, range })),
    enabled: Boolean(projectId),
  });
}

export function useAnalytics(projectId: string, range: TimeRange = '24h') {
  const ipc = useIpc();
  return useQuery({
    queryKey: ['project-data', projectId, 'analytics', range],
    queryFn: async () => unwrap(await ipc['analytics:get']({ projectId, range })),
    enabled: Boolean(projectId),
  });
}

export function useMaintenance(projectId: string) {
  const ipc = useIpc();
  return useQuery({
    queryKey: ['project-data', projectId, 'maintenance'],
    queryFn: async () => unwrap(await ipc['maintenance:list']({ projectId })),
    enabled: Boolean(projectId),
  });
}

export function useJobs(projectId: string, limit = 5) {
  const ipc = useIpc();
  return useQuery({
    queryKey: ['project-data', projectId, 'jobs', limit],
    queryFn: async () => unwrap(await ipc['job:list']({ projectId, limit })),
    enabled: Boolean(projectId),
  });
}

export function useReleases(projectId: string) {
  const ipc = useIpc();
  return useQuery({
    queryKey: ['project-data', projectId, 'releases'],
    queryFn: async () => unwrap(await ipc['releases:list']({ projectId })),
    enabled: Boolean(projectId),
  });
}

export function useSnapshots(projectId: string) {
  const ipc = useIpc();
  return useQuery({
    queryKey: ['project-data', projectId, 'snapshots'],
    queryFn: async () => unwrap(await ipc['snapshots:list']({ projectId })),
    enabled: Boolean(projectId),
  });
}

export function useProblems(projectId: string) {
  const ipc = useIpc();
  return useQuery({
    queryKey: ['project-data', projectId, 'problems'],
    queryFn: async () => unwrap(await ipc['problems:list']({ projectId })),
    enabled: Boolean(projectId),
  });
}
