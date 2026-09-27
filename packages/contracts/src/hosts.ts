export type HostId = 'netlify' | 'vercel';

export interface StackInfo {
  type: 'static' | 'node' | 'python';
  framework?: string; // e.g. 'vite', 'nextjs', 'express', 'flask', 'fastapi', 'django'
  runtimeVersion?: string; // node: '20' | '22' | '24'; python: distro version, e.g. '3.12'
  installCmd?: string; // e.g. 'npm ci', 'pip install -r requirements.txt'
  buildCmd?: string; // e.g. 'npm run build'
  startCmd?: string; // validated by START_CMD_PATTERN in core
  outputDir?: string; // relative, for static output
  port?: number; // port the app listens on if not $PORT-aware
  healthPath?: string; // default '/'
  needsBackend: boolean;
  notes?: string[];
}

export interface HostTokenStatus {
  host: HostId;
  connected: boolean;
  accountName?: string;
  teamId?: string;
  savedAt?: string;
}

export interface HostDeployInput {
  projectDir: string; // staging copy, already built
  outputDir?: string; // absolute path to the static output, when static
  token: string;
  teamId?: string;
  siteName: string;
  siteId?: string; // present on re-deploys
  stack: StackInfo;
  env?: Record<string, string>;
}
export interface HostDeployEvent {
  phase: 'preparing' | 'uploading' | 'building' | 'ready' | 'error';
  message: string; // plain language, no token
  url?: string;
  siteId?: string;
  deployId?: string;
}
export interface HostProvider {
  id: HostId;
  displayName: string;
  tokenPageUrl: string;
  supports(stack: StackInfo): { ok: boolean; reason?: string };
  validateToken(
    token: string,
    teamId?: string,
  ): Promise<{ ok: boolean; accountName?: string; message?: string }>;
  deploy(input: HostDeployInput, signal?: AbortSignal): AsyncIterable<HostDeployEvent>;
}
