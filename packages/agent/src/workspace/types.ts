/** One staging copy of a user's project — the only folder Bob (or a local command) may write to. */
export interface StagingWorkspace {
  /** Absolute path to stagingRoot/<uuid>/project. */
  readonly dir: string;
  /** relative path (posix-style, '/' separators) -> sha256 hex, as of the last snapshot taken
   * (createStaging, or the most recent diffStaging call that recomputes it). */
  manifest: Map<string, string>;
  /** Paths skipped while creating the staging copy (symlink escaping the project, or too large),
   * kept for the caller to log. Relative, posix-style. */
  readonly skipped: SkippedEntry[];
}

export interface SkippedEntry {
  path: string;
  reason: 'symlink-outside-project' | 'too-large';
}

export interface DiffResult {
  added: string[];
  modified: string[];
  deleted: string[];
}

export interface GateRejection {
  path: string;
  reason: string;
}

export interface GateResult {
  accepted: DiffResult;
  rejected: GateRejection[];
}

export interface GateRules {
  /** Default 5 MB. */
  maxFileBytes?: number;
  /** Default 200. */
  maxChangedFiles?: number;
  /** Default 20. */
  maxDeletedFiles?: number;
}
