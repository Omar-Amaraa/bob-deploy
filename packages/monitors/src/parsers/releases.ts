import type { MaintenanceItem } from '@bob-deploy/contracts';

export function parseReleases(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function releasesMaintenance(projectId: string, releases: string[], detectedAt: string): MaintenanceItem | undefined {
  if (releases.length <= 4) return undefined;
  const oldCount = releases.length - 4;
  return { id: `${projectId}:old_releases`, projectId, kind: 'old_releases', severity: 'info', title: 'Old versions can be removed', detail: `${oldCount} old ${oldCount === 1 ? 'version is' : 'versions are'} using disk space.`, actionId: 'clean_old_releases', detectedAt };
}
