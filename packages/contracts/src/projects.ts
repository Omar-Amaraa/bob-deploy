import type { HostId, StackInfo } from './hosts.js';
import type { PollIntervals } from './metrics.js';

export type ProjectStatus = 'not_deployed' | 'deploying' | 'live' | 'down' | 'error' | 'unknown';
export interface TargetRecord {
  id: string;
  kind: 'own_server' | 'netlify' | 'vercel';
  appName?: string; // slug used on the server, e.g. 'my-site'
  domain?: string;
  ip?: string;
  adminUser?: string;
  sshPort?: number;
  siteUrl?: string;
  siteId?: string;
  hostKeyFingerprint?: string;
}
export interface ProjectRecord {
  id: string;
  name: string;
  folderPath: string;
  createdAt: string;
  stack?: StackInfo;
  target?: TargetRecord;
  status: ProjectStatus;
  lastRelease?: ReleaseRecord;
}
export interface ReleaseRecord {
  id: string;
  projectId: string;
  targetId: string;
  releaseId: string; // releaseId = 'YYYYMMDDTHHMMSSZ'
  status: 'uploaded' | 'live' | 'previous' | 'failed' | 'deleted';
  port?: number;
  folderHash: string;
  createdAt: string;
}
export interface SnapshotRecord {
  id: string;
  projectId: string;
  createdAt: string;
  reason: string;
  sizeBytes: number;
}
export interface ProblemRecord {
  id: string;
  projectId: string;
  note: string;
  jobId: string;
  createdAt: string;
  resolvedAt?: string;
}
export interface ProjectCreateInput {
  folderPath: string;
  name: string;
}

export interface OwnServerInputs {
  domain: string; // lowercase ASCII hostname (punycode for IDN)
  useSslipFallback: boolean;
  serverIp: string; // IPv4
  sshPort: number; // default 22
  rootUser: string; // default 'root' (some providers use 'ubuntu' with sudo)
  rootAuth:
    | { method: 'password'; password: string }
    | { method: 'key'; privateKeyPath: string; keyPassphrase?: string };
  adminUser: string; // default 'deploy'
  acmeEmail: string; // prefilled from the account email
  env: Record<string, string>;
}
export interface FreeHostInputs {
  host: HostId;
  siteName: string;
  env: Record<string, string>;
}
export type DeployStartInput =
  | { projectId: string; target: 'own_server'; inputs: OwnServerInputs }
  | { projectId: string; target: 'free'; inputs: FreeHostInputs };

export interface DnsCheckResult {
  domain: string;
  expectedIp: string;
  resolved: string[];
  matches: boolean;
  sslipAlternative: string;
}

export interface AppSettings {
  autoLockMinutes: number; // 5..240, default 15
  theme: 'system' | 'light' | 'dark';
  pollIntervals: PollIntervals;
  bobBinaryPath?: string;
}
