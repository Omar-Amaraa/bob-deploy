import type {
  AccountStatus,
  ChangePasswordInput,
  CreateAccountInput,
  CreateAccountResult,
  PasswordStrength,
  RecoverInput,
} from './account.js';
import type { AgentTaskKind } from './agent.js';
import type { BobCheckResult, BobSetupInput, BobStatus } from './bob.js';
import type { Result, TimeRange } from './common.js';
import type { HostId, HostTokenStatus } from './hosts.js';
import type { JobAnswer, JobEvent, JobQuestion, JobSummary, JobStepView } from './jobs.js';
import type {
  AnalyticsSummary,
  HealthStatus,
  MaintenanceActionId,
  MaintenanceItem,
  MetricKind,
  MetricSample,
} from './metrics.js';
import type {
  AppSettings,
  DeployStartInput,
  DnsCheckResult,
  ProblemRecord,
  ProjectCreateInput,
  ProjectRecord,
  ProjectStatus,
  ReleaseRecord,
  SnapshotRecord,
} from './projects.js';

// AgentTaskKind is part of the contract surface even though it is not referenced by a channel yet.
export type { AgentTaskKind };

export interface IpcContract {
  'account:status': { in: void; out: AccountStatus };
  'account:checkPassword': { in: { password: string; userInputs?: string[] }; out: PasswordStrength };
  'account:create': { in: CreateAccountInput; out: CreateAccountResult };
  'account:unlock': { in: { password: string }; out: AccountStatus };
  'account:lock': { in: void; out: AccountStatus };
  'account:touch': { in: void; out: void };
  'account:changePassword': { in: ChangePasswordInput; out: void };
  'account:recover': { in: RecoverInput; out: CreateAccountResult };
  'account:regenerateRecoveryCode': { in: { password: string }; out: CreateAccountResult };
  'account:completeOnboarding': { in: void; out: AccountStatus };
  'bob:status': { in: void; out: BobStatus };
  'bob:save': { in: BobSetupInput; out: BobStatus };
  'bob:check': { in: void; out: BobCheckResult[] };
  'bob:clear': { in: void; out: BobStatus };
  'hosts:status': { in: void; out: HostTokenStatus[] };
  'hosts:saveToken': { in: { host: HostId; token: string; teamId?: string }; out: HostTokenStatus };
  'hosts:revokeToken': { in: { host: HostId }; out: HostTokenStatus };
  'settings:get': { in: void; out: AppSettings };
  'settings:set': { in: Partial<AppSettings>; out: AppSettings };
  'security:targetInfo': {
    in: { targetId: string };
    out: { hostKeyFingerprint: string; adminUser: string; publicKey: string };
  };
  'security:revealSshPassphrase': { in: { targetId: string; password: string }; out: { passphrase: string } };
  /** DEC-022: the admin SSH private key exactly as stored (OpenSSH format, still encrypted with the
   * key passphrase), so the user can connect from their own machine. Re-verifies the master password. */
  'security:exportSshKey': {
    in: { targetId: string; password: string };
    out: { privateKey: string; fileName: string; adminUser: string; host: string; sshPort: number };
  };
  'projects:list': { in: void; out: ProjectRecord[] };
  'projects:create': { in: ProjectCreateInput; out: ProjectRecord };
  'projects:get': { in: { projectId: string }; out: ProjectRecord };
  'projects:remove': { in: { projectId: string; deleteHistory: boolean }; out: void };
  'projects:getEnvKeys': { in: { projectId: string }; out: { keys: string[] } };
  'projects:setEnv': { in: { projectId: string; env: Record<string, string> }; out: { keys: string[] } };
  'snapshots:list': { in: { projectId: string }; out: SnapshotRecord[] };
  'snapshots:restore': { in: { projectId: string; snapshotId: string }; out: void };
  'dns:check': { in: { domain: string; ip: string }; out: DnsCheckResult };
  'deploy:start': { in: DeployStartInput; out: { jobId: string } };
  'update:start': { in: { projectId: string }; out: { jobId: string } };
  'rollback:start': { in: { projectId: string; releaseId?: string }; out: { jobId: string } };
  'releases:list': { in: { projectId: string }; out: ReleaseRecord[] };
  'job:list': { in: { projectId: string; limit?: number }; out: JobSummary[] };
  'job:get': {
    in: { jobId: string };
    out: { job: JobSummary; steps: JobStepView[]; pendingQuestion?: JobQuestion };
  };
  'job:subscribe': { in: { jobId: string; fromSeq?: number }; out: { lastSeq: number } };
  'job:unsubscribe': { in: { jobId: string }; out: void };
  'job:answer': { in: JobAnswer; out: void };
  'job:cancel': { in: { jobId: string }; out: void };
  'metrics:latest': { in: { projectId: string; kinds: MetricKind[] }; out: MetricSample[] };
  'metrics:series': { in: { projectId: string; kind: MetricKind; range: TimeRange }; out: MetricSample[] };
  'health:get': { in: { projectId: string }; out: HealthStatus };
  'analytics:get': { in: { projectId: string; range: TimeRange }; out: AnalyticsSummary };
  'maintenance:list': { in: { projectId: string }; out: MaintenanceItem[] };
  'maintenance:run': { in: { projectId: string; actionId: MaintenanceActionId }; out: { jobId: string } };
  'problem:signal': { in: { projectId: string; note: string }; out: { jobId: string } };
  'problems:list': { in: { projectId: string }; out: ProblemRecord[] };
}
export type IpcChannel = keyof IpcContract;
export const IPC_CHANNELS = [
  'account:status',
  'account:checkPassword',
  'account:create',
  'account:unlock',
  'account:lock',
  'account:touch',
  'account:changePassword',
  'account:recover',
  'account:regenerateRecoveryCode',
  'account:completeOnboarding',
  'bob:status',
  'bob:save',
  'bob:check',
  'bob:clear',
  'hosts:status',
  'hosts:saveToken',
  'hosts:revokeToken',
  'settings:get',
  'settings:set',
  'security:targetInfo',
  'security:revealSshPassphrase',
  'security:exportSshKey',
  'projects:list',
  'projects:create',
  'projects:get',
  'projects:remove',
  'projects:getEnvKeys',
  'projects:setEnv',
  'snapshots:list',
  'snapshots:restore',
  'dns:check',
  'deploy:start',
  'update:start',
  'rollback:start',
  'releases:list',
  'job:list',
  'job:get',
  'job:subscribe',
  'job:unsubscribe',
  'job:answer',
  'job:cancel',
  'metrics:latest',
  'metrics:series',
  'health:get',
  'analytics:get',
  'maintenance:list',
  'maintenance:run',
  'problem:signal',
  'problems:list',
] as const satisfies readonly IpcChannel[];

// Compile-time completeness check: IPC_CHANNELS must contain every key of IpcContract, and no more.
type _AssertChannelsComplete = Expect<Equal<(typeof IPC_CHANNELS)[number], IpcChannel>>;
type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// Referenced only for the type check above; keeping it exported avoids an unused-type lint warning.
export type { _AssertChannelsComplete };

export interface PushEvents {
  'job:events': JobEvent;
  'account:locked': { reason: 'manual' | 'idle' };
  'project:status': { projectId: string; status: ProjectStatus };
  'metrics:updated': { projectId: string; kinds: MetricKind[] };
}
export type PushEvent = keyof PushEvents;
export const PUSH_EVENTS = [
  'job:events',
  'account:locked',
  'project:status',
  'metrics:updated',
] as const satisfies readonly PushEvent[];

// Renderer side: the preload bridge (Codex) implements this.
export interface IpcTransport {
  invoke(channel: IpcChannel, payload: unknown): Promise<unknown>; // resolves to Result<out>
  on(event: PushEvent, listener: (payload: unknown) => void): () => void;
}
// Main side: app-shell (Codex) adapts ipcMain + webContents into this; core (Claude) registers handlers on it.
export interface IpcHost {
  handle(channel: IpcChannel, handler: (payload: unknown) => Promise<Result<unknown>>): void;
  emit<E extends PushEvent>(event: E, payload: PushEvents[E]): void;
}
