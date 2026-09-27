import type Database from 'better-sqlite3';
import type { ReleaseRecord } from '@bob-deploy/contracts';
import { newId, nowIso, RepoError } from '../../util.js';

interface ReleaseRow {
  id: string;
  project_id: string;
  target_id: string;
  release_id: string;
  folder_hash: string;
  remote_path: string | null;
  port: number | null;
  status: string;
  created_at: string;
}

function toRecord(row: ReleaseRow): ReleaseRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    targetId: row.target_id,
    releaseId: row.release_id,
    status: row.status as ReleaseRecord['status'],
    ...(row.port !== null ? { port: row.port } : {}),
    folderHash: row.folder_hash,
    createdAt: row.created_at,
  };
}

export interface CreateReleaseInput {
  projectId: string;
  targetId: string;
  releaseId: string; // 'YYYYMMDDTHHMMSSZ'
  folderHash: string;
  remotePath?: string;
  port?: number;
}

export class ReleasesRepo {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateReleaseInput, clockNow?: () => Date): ReleaseRecord {
    const row: ReleaseRow = {
      id: newId(),
      project_id: input.projectId,
      target_id: input.targetId,
      release_id: input.releaseId,
      folder_hash: input.folderHash,
      remote_path: input.remotePath ?? null,
      port: input.port ?? null,
      status: 'uploaded',
      created_at: nowIso(clockNow),
    };
    this.db
      .prepare(
        `INSERT INTO releases (id, project_id, target_id, release_id, folder_hash, remote_path, port, status, created_at)
         VALUES (@id, @project_id, @target_id, @release_id, @folder_hash, @remote_path, @port, @status, @created_at)`,
      )
      .run(row);
    return toRecord(row);
  }

  get(id: string): ReleaseRecord | undefined {
    const row = this.db.prepare('SELECT * FROM releases WHERE id = ?').get(id) as ReleaseRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Internal-only remote path, not part of the ReleaseRecord contract (used by rollback/cleanup steps). */
  getRemotePath(id: string): string | undefined {
    const row = this.db.prepare('SELECT remote_path FROM releases WHERE id = ?').get(id) as
      { remote_path: string | null } | undefined;
    return row?.remote_path ?? undefined;
  }

  listForProject(projectId: string): ReleaseRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM releases WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as ReleaseRow[];
    return rows.map(toRecord);
  }

  getLive(projectId: string): ReleaseRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM releases WHERE project_id = ? AND status = 'live'")
      .get(projectId) as ReleaseRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Looks a release up by its human-readable releaseId ('YYYYMMDDTHHMMSSZ') within one project,
   * rather than the internal UUID id — this is the key ssh-playbooks' ReleaseStore addresses
   * releases by (see core/src/flows/release-store.ts, the adapter between the two). */
  getByReleaseId(projectId: string, releaseId: string): ReleaseRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM releases WHERE project_id = ? AND release_id = ?')
      .get(projectId, releaseId) as ReleaseRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Records the live port once a release actually starts serving traffic (releaseProcedure only
   * learns the port after the fact, well after create()). No-op target: throws NOT_FOUND if the
   * release id doesn't exist. */
  setPort(id: string, port: number): void {
    const result = this.db.prepare('UPDATE releases SET port = ? WHERE id = ?').run(port, id);
    if (result.changes === 0) throw new RepoError('NOT_FOUND', `Release ${id} not found.`);
  }

  setStatus(id: string, status: ReleaseRecord['status']): void {
    const result = this.db.prepare('UPDATE releases SET status = ? WHERE id = ?').run(status, id);
    if (result.changes === 0) throw new RepoError('NOT_FOUND', `Release ${id} not found.`);
  }

  /** Marks the current live release (if any) 'previous', then the given one 'live'. Transactional. */
  promoteToLive(projectId: string, id: string): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare("UPDATE releases SET status = 'previous' WHERE project_id = ? AND status = 'live'")
        .run(projectId);
      const result = this.db.prepare("UPDATE releases SET status = 'live' WHERE id = ?").run(id);
      if (result.changes === 0) throw new RepoError('NOT_FOUND', `Release ${id} not found.`);
    });
    tx();
  }

  deleteForProject(projectId: string): void {
    this.db.prepare('DELETE FROM releases WHERE project_id = ?').run(projectId);
  }
}
