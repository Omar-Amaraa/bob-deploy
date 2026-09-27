import type { ReleaseRecord as SshReleaseRecord, ReleaseStore } from '@bob-deploy/ssh-playbooks';
import type { Clock } from '@bob-deploy/contracts';
import type { ReleasesRepo } from '../db/repos/releases.js';

/**
 * Adapts core's persisted ReleasesRepo to ssh-playbooks' ReleaseStore interface (CLAUDE.md: every
 * external dependency behind an interface with a fake — ssh-playbooks already has FakeReleaseStore
 * for its own unit tests; this is the real, persisted implementation core wires in for actual
 * deploy/update/rollback jobs).
 *
 * The two sides key releases differently: ssh-playbooks addresses a release purely by its
 * human-readable releaseId string ('YYYYMMDDTHHMMSSZ', used as `.id`) and has no concept of a
 * project or target beyond the opaque `app` string it always passes back unchanged; core's
 * ReleasesRepo keys rows by an internal UUID and stores the releaseId as a separate column scoped
 * to one project (which in turn has exactly one target, per TargetsRepo's one-target-per-project
 * invariant). So one CoreReleaseStore is constructed per job, bound to that job's project (and
 * implicitly its single target), and every call re-resolves the internal row by releaseId as
 * needed — cheap, since a project only ever has a handful of releases at once (old ones are
 * pruned by releaseProcedure's cleanupOldReleases).
 *
 * ssh-playbooks always calls recordRelease with an initial `status: 'failed'` placeholder
 * immediately after packaging succeeds (only promoted to 'live'/'previous' once health checks
 * pass), but ReleasesRepo.create() always inserts a fresh row as 'uploaded' (core's own initial
 * state) — so recordRelease here does a create() followed immediately by a setStatus() to whatever
 * status the caller actually asked for.
 */
export class CoreReleaseStore implements ReleaseStore {
  constructor(
    private readonly repo: ReleasesRepo,
    private readonly projectId: string,
    private readonly targetId: string,
    private readonly clock: Clock,
  ) {}

  listReleases(_app: string): Promise<SshReleaseRecord[]> {
    const rows = this.repo.listForProject(this.projectId);
    return Promise.resolve(
      rows
        .filter((r): r is typeof r & { status: SshReleaseRecord['status'] } => r.status !== 'uploaded')
        .map((r) => ({
          id: r.releaseId,
          status: r.status,
          createdAt: r.createdAt,
          folderHash: r.folderHash,
        })),
    );
  }

  recordRelease(_app: string, record: SshReleaseRecord): Promise<void> {
    const created = this.repo.create(
      {
        projectId: this.projectId,
        targetId: this.targetId,
        releaseId: record.id,
        folderHash: record.folderHash ?? '',
      },
      () => this.clock.now(),
    );
    this.repo.setStatus(created.id, record.status);
    return Promise.resolve();
  }

  // async (despite no internal await) so a synchronous not-found throw surfaces as a rejection,
  // matching the ReleaseStore interface's Promise<void> contract.
  // eslint-disable-next-line @typescript-eslint/require-await
  async updateReleaseStatus(_app: string, releaseId: string, status: SshReleaseRecord['status']): Promise<void> {
    const existing = this.repo.getByReleaseId(this.projectId, releaseId);
    if (!existing) throw new Error(`INTERNAL: release ${releaseId} not found for project ${this.projectId}`);
    this.repo.setStatus(existing.id, status);
  }
}
