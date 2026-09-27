import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { APP_SCHEMA_VERSION, migrate } from './migrate.js';
import { MIGRATION_0001_SQL } from './migrations/0001_init.js';

const sqlPath = fileURLToPath(new URL('./migrations/0001_init.sql', import.meta.url));

describe('migrate', () => {
  it('the .ts migration is byte-identical to the human-readable .sql file', () => {
    const fromDisk = readFileSync(sqlPath, 'utf8');
    expect(MIGRATION_0001_SQL).toBe(fromDisk);
  });

  it('runs on an empty database and creates every table', () => {
    const db = new Database(':memory:');
    migrate(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'projects',
        'targets',
        'releases',
        'jobs',
        'job_steps',
        'job_events',
        'job_questions',
        'snapshots',
        'metric_samples',
        'metric_hourly',
        'analytics_buckets',
        'maintenance_items',
        'health_status',
        'monitor_cursors',
        'problems',
        'settings',
        'schema_migrations',
      ]),
    );
    db.close();
  });

  it('is idempotent: running twice does not error or re-apply', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    const count = (db.prepare('SELECT COUNT(*) as n FROM schema_migrations').get() as { n: number }).n;
    expect(count).toBe(1);
    db.close();
  });

  it('refuses to run against a database from a newer app version', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      APP_SCHEMA_VERSION + 1,
      new Date().toISOString(),
    );
    expect(() => migrate(db)).toThrow(/newer app version/);
    db.close();
  });
});
