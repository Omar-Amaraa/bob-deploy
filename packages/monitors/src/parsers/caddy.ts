import { createHash } from 'node:crypto';
import type { AnalyticsBucket } from '@bob-deploy/contracts';

interface AccessEntry {
  ts?: number;
  logger?: string;
  msg?: string;
  status?: number;
  request?: {
    client_ip?: string;
    remote_ip?: string;
    uri?: string;
    headers?: { 'User-Agent'?: string[] };
  };
}

export interface AccessLogResult { buckets: AnalyticsBucket[]; nextCursor?: string }

const skippedUserAgent = /bot|crawler|spider|curl|wget|monitor/i;
const staticAsset = /\.(?:js|css|png|jpe?g|svg|ico|woff2|map)$/i;

function visitorHash(ip: string, userAgent: string): string {
  return createHash('sha256').update(`${ip}\0${userAgent}`).digest('hex');
}

export function parseAccessLog(lines: string, sinceTs: string | undefined, projectId = ''): AccessLogResult {
  const since = sinceTs ? Number(sinceTs) : Number.NEGATIVE_INFINITY;
  let newest = Number.isFinite(since) ? since : undefined;
  const groups = new Map<string, { hourTs: string; path: string; status: number; count: number; visitors: Set<string> }>();
  const hourPaths = new Map<string, Set<string>>();

  for (const line of lines.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: AccessEntry;
    try { entry = JSON.parse(line) as AccessEntry; } catch { continue; }
    if (entry.msg !== 'handled request' || !entry.logger?.startsWith('http.log.access') || typeof entry.ts !== 'number') continue;
    newest = newest === undefined ? entry.ts : Math.max(newest, entry.ts);
    if (entry.ts <= since) continue;
    const uri = entry.request?.uri?.split('?')[0] || '/';
    const userAgent = entry.request?.headers?.['User-Agent']?.[0] ?? '';
    if (skippedUserAgent.test(userAgent) || staticAsset.test(uri)) continue;
    const hourTs = new Date(Math.floor(entry.ts / 3600) * 3_600_000).toISOString();
    const paths = hourPaths.get(hourTs) ?? new Set<string>();
    let path = uri;
    if (!paths.has(path) && paths.size >= 200) path = '(other)';
    else paths.add(path);
    hourPaths.set(hourTs, paths);
    const status = typeof entry.status === 'number' ? entry.status : 0;
    const key = `${hourTs}\0${path}\0${status}`;
    const group = groups.get(key) ?? { hourTs, path, status, count: 0, visitors: new Set<string>() };
    group.count += 1;
    const ip = entry.request?.client_ip ?? entry.request?.remote_ip ?? '';
    group.visitors.add(visitorHash(ip, userAgent));
    groups.set(key, group);
  }

  const buckets = [...groups.values()].map(({ visitors, ...group }) => ({ ...group, projectId, visitors: visitors.size })).sort((a, b) => a.hourTs.localeCompare(b.hourTs) || a.path.localeCompare(b.path) || a.status - b.status);
  return { buckets, nextCursor: newest === undefined ? undefined : String(newest) };
}
