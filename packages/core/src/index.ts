export const PACKAGE = '@bob-deploy/core';

export { openDatabase, openInMemory, withEventDeletesAllowed } from './db/db.js';
export { migrate, APP_SCHEMA_VERSION } from './db/migrate.js';
export { deleteProject, type DeleteProjectOptions } from './db/delete-project.js';

export { ProjectsRepo } from './db/repos/projects.js';
export { TargetsRepo, type UpsertTargetInput } from './db/repos/targets.js';
export { ReleasesRepo, type CreateReleaseInput } from './db/repos/releases.js';
export { JobsRepo, type CreateJobInput, type StepPlanEntry, type StepState } from './db/repos/jobs.js';
export { SnapshotsRepo, type CreateSnapshotInput } from './db/repos/snapshots.js';
export { MetricsRepo, RAW_SAMPLE_RETENTION_MS, HOURLY_RETENTION_MS } from './db/repos/metrics.js';
export { ProblemsRepo, type CreateProblemInput } from './db/repos/problems.js';
export { SettingsRepo } from './db/repos/settings.js';

export { newId, nowIso, RepoError } from './util.js';

export { JobEngine, type JobEngineOptions } from './jobs/engine.js';
export {
  StepError,
  type StepContext,
  type StepDef,
  type JobDef,
  type JobFinalFailureContext,
  type JobSecrets,
  type FileChange,
  type CommandChange,
} from './jobs/types.js';

// --- Security primitives (A3) ---
export {
  ARGON2ID_PARAMS,
  CURRENT_KDF_PARAMS,
  BadKeyError,
  deriveKey,
  seal,
  open,
  randomBytes,
  randomInt,
  wipe,
  type KdfParams,
  type Sealed,
} from './security/crypto.js';
export {
  loadWordlist,
  generatePassphrase,
  generateRecoveryCode,
  normalizeRecoveryCode,
  WORDLIST_SIZE,
  BITS_PER_WORD,
  PASSPHRASE_BITS,
  RECOVERY_CODE_BITS,
} from './security/passphrase.js';
export { Redactor } from './security/redactor.js';
export { scorePassword, type PasswordScore } from './security/password-strength.js';
export {
  generateAdminKey,
  parseAdminKey,
  derivePublicKey,
  storeTargetKey,
  SshKeyParseError,
  type GeneratedAdminKey,
  type KeyVault,
} from './security/sshkey.js';

// --- Account / vault (A3) ---
export { AccountService, type AccountServiceOptions } from './account/account-service.js';
export { AccountError } from './account/errors.js';
export {
  SECRET_BOB_API_KEY,
  SECRET_NETLIFY_TOKEN,
  SECRET_VERCEL_TOKEN,
  sshPrivateKeySecretKey,
  sshPassphraseSecretKey,
  projectEnvSecretKey,
} from './account/secret-keys.js';
export { VaultCorruptError, type SecretMap } from './account/vault-file.js';
export { accountFilePath, type AccountFileJson, type WrapJson } from './account/account-file.js';

// --- Logging (A3) ---
export { Logger, type LogLevel } from './logging/logger.js';

// --- createCore / registerIpc (A10) ---
export { createCore } from './create-core.js';
