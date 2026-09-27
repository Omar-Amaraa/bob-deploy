import type Database from 'better-sqlite3';
import type { SnapshotRecord } from '@bob-deploy/contracts';
import { newId, nowIso, RepoError } from '../../util.js';

interface SnapshotRow {
  id: string;
  project_id: string;
  path: string;
  created_at: string;
  reason: string;
  size_bytes: number;
}

function toRecord(row: SnapshotRow): SnapshotRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    createdAt: row.created_at,
    reason: row.reason,
    sizeBytes: row.size_bytes,
  };
}

export interface CreateSnapshotInput {
  projectId: string;
  path: string;
  reason: string;
  sizeBytes: number;
}

export class SnapshotsRepo {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateSnapshotInput, clockNow?: () => Date): SnapshotRecord {
    const row: SnapshotRow = {
      id: newId(),
      project_id: input.projectId,
      path: input.path,
      created_at: nowIso(clockNow),
      reason: input.reason,
      size_bytes: input.sizeBytes,
    };
    this.db
      .prepare(
        'INSERT INTO snapshots (id, project_id, path, created_at, reason, size_bytes) VALUES (@id, @project_id, @path, @created_at, @reason, @size_bytes)',
      )
      .run(row);
    return toRecord(row);
  }

  get(id: string): SnapshotRecord | undefined {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as SnapshotRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Internal-only filesystem path, not part of the SnapshotRecord contract. */
  getPath(id: string): string | undefined {
    const row = this.db.prepare('SELECT path FROM snapshots WHERE id = ?').get(id) as
      { path: string } | undefined;
    return row?.path;
  }

  listForProject(projectId: string): SnapshotRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM snapshots WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as SnapshotRow[];
    return rows.map(toRecord);
  }

  delete(id: string): void {
    const result = this.db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
    if (result.changes === 0) throw new RepoError('NOT_FOUND', `Snapshot ${id} not found.`);
  }

  deleteForProject(projectId: string): void {
    this.db.prepare('DELETE FROM snapshots WHERE project_id = ?').run(projectId);
  }
}
