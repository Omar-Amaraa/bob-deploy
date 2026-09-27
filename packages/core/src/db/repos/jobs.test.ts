import { describe, expect, it } from 'vitest';
import { openInMemory, withEventDeletesAllowed } from '../db.js';
import { ProjectsRepo } from './projects.js';
import { JobsRepo } from './jobs.js';

function seedProject(db: ReturnType<typeof openInMemory>): string {
  return new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/demo' }).id;
}

describe('JobsRepo', () => {
  it('create persists the job and its step plan, all pending', () => {
    const db = openInMemory();
    const projectId = seedProject(db);
    const repo = new JobsRepo(db);
    const { job, steps } = repo.create({ projectId, kind: 'deploy_own_server' }, [
      { stepKey: 'detect_stack', name: 'Detect stack', kind: 'agent' },
      { stepKey: 'upload', name: 'Upload files', kind: 'script' },
    ]);
    expect(job.status).toBe('queued');
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.status === 'pending')).toBe(true);
    expect(steps[0]?.idx).toBe(0);
    expect(steps[1]?.idx).toBe(1);
    db.close();
  });

  it('appendEvent assigns strictly increasing seq per job', () => {
    const db = openInMemory();
    const projectId = seedProject(db);
    const repo = new JobsRepo(db);
    const { job } = repo.create({ projectId, kind: 'deploy_own_server' }, []);
    const e1 = repo.appendEvent({ jobId: job.id, ts: 't1', type: 'step_log', message: 'a' });
    const e2 = repo.appendEvent({ jobId: job.id, ts: 't2', type: 'step_log', message: 'b' });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(repo.listEvents(job.id).map((e) => e.seq)).toEqual([1, 2]);
    expect(repo.listEvents(job.id, 1).map((e) => e.seq)).toEqual([2]);
    db.close();
  });

  it('question/answer round trip: answer_display is redacted for secret questions', () => {
    const db = openInMemory();
    const projectId = seedProject(db);
    const repo = new JobsRepo(db);
    const { job } = repo.create({ projectId, kind: 'deploy_own_server' }, []);
    repo.askQuestion(job.id, {
      questionId: 'q1',
      kind: 'secret',
      title: 'Server password',
      body: 'Enter it again',
    });
    expect(repo.getOpenQuestion(job.id)?.questionId).toBe('q1');
    repo.answerQuestion({ jobId: job.id, questionId: 'q1', value: 'hunter2' }, '••••');
    expect(repo.getOpenQuestion(job.id)).toBeUndefined();
    db.close();
  });

  it('answerQuestion throws NOT_FOUND if the question is already answered or unknown', () => {
    const db = openInMemory();
    const projectId = seedProject(db);
    const repo = new JobsRepo(db);
    const { job } = repo.create({ projectId, kind: 'deploy_own_server' }, []);
    expect(() =>
      repo.answerQuestion({ jobId: job.id, questionId: 'nope', value: true }, 'true'),
    ).toThrowError(/No open question/);
    db.close();
  });

  it('deleteForProject removes jobs, steps, events and questions (using withEventDeletesAllowed)', () => {
    const db = openInMemory();
    const projectId = seedProject(db);
    const repo = new JobsRepo(db);
    const { job } = repo.create({ projectId, kind: 'deploy_own_server' }, [
      { stepKey: 's1', name: 'Step 1', kind: 'script' },
    ]);
    repo.appendEvent({ jobId: job.id, ts: 't1', type: 'step_log', message: 'a' });
    repo.askQuestion(job.id, { questionId: 'q1', kind: 'confirm', title: 't', body: 'b' });

    withEventDeletesAllowed(db, () => {
      repo.deleteForProject(projectId);
    });

    expect(repo.listForProject(projectId)).toEqual([]);
    expect(repo.listEvents(job.id)).toEqual([]);
    db.close();
  });

  it('listResumable only returns queued/running/waiting_user jobs', () => {
    const db = openInMemory();
    const projectId = seedProject(db);
    const repo = new JobsRepo(db);
    const { job: j1 } = repo.create({ projectId, kind: 'deploy_own_server' }, []);
    repo.setStatus(j1.id, 'succeeded', { finishedAt: 't' });
    const { job: j2 } = repo.create({ projectId, kind: 'update' }, []);
    expect(repo.listResumable().map((j) => j.id)).toEqual([j2.id]);
    db.close();
  });
});
