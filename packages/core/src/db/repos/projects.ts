import type Database from 'better-sqlite3';
import type { ProjectCreateInput, ProjectRecord, ProjectStatus, StackInfo } from '@bob-deploy/contracts';
import { newId, nowIso, RepoError } from '../../util.js';

interface ProjectRow {
  id: string;
  name: string;
  folder_path: string;
  stack_json: string | null;
  status: string;
  created_at: string;
}

function toRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    folderPath: row.folder_path,
    createdAt: row.created_at,
    status: row.status as ProjectStatus,
    ...(row.stack_json ? { stack: JSON.parse(row.stack_json) as StackInfo } : {}),
  };
}

export class ProjectsRepo {
  constructor(private readonly db: Database.Database) {}

  create(input: ProjectCreateInput, clockNow?: () => Date): ProjectRecord {
    const existing = this.getByFolderPath(input.folderPath);
    if (existing) {
      throw new RepoError('CONFLICT', 'A project already exists for that folder.');
    }
    const row: ProjectRow = {
      id: newId(),
      name: input.name,
      folder_path: input.folderPath,
      stack_json: null,
      status: 'not_deployed',
      created_at: nowIso(clockNow),
    };
    this.db
      .prepare(
        'INSERT INTO projects (id, name, folder_path, stack_json, status, created_at) VALUES (@id, @name, @folder_path, @stack_json, @status, @created_at)',
      )
      .run(row);
    return toRecord(row);
  }

  get(id: string): ProjectRecord | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  getByFolderPath(folderPath: string): ProjectRecord | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE folder_path = ?').get(folderPath) as
      ProjectRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(): ProjectRecord[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all() as ProjectRow[];
    return rows.map(toRecord);
  }

  setStatus(id: string, status: ProjectStatus): void {
    const result = this.db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(status, id);
    if (result.changes === 0) throw new RepoError('NOT_FOUND', `Project ${id} not found.`);
  }

  setStack(id: string, stack: StackInfo): void {
    const result = this.db
      .prepare('UPDATE projects SET stack_json = ? WHERE id = ?')
      .run(JSON.stringify(stack), id);
    if (result.changes === 0) throw new RepoError('NOT_FOUND', `Project ${id} not found.`);
  }

  /** Renames the folder path, used by deleteProject() to tombstone a history-bearing project. */
  renameFolderPath(id: string, folderPath: string): void {
    this.db.prepare('UPDATE projects SET folder_path = ? WHERE id = ?').run(folderPath, id);
  }

  /** Hard-deletes the row. Callers are responsible for removing dependents first (FK order). */
  hardDelete(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
}
