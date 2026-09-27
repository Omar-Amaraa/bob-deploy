import type Database from 'better-sqlite3';
import { withEventDeletesAllowed } from './db.js';
import { ProjectsRepo } from './repos/projects.js';
import { TargetsRepo } from './repos/targets.js';
import { ReleasesRepo } from './repos/releases.js';
import { JobsRepo } from './repos/jobs.js';
import { SnapshotsRepo } from './repos/snapshots.js';
import { MetricsRepo } from './repos/metrics.js';
import { ProblemsRepo } from './repos/problems.js';
import { RepoError } from '../util.js';

export interface DeleteProjectOptions {
  /**
   * See DEC-A2 in docs/DECISIONS.md.
   * - true:  hard-delete everything for this project — job history (job_events, job_steps,
   *          job_questions, jobs), releases, the target, snapshots' DB rows, metrics/health/
   *          maintenance/monitor-cursor rows, problems, and the project row itself. Irreversible;
   *          the folder path is freed immediately.
   * - false (default): refuse to touch any history-bearing row. Instead, tombstone the project in
   *          place — rename folder_path to `<deleted>/<id>` (freeing the original path for reuse)
   *          and set status to 'unknown' — while every job/release/snapshot/problem stays exactly as
   *          it was, queryable by its existing id. Callers that want to hide tombstoned projects from
   *          a "my projects" list filter on folder_path not starting with '<deleted>/'.
   */
  deleteHistory: boolean;
}

/**
 * Orchestrates deleting (or tombstoning) a project across every table that references it. Does not
 * touch anything on disk (snapshot files, remote server state) — callers are responsible for that
 * before/after calling this, using the paths returned by SnapshotsRepo.getPath()/ReleasesRepo.getRemotePath()
 * while the rows still exist.
 */
export function deleteProject(db: Database.Database, projectId: string, options: DeleteProjectOptions): void {
  const projects = new ProjectsRepo(db);
  const project = projects.get(projectId);
  if (!project) throw new RepoError('NOT_FOUND', `Project ${projectId} not found.`);

  if (options.deleteHistory) {
    const targets = new TargetsRepo(db);
    const releases = new ReleasesRepo(db);
    const jobs = new JobsRepo(db);
    const snapshots = new SnapshotsRepo(db);
    const metrics = new MetricsRepo(db);
    const problems = new ProblemsRepo(db);

    const tx = db.transaction(() => {
      // problems.job_id references jobs(id), so it must go first.
      problems.deleteForProject(projectId);
      withEventDeletesAllowed(db, () => {
        jobs.deleteForProject(projectId);
      });
      releases.deleteForProject(projectId);
      targets.deleteForProject(projectId);
      snapshots.deleteForProject(projectId);
      metrics.deleteForProject(projectId);
      projects.hardDelete(projectId);
    });
    tx();
    return;
  }

  const tombstonePath = `<deleted>/${projectId}`;
  const tx = db.transaction(() => {
    projects.renameFolderPath(projectId, tombstonePath);
    projects.setStatus(projectId, 'unknown');
  });
  tx();
}
