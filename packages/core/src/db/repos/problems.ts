import type Database from 'better-sqlite3';
import type { ProblemRecord } from '@bob-deploy/contracts';
import { newId, nowIso, RepoError } from '../../util.js';

interface ProblemRow {
  id: string;
  project_id: string;
  note: string;
  job_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

function toRecord(row: ProblemRow): ProblemRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    note: row.note,
    // ProblemRecord.jobId is required in the contract; problems are always created from a job.
    jobId: row.job_id ?? '',
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
  };
}

export interface CreateProblemInput {
  projectId: string;
  note: string;
  jobId: string;
}

export class ProblemsRepo {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateProblemInput, clockNow?: () => Date): ProblemRecord {
    const row: ProblemRow = {
      id: newId(),
      project_id: input.projectId,
      note: input.note,
      job_id: input.jobId,
      created_at: nowIso(clockNow),
      resolved_at: null,
    };
    this.db
      .prepare(
        'INSERT INTO problems (id, project_id, note, job_id, created_at, resolved_at) VALUES (@id, @project_id, @note, @job_id, @created_at, @resolved_at)',
      )
      .run(row);
    return toRecord(row);
  }

  get(id: string): ProblemRecord | undefined {
    const row = this.db.prepare('SELECT * FROM problems WHERE id = ?').get(id) as ProblemRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  listOpenForProject(projectId: string): ProblemRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM problems WHERE project_id = ? AND resolved_at IS NULL ORDER BY created_at DESC')
      .all(projectId) as ProblemRow[];
    return rows.map(toRecord);
  }

  listForProject(projectId: string): ProblemRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM problems WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as ProblemRow[];
    return rows.map(toRecord);
  }

  resolve(id: string, clockNow?: () => Date): void {
    const result = this.db
      .prepare('UPDATE problems SET resolved_at = ? WHERE id = ?')
      .run(nowIso(clockNow), id);
    if (result.changes === 0) throw new RepoError('NOT_FOUND', `Problem ${id} not found.`);
  }

  deleteForProject(projectId: string): void {
    this.db.prepare('DELETE FROM problems WHERE project_id = ?').run(projectId);
  }
}
