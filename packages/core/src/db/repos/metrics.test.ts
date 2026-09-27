import { describe, expect, it } from 'vitest';
import { openInMemory } from '../db.js';
import { ProjectsRepo } from './projects.js';
import { MetricsRepo, RAW_SAMPLE_RETENTION_MS } from './metrics.js';

function seedProject(db: ReturnType<typeof openInMemory>): string {
  return new ProjectsRepo(db).create({ name: 'demo', folderPath: '/tmp/demo' }).id;
}

describe('MetricsRepo', () => {
  it('records and lists raw samples since a timestamp', () => {
    const db = openInMemory();
    const projectId = seedProject(db);
    const repo = new MetricsRepo(db);
    repo.record({ projectId, kind: 'cpu', value: 12, unit: '%', ts: '2026-01-01T00:00:00.000Z' });
    repo.record({ projectId, kind: 'cpu', value: 20, unit: '%', ts: '2026-01-01T01:00:00.000Z' });
    expect(repo.listRawSince(projectId, 'cpu', '2026-01-01T00:30:00.000Z')).toHaveLength(1);
    db.close();
  });

  it('runRetention rolls up stale raw samples into metric_hourly and deletes them', () => {
    const db = openInMemory();
    const projectId = seedProject(db);
    const repo = new MetricsRepo(db);
    const oldTs = '2026-01-01T05:00:00.000Z';
    repo.record({ projectId, kind: 'cpu', value: 10, unit: '%', ts: oldTs });
    repo.record({ projectId, kind: 'cpu', value: 30, unit: '%', ts: '2026-01-01T05:10:00.000Z' });

    // Both samples are well within the same hour bucket and both older than the retention window.
    const now = new Date(new Date(oldTs).getTime() + RAW_SAMPLE_RETENTION_MS + 24 * 60 * 60 * 1000);
    repo.runRetention(now);

    expect(repo.listRawSince(projectId, 'cpu', '2000-01-01T00:00:00.000Z')).toHaveLength(0);
    const hourly = repo.listHourly(projectId, 'cpu', '2000-01-01T00:00:00.000Z');
    expect(hourly).toHaveLength(1);
    expect(hourly[0]?.avg).toBe(20);
    expect(hourly[0]?.min).toBe(10);
    expect(hourly[0]?.max).toBe(30);
    expect(hourly[0]?.n).toBe(2);
    db.close();
  });

  it('runRetention merges into an existing hourly bucket rather than overwriting it', () => {
    const db = openInMemory();
    const projectId = seedProject(db);
    const repo = new MetricsRepo(db);
    const t1 = '2026-01-01T05:00:00.000Z';
    repo.record({ projectId, kind: 'cpu', value: 10, unit: '%', ts: t1 });
    repo.runRetention(new Date(new Date(t1).getTime() + RAW_SAMPLE_RETENTION_MS + 60_000));

    const t2 = '2026-01-01T05:30:00.000Z';
    repo.record({ projectId, kind: 'cpu', value: 30, unit: '%', ts: t2 });
    repo.runRetention(new Date(new Date(t2).getTime() + RAW_SAMPLE_RETENTION_MS + 60_000));

    const hourly = repo.listHourly(projectId, 'cpu', '2000-01-01T00:00:00.000Z');
    expect(hourly).toHaveLength(1);
    expect(hourly[0]?.n).toBe(2);
    expect(hourly[0]?.avg).toBe(20);
    db.close();
  });

  it('health status and maintenance items are latest-only per project', () => {
    const db = openInMemory();
    const projectId = seedProject(db);
    const repo = new MetricsRepo(db);
    repo.setHealth(projectId, { up: true, failedServices: [], stale: false });
    repo.setHealth(projectId, { up: false, failedServices: ['bd-demo@1'], stale: false });
    expect(repo.getHealth(projectId)?.up).toBe(false);

    repo.setMaintenanceItems(projectId, []);
    repo.setMaintenanceItems(projectId, [
      {
        id: 'm1',
        projectId,
        kind: 'disk_nearly_full',
        severity: 'warning',
        title: 'Disk nearly full',
        detail: '90% used',
        detectedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(repo.getMaintenanceItems(projectId)).toHaveLength(1);
    db.close();
  });

  it('monitor cursors are per project/key and upsert in place', () => {
    const db = openInMemory();
    const projectId = seedProject(db);
    const repo = new MetricsRepo(db);
    expect(repo.getCursor(projectId, 'access_log')).toBeUndefined();
    repo.setCursor(projectId, 'access_log', '100');
    repo.setCursor(projectId, 'access_log', '200');
    expect(repo.getCursor(projectId, 'access_log')).toBe('200');
    db.close();
  });

  it('deleteForProject clears every metrics-related table for the project', () => {
    const db = openInMemory();
    const projectId = seedProject(db);
    const repo = new MetricsRepo(db);
    repo.record({ projectId, kind: 'cpu', value: 1, unit: '%', ts: '2026-01-01T00:00:00.000Z' });
    repo.setHealth(projectId, { up: true, failedServices: [], stale: false });
    repo.setCursor(projectId, 'k', 'v');
    repo.deleteForProject(projectId);
    expect(repo.listRawSince(projectId, 'cpu', '2000-01-01T00:00:00.000Z')).toEqual([]);
    expect(repo.getHealth(projectId)).toBeUndefined();
    expect(repo.getCursor(projectId, 'k')).toBeUndefined();
    db.close();
  });
});
