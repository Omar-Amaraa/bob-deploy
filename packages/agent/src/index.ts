export const PACKAGE = '@bob-deploy/agent';

export {
  createStaging,
  diffStaging,
  computeManifest,
  applyGate,
  removeStaging,
  syncBack,
  walkFiles,
  isEnvFile,
  EXCLUDED_DIR_NAMES,
  MAX_FILE_BYTES,
  toPosix,
  isWithin,
  type WalkedFile,
  type StagingWorkspace,
  type SkippedEntry,
  type DiffResult,
  type GateResult,
  type GateRejection,
  type GateRules,
} from './workspace/index.js';

export {
  runAllowed,
  splitCommand,
  NODE_ALLOWED,
  PYTHON_ALLOWED,
  PYTHON_ALLOWED_WIN32,
  type RunAllowedOptions,
  type RunAllowedResult,
} from './exec/index.js';

export { detectHeuristic, type HeuristicResult } from './detect/index.js';

export {
  buildPrompt,
  type BuiltPrompt,
  type RedactorLike,
  wrapUntrusted,
  ROLE_AND_RULES,
  RESULT_BEGIN,
  RESULT_END,
  renderOutputContract,
  installPlanSchema,
  fixResultSchema,
  diagnosisSchema,
  stackInfoSchema,
  buildTaskPrompt,
  type TaskPrompt,
  type UntrustedBlock,
} from './prompts/index.js';

export { FakeRunner, editAt, type FakeRunnerResponse, type FakeRunnerScript } from './fake/index.js';

export {
  BobShellRunner,
  type BobShellRunnerOptions,
  type BobShellRunnerConfig,
  type BobRedactor,
  checkBob,
  buildBobArgs,
  type BobArgsConfig,
  classifyBobFailure,
  type BobFailureCode,
  type ClassifiedFailure,
  buildScrubbedEnv,
  BOB_KEY_ENV_VARS,
  type ScrubbedEnvInput,
  resolveBobBinary,
  BobNotInstalledError,
  parseBobOutput,
  type ParseResult,
  type ParseFailureReason,
  runProcess,
  type SpawnFn,
  type RunProcessOptions,
  type RunProcessResult,
} from './bob/index.js';
