import type Database from 'better-sqlite3';
import type { HealthStatus, MaintenanceItem, MetricKind, MetricSample } from '@bob-deploy/contracts';
import { nowIso } from '../../util.js';

interface MetricSampleRow {
  project_id: string;
  kind: string;
  value: number;
  unit: string;
  ts: string;
  meta_json: string | null;
}

interface MetricHourlyRow {
  project_id: string;
  kind: string;
  hour_ts: string;
  avg: number;
  min: number;
  max: number;
  n: number;
}

function toSample(row: MetricSampleRow): MetricSample {
  return {
    projectId: row.project_id,
    kind: row.kind as MetricKind,
    value: row.value,
    unit: row.unit,
    ts: row.ts,
    ...(row.meta_json ? { meta: JSON.parse(row.meta_json) as Record<string, number> } : {}),
  };
}

/** Raw metric_samples older than this are rolled up into metric_hourly and then discarded. */
export const RAW_SAMPLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30d

/** Hourly rollups and analytics_buckets older than this are discarded entirely. */
export const HOURLY_RETENTION_MS = 365 * 24 * 60 * 60 * 1000; // 365d

function hourBucket(ts: string): string {
  const d = new Date(ts);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

export class MetricsRepo {
  constructor(private readonly db: Database.Database) {}

  // --- raw samples ------------------------------------------------

  record(sample: MetricSample): void {
    this.db
      .prepare(
        'INSERT INTO metric_samples (project_id, kind, value, unit, ts, meta_json) VALUES (@project_id, @kind, @value, @unit, @ts, @meta_json)',
      )
      .run({
        project_id: sample.projectId,
        kind: sample.kind,
        value: sample.value,
        unit: sample.unit,
        ts: sample.ts,
        meta_json: sample.meta ? JSON.stringify(sample.meta) : null,
      });
  }

  listRawSince(projectId: string, kind: MetricKind, sinceTs: string): MetricSample[] {
    const rows = this.db
      .prepare('SELECT * FROM metric_samples WHERE project_id = ? AND kind = ? AND ts >= ? ORDER BY ts ASC')
      .all(projectId, kind, sinceTs) as MetricSampleRow[];
    return rows.map(toSample);
  }

  // --- hourly rollups -----------------------------------------------

  listHourly(projectId: string, kind: MetricKind, sinceHourTs: string): MetricHourlyRow[] {
    return this.db
      .prepare(
        'SELECT * FROM metric_hourly WHERE project_id = ? AND kind = ? AND hour_ts >= ? ORDER BY hour_ts ASC',
      )
      .all(projectId, kind, sinceHourTs) as MetricHourlyRow[];
  }

  /**
   * Rolls up every raw sample older than RAW_SAMPLE_RETENTION_MS into metric_hourly (grouped by
   * project/kind/hour, merging into any existing bucket), deletes the raw rows just rolled up, and
   * then prunes hourly rows older than HOURLY_RETENTION_MS. Meant to run periodically (e.g. hourly);
   * safe to call repeatedly and safe to interrupt (each cutoff pass is its own transaction).
   */
  runRetention(now = new Date()): void {
    const rawCutoff = new Date(now.getTime() - RAW_SAMPLE_RETENTION_MS).toISOString();
    const hourlyCutoff = new Date(now.getTime() - HOURLY_RETENTION_MS).toISOString();

    const tx = this.db.transaction(() => {
      const stale = this.db
        .prepare('SELECT * FROM metric_samples WHERE ts < ?')
        .all(rawCutoff) as MetricSampleRow[];

      const buckets = new Map<
        string,
        { project_id: string; kind: string; hour_ts: string; values: number[] }
      >();
      for (const row of stale) {
        const hour_ts = hourBucket(row.ts);
        const key = `${row.project_id}\u0000${row.kind}\u0000${hour_ts}`;
        const bucket = buckets.get(key) ?? {
          project_id: row.project_id,
          kind: row.kind,
          hour_ts,
          values: [],
        };
        bucket.values.push(row.value);
        buckets.set(key, bucket);
      }

      const upsertHourly = this.db.prepare(
        `INSERT INTO metric_hourly (project_id, kind, hour_ts, avg, min, max, n)
         VALUES (@project_id, @kind, @hour_ts, @avg, @min, @max, @n)
         ON CONFLICT(project_id, kind, hour_ts) DO UPDATE SET
           avg = (metric_hourly.avg * metric_hourly.n + excluded.avg * excluded.n) / (metric_hourly.n + excluded.n),
           min = MIN(metric_hourly.min, excluded.min),
           max = MAX(metric_hourly.max, excluded.max),
           n = metric_hourly.n + excluded.n`,
      );
      for (const bucket of buckets.values()) {
        const n = bucket.values.length;
        const avg = bucket.values.reduce((a, b) => a + b, 0) / n;
        upsertHourly.run({
          project_id: bucket.project_id,
          kind: bucket.kind,
          hour_ts: bucket.hour_ts,
          avg,
          min: Math.min(...bucket.values),
          max: Math.max(...bucket.values),
          n,
        });
      }

      this.db.prepare('DELETE FROM metric_samples WHERE ts < ?').run(rawCutoff);
      this.db.prepare('DELETE FROM metric_hourly WHERE hour_ts < ?').run(hourlyCutoff);
      this.db.prepare('DELETE FROM analytics_buckets WHERE hour_ts < ?').run(hourlyCutoff);
    });
    tx();
  }

  recordAnalyticsBucket(bucket: {
    projectId: string;
    hourTs: string;
    path: string;
    status: number;
    count: number;
    visitors: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO analytics_buckets (project_id, hour_ts, path, status, count, visitors)
         VALUES (@project_id, @hour_ts, @path, @status, @count, @visitors)
         ON CONFLICT(project_id, hour_ts, path, status) DO UPDATE SET
           count = excluded.count, visitors = excluded.visitors`,
      )
      .run({
        project_id: bucket.projectId,
        hour_ts: bucket.hourTs,
        path: bucket.path,
        status: bucket.status,
        count: bucket.count,
        visitors: bucket.visitors,
      });
  }

  /** Reads back analytics_buckets for analytics:get — no contracts type is frozen for this row
   * shape (it's an internal repo detail, not packages/contracts), so it's declared locally. */
  listAnalyticsBuckets(
    projectId: string,
    sinceHourTs: string,
  ): { hourTs: string; path: string; status: number; count: number; visitors: number }[] {
    const rows = this.db
      .prepare(
        'SELECT hour_ts, path, status, count, visitors FROM analytics_buckets WHERE project_id = ? AND hour_ts >= ? ORDER BY hour_ts ASC',
      )
      .all(projectId, sinceHourTs) as {
      hour_ts: string;
      path: string;
      status: number;
      count: number;
      visitors: number;
    }[];
    return rows.map((r) => ({ hourTs: r.hour_ts, path: r.path, status: r.status, count: r.count, visitors: r.visitors }));
  }

  // --- health / maintenance (latest-only, keyed by project) -----------

  setHealth(projectId: string, status: HealthStatus, clockNow?: () => Date): void {
    this.db
      .prepare(
        `INSERT INTO health_status (project_id, status_json, checked_at) VALUES (@project_id, @status_json, @checked_at)
         ON CONFLICT(project_id) DO UPDATE SET status_json = excluded.status_json, checked_at = excluded.checked_at`,
      )
      .run({ project_id: projectId, status_json: JSON.stringify(status), checked_at: nowIso(clockNow) });
  }

  getHealth(projectId: string): HealthStatus | undefined {
    const row = this.db
      .prepare('SELECT status_json FROM health_status WHERE project_id = ?')
      .get(projectId) as { status_json: string } | undefined;
    return row ? (JSON.parse(row.status_json) as HealthStatus) : undefined;
  }

  setMaintenanceItems(projectId: string, items: MaintenanceItem[], clockNow?: () => Date): void {
    this.db
      .prepare(
        `INSERT INTO maintenance_items (project_id, item_json, detected_at) VALUES (@project_id, @item_json, @detected_at)
         ON CONFLICT(project_id) DO UPDATE SET item_json = excluded.item_json, detected_at = excluded.detected_at`,
      )
      .run({ project_id: projectId, item_json: JSON.stringify(items), detected_at: nowIso(clockNow) });
  }

  getMaintenanceItems(projectId: string): MaintenanceItem[] {
    const row = this.db
      .prepare('SELECT item_json FROM maintenance_items WHERE project_id = ?')
      .get(projectId) as { item_json: string } | undefined;
    return row ? (JSON.parse(row.item_json) as MaintenanceItem[]) : [];
  }

  // --- monitor cursors (opaque per-project/per-key strings) ------------

  getCursor(projectId: string, key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM monitor_cursors WHERE project_id = ? AND key = ?')
      .get(projectId, key) as { value: string } | undefined;
    return row?.value;
  }

  setCursor(projectId: string, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO monitor_cursors (project_id, key, value) VALUES (@project_id, @key, @value)
         ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value`,
      )
      .run({ project_id: projectId, key, value });
  }

  deleteForProject(projectId: string): void {
    this.db.prepare('DELETE FROM metric_samples WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM metric_hourly WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM analytics_buckets WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM maintenance_items WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM health_status WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM monitor_cursors WHERE project_id = ?').run(projectId);
  }
}
