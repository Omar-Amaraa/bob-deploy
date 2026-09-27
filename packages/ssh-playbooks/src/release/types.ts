/**
 * ssh-playbooks has no database of its own (that's core's job, wired up in A9); the release
 * procedure needs *some* record of which releases exist for an app and their status so it can
 * clean up old ones and roll back to the right one, so that's expressed as this small interface
 * (CLAUDE.md: every external dependency behind an interface with a fake) for core to implement
 * against its real project store, with FakeReleaseStore below standing in for it in tests.
 */
export type ReleaseStatus = 'live' | 'previous' | 'failed' | 'deleted';

export interface ReleaseRecord {
  id: string;
  status: ReleaseStatus;
  createdAt: string; // ISO 8601
  /** sha256 folder-manifest hash from packageRelease. Optional here (older/fake callers may omit
   * it), but core's real ReleaseStore needs it to satisfy contracts' ReleaseRecord shape. */
  folderHash?: string;
}

export interface ReleaseStore {
  listReleases(app: string): Promise<ReleaseRecord[]>;
  recordRelease(app: string, record: ReleaseRecord): Promise<void>;
  updateReleaseStatus(app: string, releaseId: string, status: ReleaseStatus): Promise<void>;
}

/** In-memory ReleaseStore for unit tests and for any caller that doesn't need persistence beyond
 * a single job run. Never used in production — core owns the real, persisted implementation. */
export class FakeReleaseStore implements ReleaseStore {
  private readonly byApp = new Map<string, ReleaseRecord[]>();

  listReleases(app: string): Promise<ReleaseRecord[]> {
    return Promise.resolve([...(this.byApp.get(app) ?? [])]);
  }

  recordRelease(app: string, record: ReleaseRecord): Promise<void> {
    const list = this.byApp.get(app) ?? [];
    list.push(record);
    this.byApp.set(app, list);
    return Promise.resolve();
  }

  updateReleaseStatus(app: string, releaseId: string, status: ReleaseStatus): Promise<void> {
    const list = this.byApp.get(app) ?? [];
    const record = list.find((r) => r.id === releaseId);
    if (record) record.status = status;
    return Promise.resolve();
  }
}
