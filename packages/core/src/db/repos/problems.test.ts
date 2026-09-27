import { describe, expect, it } from 'vitest';
import { openInMemory } from '../db.js';
import { ProjectsRepo } from './projects.js';
import { JobsRepo } from './jobs.js';
import { ProblemsRepo } from './problems.js';

function seed(db: ReturnType<typeof openInMemory>): { projectId: string; jobId: string } {
  const projectId = new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/demo' }).id;
  const jobId = new JobsRepo(db).create({ projectId, kind: 'diagnose' }, []).job.id;
  return { projectId, jobId };
}

describe('ProblemsRepo', () => {
  it('creates a problem and lists it as open until resolved', () => {
    const db = openInMemory();
    const { projectId, jobId } = seed(db);
    const repo = new ProblemsRepo(db);
    const problem = repo.create({ projectId, note: 'disk almost full', jobId });
    expect(repo.listOpenForProject(projectId)).toHaveLength(1);
    repo.resolve(problem.id);
    expect(repo.listOpenForProject(projectId)).toHaveLength(0);
    expect(repo.listForProject(projectId)).toHaveLength(1);
    db.close();
  });

  it('resolve throws NOT_FOUND for an unknown id', () => {
    const db = openInMemory();
    expect(() => new ProblemsRepo(db).resolve('missing')).toThrowError(/not found/);
    db.close();
  });
});
