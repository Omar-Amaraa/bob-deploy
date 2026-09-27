import type { MaintenanceItem, MetricSample } from '@bob-deploy/contracts';

export function diskMaintenance(projectId: string, samples: MetricSample[], detectedAt: string): MaintenanceItem | undefined {
  const disk = samples.find((sample) => sample.kind === 'disk');
  if (!disk || disk.value < 85) return undefined;
  return { id: `${projectId}:disk_nearly_full`, projectId, kind: 'disk_nearly_full', severity: disk.value >= 95 ? 'critical' : 'warning', title: 'Server disk is nearly full', detail: `${Math.round(disk.value)}% of the server disk is used.`, actionId: 'clean_disk', detectedAt };
}

export function parseRebootRequired(output: string, projectId: string, detectedAt: string): MaintenanceItem | undefined {
  if (output.trim() !== 'yes') return undefined;
  return { id: `${projectId}:reboot_required`, projectId, kind: 'reboot_required', severity: 'info', title: 'Server restart recommended', detail: 'A restart is needed to finish installing updates.', actionId: 'reboot_server', detectedAt };
}

export function certificateMaintenance(projectId: string, certDaysLeft: number | undefined, detectedAt: string): MaintenanceItem | undefined {
  if (certDaysLeft === undefined || certDaysLeft >= 14) return undefined;
  return { id: `${projectId}:cert_renewal`, projectId, kind: 'cert_renewal', severity: certDaysLeft < 3 ? 'critical' : 'warning', title: 'Certificate expires soon', detail: certDaysLeft < 0 ? 'The HTTPS certificate has expired.' : `The HTTPS certificate expires in ${certDaysLeft} ${certDaysLeft === 1 ? 'day' : 'days'}.`, actionId: 'renew_certificate', detectedAt };
}
