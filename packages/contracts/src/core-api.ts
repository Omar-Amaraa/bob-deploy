import type { KeyProtector } from './account.js';
import type { Clock } from './common.js';
import type { HostProvider } from './hosts.js';
import type { IpcHost } from './ipc.js';
import type { CreateMonitorService } from './monitors.js';

export interface CoreOptions {
  dataDir: string; // Electron app.getPath('userData')
  keyProtector: KeyProtector;
  appVersion: string;
  monitorFactory?: CreateMonitorService; // Codex's createMonitorService; a no-op default until M4
  hostProviders?: HostProvider[]; // Codex's netlify + vercel adapters
  clock?: Clock;
}
export interface CoreHandle {
  shutdown(): Promise<void>;
}
// core exports: createCore(opts: CoreOptions): Promise<CoreHandle & { registerIpc(host: IpcHost): void }>
export type CreateCore = (opts: CoreOptions) => Promise<CoreHandle & { registerIpc(host: IpcHost): void }>;
