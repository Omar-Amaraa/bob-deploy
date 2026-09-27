import { z } from 'zod';
import { PASSWORD_POLICY } from './account.js';
import type {
  AccountStatus,
  ChangePasswordInput,
  CreateAccountInput,
  CreateAccountResult,
  RecoverInput,
} from './account.js';
import type { BobCheckResult, BobSetupInput, BobStatus } from './bob.js';
import type { TimeRange } from './common.js';
import type { HostId, HostTokenStatus, StackInfo } from './hosts.js';
import type { JobAnswer, JobEvent, JobQuestion } from './jobs.js';
import type { IpcChannel, IpcContract } from './ipc.js';
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
  FreeHostInputs,
  OwnServerInputs,
  ProjectCreateInput,
  ProjectRecord,
  ReleaseRecord,
  TargetRecord,
} from './projects.js';
import { domainSchema, envRecordSchema, ipv4Schema, portSchema } from './validation.js';

// -----------------------------------------------------------------------------------------------
// Compile-time helpers: fail the build if a schema's inferred type drifts from its hand-written type.
// -----------------------------------------------------------------------------------------------
export type Expect<T extends true> = T;
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// -----------------------------------------------------------------------------------------------
// Shared enum / literal schemas
// -----------------------------------------------------------------------------------------------
export const hostIdSchema: z.ZodType<HostId> = z.enum(['netlify', 'vercel']);
export const timeRangeSchema: z.ZodType<TimeRange> = z.enum(['24h', '7d', '30d']);
export const metricKindSchema: z.ZodType<MetricKind> = z.enum([
  'http',
  'response_ms',
  'cpu',
  'memory',
  'disk',
  'requests',
  'cert',
]);
export const maintenanceActionIdSchema: z.ZodType<MaintenanceActionId> = z.enum([
  'apply_security_updates',
  'clean_old_releases',
  'renew_certificate',
  'clean_disk',
  'reboot_server',
]);

// -----------------------------------------------------------------------------------------------
// Input schemas
// -----------------------------------------------------------------------------------------------
export const createAccountInputSchema = z.object({
  displayName: z.string().trim().min(1).max(60),
  email: z.string().trim().email().max(254),
  masterPassword: z.string().min(PASSWORD_POLICY.minLength).max(PASSWORD_POLICY.maxLength),
}) satisfies z.ZodType<CreateAccountInput>;
type _CheckCreateAccountInput = Expect<Equal<z.infer<typeof createAccountInputSchema>, CreateAccountInput>>;

export const changePasswordInputSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(PASSWORD_POLICY.minLength).max(PASSWORD_POLICY.maxLength),
}) satisfies z.ZodType<ChangePasswordInput>;
type _CheckChangePasswordInput = Expect<
  Equal<z.infer<typeof changePasswordInputSchema>, ChangePasswordInput>
>;

const CROCKFORD_BASE32 = /^[0-9A-HJKMNP-TV-Z]{32}$/;
export const recoveryCodeSchema = z
  .string()
  .transform((value) => value.toUpperCase().replace(/[\s-]/g, ''))
  .pipe(z.string().regex(CROCKFORD_BASE32, 'Must be a 32-character recovery code'));

export const recoverInputSchema = z.object({
  recoveryCode: recoveryCodeSchema,
  newPassword: z.string().min(PASSWORD_POLICY.minLength).max(PASSWORD_POLICY.maxLength),
}) satisfies z.ZodType<RecoverInput>;
type _CheckRecoverInput = Expect<Equal<z.infer<typeof recoverInputSchema>, RecoverInput>>;

export const bobSetupInputSchema = z.object({
  apiKey: z.string().min(1).optional(),
  keyType: z.enum(['inference', 'general']),
  teamId: z.string().min(1).optional(),
  binaryPath: z.string().min(1).optional(),
  acceptLicense: z.boolean(),
}) satisfies z.ZodType<BobSetupInput>;
type _CheckBobSetupInput = Expect<Equal<z.infer<typeof bobSetupInputSchema>, BobSetupInput>>;

export const projectCreateInputSchema = z.object({
  folderPath: z.string().min(1),
  name: z.string().trim().min(1).max(120),
}) satisfies z.ZodType<ProjectCreateInput>;
type _CheckProjectCreateInput = Expect<Equal<z.infer<typeof projectCreateInputSchema>, ProjectCreateInput>>;

const rootAuthSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('password'), password: z.string().min(1) }),
  z.object({
    method: z.literal('key'),
    privateKeyPath: z.string().min(1),
    keyPassphrase: z.string().min(1).optional(),
  }),
]) satisfies z.ZodType<OwnServerInputs['rootAuth']>;

export const ownServerInputsSchema = z.object({
  domain: domainSchema,
  useSslipFallback: z.boolean(),
  serverIp: ipv4Schema,
  sshPort: portSchema,
  rootUser: z.string().min(1).max(32),
  rootAuth: rootAuthSchema,
  adminUser: z.string().min(1),
  acmeEmail: z.string().trim().email(),
  env: envRecordSchema,
}) satisfies z.ZodType<OwnServerInputs>;
type _CheckOwnServerInputs = Expect<Equal<z.infer<typeof ownServerInputsSchema>, OwnServerInputs>>;

export const freeHostInputsSchema = z.object({
  host: hostIdSchema,
  siteName: z.string().min(1),
  env: envRecordSchema,
}) satisfies z.ZodType<FreeHostInputs>;
type _CheckFreeHostInputs = Expect<Equal<z.infer<typeof freeHostInputsSchema>, FreeHostInputs>>;

export const deployStartInputSchema = z.discriminatedUnion('target', [
  z.object({ projectId: z.string().min(1), target: z.literal('own_server'), inputs: ownServerInputsSchema }),
  z.object({ projectId: z.string().min(1), target: z.literal('free'), inputs: freeHostInputsSchema }),
]) satisfies z.ZodType<DeployStartInput>;
type _CheckDeployStartInput = Expect<Equal<z.infer<typeof deployStartInputSchema>, DeployStartInput>>;

export const jobAnswerSchema = z.object({
  jobId: z.string().min(1),
  questionId: z.string().min(1),
  value: z.union([z.string(), z.boolean()]),
}) satisfies z.ZodType<JobAnswer>;
type _CheckJobAnswer = Expect<Equal<z.infer<typeof jobAnswerSchema>, JobAnswer>>;

export const appSettingsSchema = z.object({
  autoLockMinutes: z.number().int().min(5).max(240),
  theme: z.enum(['system', 'light', 'dark']),
  pollIntervals: z.object({
    healthMs: z.number().int().positive(),
    resourcesMs: z.number().int().positive(),
    analyticsMs: z.number().int().positive(),
    maintenanceMs: z.number().int().positive(),
  }),
  bobBinaryPath: z.string().min(1).optional(),
}) satisfies z.ZodType<AppSettings>;
type _CheckAppSettings = Expect<Equal<z.infer<typeof appSettingsSchema>, AppSettings>>;

export const appSettingsPatchSchema = appSettingsSchema.partial() satisfies z.ZodType<Partial<AppSettings>>;

// -----------------------------------------------------------------------------------------------
// Output schemas (used by the client in dev mode and by tests)
// -----------------------------------------------------------------------------------------------
export const accountStatusSchema = z.object({
  exists: z.boolean(),
  unlocked: z.boolean(),
  onboardingComplete: z.boolean(),
  displayName: z.string().optional(),
  email: z.string().optional(),
  autoLockMinutes: z.number(),
  retryAfterSeconds: z.number().optional(),
}) satisfies z.ZodType<AccountStatus>;
type _CheckAccountStatus = Expect<Equal<z.infer<typeof accountStatusSchema>, AccountStatus>>;

export const createAccountResultSchema = z.object({
  recoveryCode: z.string(),
}) satisfies z.ZodType<CreateAccountResult>;
type _CheckCreateAccountResult = Expect<
  Equal<z.infer<typeof createAccountResultSchema>, CreateAccountResult>
>;

const jobQuestionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

export const jobQuestionSchema = z.object({
  questionId: z.string(),
  kind: z.enum(['confirm', 'choice', 'text', 'secret']),
  title: z.string(),
  body: z.string(),
  options: z.array(jobQuestionOptionSchema).optional(),
  confirmLabel: z.string().optional(),
  cancelLabel: z.string().optional(),
  placeholder: z.string().optional(),
}) satisfies z.ZodType<JobQuestion>;
type _CheckJobQuestion = Expect<Equal<z.infer<typeof jobQuestionSchema>, JobQuestion>>;

export const jobEventSchema = z.object({
  jobId: z.string(),
  seq: z.number().int().positive(),
  ts: z.string(),
  type: z.enum([
    'step_started',
    'step_log',
    'step_finished',
    'question',
    'answer',
    'change',
    'error',
    'done',
  ]),
  stepId: z.string().optional(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<JobEvent>;
type _CheckJobEvent = Expect<Equal<z.infer<typeof jobEventSchema>, JobEvent>>;

export const metricSampleSchema = z.object({
  projectId: z.string(),
  kind: metricKindSchema,
  value: z.number(),
  unit: z.string(),
  ts: z.string(),
  meta: z.record(z.string(), z.number()).optional(),
}) satisfies z.ZodType<MetricSample>;
type _CheckMetricSample = Expect<Equal<z.infer<typeof metricSampleSchema>, MetricSample>>;

export const healthStatusSchema = z.object({
  up: z.boolean(),
  httpStatus: z.number().optional(),
  responseMs: z.number().optional(),
  certDaysLeft: z.number().optional(),
  failedServices: z.array(z.string()),
  checkedAt: z.string().optional(),
  stale: z.boolean(),
}) satisfies z.ZodType<HealthStatus>;
type _CheckHealthStatus = Expect<Equal<z.infer<typeof healthStatusSchema>, HealthStatus>>;

export const analyticsSummarySchema = z.object({
  range: timeRangeSchema,
  source: z.enum(['caddy', 'provider_dashboard', 'unavailable']),
  visits: z.number(),
  uniqueVisitors: z.number(),
  topPages: z.array(z.object({ path: z.string(), count: z.number() })),
  statusCodes: z.record(z.string(), z.number()),
  series: z.array(z.object({ ts: z.string(), visits: z.number() })),
  providerDashboardUrl: z.string().optional(),
}) satisfies z.ZodType<AnalyticsSummary>;
type _CheckAnalyticsSummary = Expect<Equal<z.infer<typeof analyticsSummarySchema>, AnalyticsSummary>>;

export const maintenanceItemSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(['security_patches', 'disk_nearly_full', 'cert_renewal', 'old_releases', 'reboot_required']),
  severity: z.enum(['info', 'warning', 'critical']),
  title: z.string(),
  detail: z.string(),
  actionId: maintenanceActionIdSchema.optional(),
  detectedAt: z.string(),
}) satisfies z.ZodType<MaintenanceItem>;
type _CheckMaintenanceItem = Expect<Equal<z.infer<typeof maintenanceItemSchema>, MaintenanceItem>>;

export const stackInfoSchema = z.object({
  type: z.enum(['static', 'node', 'python']),
  framework: z.string().optional(),
  runtimeVersion: z.string().optional(),
  installCmd: z.string().optional(),
  buildCmd: z.string().optional(),
  startCmd: z.string().optional(),
  outputDir: z.string().optional(),
  port: z.number().optional(),
  healthPath: z.string().optional(),
  needsBackend: z.boolean(),
  notes: z.array(z.string()).optional(),
}) satisfies z.ZodType<StackInfo>;

export const targetRecordSchema = z.object({
  id: z.string(),
  kind: z.enum(['own_server', 'netlify', 'vercel']),
  appName: z.string().optional(),
  domain: z.string().optional(),
  ip: z.string().optional(),
  adminUser: z.string().optional(),
  sshPort: z.number().optional(),
  siteUrl: z.string().optional(),
  siteId: z.string().optional(),
  hostKeyFingerprint: z.string().optional(),
}) satisfies z.ZodType<TargetRecord>;

export const releaseRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  targetId: z.string(),
  releaseId: z.string(),
  status: z.enum(['uploaded', 'live', 'previous', 'failed', 'deleted']),
  port: z.number().optional(),
  folderHash: z.string(),
  createdAt: z.string(),
}) satisfies z.ZodType<ReleaseRecord>;

export const projectRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  folderPath: z.string(),
  createdAt: z.string(),
  stack: stackInfoSchema.optional(),
  target: targetRecordSchema.optional(),
  status: z.enum(['not_deployed', 'deploying', 'live', 'down', 'error', 'unknown']),
  lastRelease: releaseRecordSchema.optional(),
}) satisfies z.ZodType<ProjectRecord>;
type _CheckProjectRecord = Expect<Equal<z.infer<typeof projectRecordSchema>, ProjectRecord>>;

export const bobStatusSchema = z.object({
  configured: z.boolean(),
  keySaved: z.boolean(),
  keyType: z.enum(['inference', 'general']).optional(),
  teamIdSet: z.boolean(),
  binaryPath: z.string().optional(),
  bobVersion: z.string().optional(),
  nodeVersion: z.string().optional(),
  licenseAccepted: z.boolean(),
  lastCheckAt: z.string().optional(),
  lastCheckOk: z.boolean().optional(),
}) satisfies z.ZodType<BobStatus>;
type _CheckBobStatus = Expect<Equal<z.infer<typeof bobStatusSchema>, BobStatus>>;

export const bobCheckResultSchema = z.object({
  step: z.enum(['binary', 'node', 'license', 'auth']),
  ok: z.boolean(),
  message: z.string(),
  value: z.string().optional(),
}) satisfies z.ZodType<BobCheckResult>;
type _CheckBobCheckResult = Expect<Equal<z.infer<typeof bobCheckResultSchema>, BobCheckResult>>;

export const hostTokenStatusSchema = z.object({
  host: hostIdSchema,
  connected: z.boolean(),
  accountName: z.string().optional(),
  teamId: z.string().optional(),
  savedAt: z.string().optional(),
}) satisfies z.ZodType<HostTokenStatus>;
type _CheckHostTokenStatus = Expect<Equal<z.infer<typeof hostTokenStatusSchema>, HostTokenStatus>>;

// -----------------------------------------------------------------------------------------------
// IPC_INPUT_SCHEMAS: one zod schema per channel, void/undefined channels use z.void()
// -----------------------------------------------------------------------------------------------
export const IPC_INPUT_SCHEMAS: { [C in IpcChannel]: z.ZodType<IpcContract[C]['in']> } = {
  'account:status': z.void(),
  'account:checkPassword': z.object({ password: z.string(), userInputs: z.array(z.string()).optional() }),
  'account:create': createAccountInputSchema,
  'account:unlock': z.object({ password: z.string() }),
  'account:lock': z.void(),
  'account:touch': z.void(),
  'account:changePassword': changePasswordInputSchema,
  'account:recover': recoverInputSchema,
  'account:regenerateRecoveryCode': z.object({ password: z.string() }),
  'account:completeOnboarding': z.void(),
  'bob:status': z.void(),
  'bob:save': bobSetupInputSchema,
  'bob:check': z.void(),
  'bob:clear': z.void(),
  'hosts:status': z.void(),
  'hosts:saveToken': z.object({
    host: hostIdSchema,
    token: z.string().min(1),
    teamId: z.string().optional(),
  }),
  'hosts:revokeToken': z.object({ host: hostIdSchema }),
  'settings:get': z.void(),
  'settings:set': appSettingsPatchSchema,
  'security:targetInfo': z.object({ targetId: z.string().min(1) }),
  'security:revealSshPassphrase': z.object({ targetId: z.string().min(1), password: z.string().min(1) }),
  'security:exportSshKey': z.object({ targetId: z.string().min(1), password: z.string().min(1) }),
  'projects:list': z.void(),
  'projects:create': projectCreateInputSchema,
  'projects:get': z.object({ projectId: z.string().min(1) }),
  'projects:remove': z.object({ projectId: z.string().min(1), deleteHistory: z.boolean() }),
  'projects:getEnvKeys': z.object({ projectId: z.string().min(1) }),
  'projects:setEnv': z.object({ projectId: z.string().min(1), env: envRecordSchema }),
  'snapshots:list': z.object({ projectId: z.string().min(1) }),
  'snapshots:restore': z.object({ projectId: z.string().min(1), snapshotId: z.string().min(1) }),
  'dns:check': z.object({ domain: domainSchema, ip: ipv4Schema }),
  'deploy:start': deployStartInputSchema,
  'update:start': z.object({ projectId: z.string().min(1) }),
  'rollback:start': z.object({ projectId: z.string().min(1), releaseId: z.string().optional() }),
  'releases:list': z.object({ projectId: z.string().min(1) }),
  'job:list': z.object({ projectId: z.string().min(1), limit: z.number().int().positive().optional() }),
  'job:get': z.object({ jobId: z.string().min(1) }),
  'job:subscribe': z.object({ jobId: z.string().min(1), fromSeq: z.number().int().nonnegative().optional() }),
  'job:unsubscribe': z.object({ jobId: z.string().min(1) }),
  'job:answer': jobAnswerSchema,
  'job:cancel': z.object({ jobId: z.string().min(1) }),
  'metrics:latest': z.object({ projectId: z.string().min(1), kinds: z.array(metricKindSchema) }),
  'metrics:series': z.object({
    projectId: z.string().min(1),
    kind: metricKindSchema,
    range: timeRangeSchema,
  }),
  'health:get': z.object({ projectId: z.string().min(1) }),
  'analytics:get': z.object({ projectId: z.string().min(1), range: timeRangeSchema }),
  'maintenance:list': z.object({ projectId: z.string().min(1) }),
  'maintenance:run': z.object({ projectId: z.string().min(1), actionId: maintenanceActionIdSchema }),
  'problem:signal': z.object({ projectId: z.string().min(1), note: z.string().min(1) }),
  'problems:list': z.object({ projectId: z.string().min(1) }),
};

// -----------------------------------------------------------------------------------------------
// IPC_OUTPUT_SCHEMAS: only channels with a schema above are validated client-side in dev mode.
// -----------------------------------------------------------------------------------------------
export const IPC_OUTPUT_SCHEMAS: Partial<{ [C in IpcChannel]: z.ZodType<IpcContract[C]['out']> }> = {
  'account:status': accountStatusSchema,
  'account:unlock': accountStatusSchema,
  'account:completeOnboarding': accountStatusSchema,
  'account:create': createAccountResultSchema,
  'account:recover': createAccountResultSchema,
  'account:regenerateRecoveryCode': createAccountResultSchema,
  'bob:status': bobStatusSchema,
  'bob:save': bobStatusSchema,
  'bob:clear': bobStatusSchema,
  'bob:check': z.array(bobCheckResultSchema),
  'hosts:status': z.array(hostTokenStatusSchema),
  'hosts:saveToken': hostTokenStatusSchema,
  'hosts:revokeToken': hostTokenStatusSchema,
  'projects:list': z.array(projectRecordSchema),
  'projects:create': projectRecordSchema,
  'projects:get': projectRecordSchema,
  'health:get': healthStatusSchema,
  'analytics:get': analyticsSummarySchema,
  'maintenance:list': z.array(maintenanceItemSchema),
  'metrics:latest': z.array(metricSampleSchema),
  'metrics:series': z.array(metricSampleSchema),
};
