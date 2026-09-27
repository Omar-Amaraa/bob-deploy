import type { MaintenanceItem } from '@bob-deploy/contracts';

export interface UpgradableResult { total: number; security: number; packages: string[] }

export function parseUpgradable(output: string): UpgradableResult {
  const packages = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && line !== 'Listing...' && line.includes('/')).map((line) => line.slice(0, line.indexOf('/'))).filter(Boolean);
  const security = output.split(/\r?\n/).filter((line) => /\/[^\s]*-security\s/.test(line)).length;
  return { total: packages.length, security, packages };
}

export function securityMaintenance(projectId: string, parsed: UpgradableResult, detectedAt: string): MaintenanceItem | undefined {
  if (parsed.security < 1) return undefined;
  return { id: `${projectId}:security_patches`, projectId, kind: 'security_patches', severity: parsed.security >= 20 ? 'critical' : 'warning', title: 'Security updates are ready', detail: `${parsed.security} security ${parsed.security === 1 ? 'update is' : 'updates are'} ready to install.`, actionId: 'apply_security_updates', detectedAt };
}
