export { createStaging } from './staging.js';
export { diffStaging, computeManifest } from './diff.js';
export { applyGate, removeStaging } from './gate.js';
export { syncBack } from './sync.js';
export { walkFiles, isEnvFile, EXCLUDED_DIR_NAMES, MAX_FILE_BYTES, toPosix, isWithin, type WalkedFile } from './fs-walk.js';
export type { StagingWorkspace, SkippedEntry, DiffResult, GateResult, GateRejection, GateRules } from './types.js';
