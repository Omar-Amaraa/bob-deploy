import { describe, expect, it } from 'vitest';
import { openInMemory } from './db.js';
import { deleteProject } from './delete-project.js';
import { ProjectsRepo } from './repos/projects.js';
import { TargetsRepo } from './repos/targets.js';
import { JobsRepo } from './repos/jobs.js';
import { ProblemsRepo } from './repos/problems.js';

function seed(db: ReturnType<typeof openInMemory>) {
  const projects = new ProjectsRepo(db);
  const project = projects.create({ name: 'demo', folderPath: '/tmp/demo' });
  new TargetsRepo(db).upsert({ projectId: project.id, kind: 'own_server' });
  const jobs = new JobsRepo(db);
  const { job } = jobs.create({ projectId: project.id, kind: 'diagnose' }, []);
  jobs.appendEvent({ jobId: job.id, ts: 't1', type: 'step_log', message: 'hello' });
  new ProblemsRepo(db).create({ projectId: project.id, note: 'oops', jobId: job.id });
  return { project, jobId: job.id, projects, jobs };
}

describe('deleteProject', () => {
  it('deleteHistory=false tombstones the project and keeps every history row intact', () => {
    const db = openInMemory();
    const { project, jobId, projects, jobs } = seed(db);

    deleteProject(db, project.id, { deleteHistory: false });

    const after = projects.get(project.id);
    expect(after).toBeDefined();
    expect(after?.folderPath).toBe(`<deleted>/${project.id}`);
    expect(after?.status).toBe('unknown');
    expect(jobs.getSummary(jobId)).toBeDefined();
    expect(jobs.listEvents(jobId)).toHaveLength(1);

    // The original folder path is free again for a brand-new project.
    expect(() => projects.create({ name: 'demo again', folderPath: '/tmp/demo' })).not.toThrow();
    db.close();
  });

  it('deleteHistory=true hard-deletes the project and every dependent row', () => {
    const db = openInMemory();
    const { project, jobId, projects, jobs } = seed(db);

    deleteProject(db, project.id, { deleteHistory: true });

    expect(projects.get(project.id)).toBeUndefined();
    expect(jobs.getSummary(jobId)).toBeUndefined();
    expect(jobs.listEvents(jobId)).toEqual([]);
    db.close();
  });

  it('throws NOT_FOUND for an unknown project id', () => {
    const db = openInMemory();
    expect(() => deleteProject(db, 'missing', { deleteHistory: false })).toThrowError(/not found/);
    db.close();
  });
});
