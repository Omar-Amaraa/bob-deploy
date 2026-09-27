import type Database from 'better-sqlite3';
import { MIGRATION_0001_SQL } from './migrations/0001_init.js';

interface Migration {
  version: number;
  sql: string;
}

/** Ordered by version; add new migrations to the end, never edit a shipped one. */
const MIGRATIONS: Migration[] = [{ version: 1, sql: MIGRATION_0001_SQL }];

const APP_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * Runs every migration the database hasn't seen yet, each inside its own transaction. Refuses to run
 * (throwing an INTERNAL-flavoured error) if the database already reports a schema version newer than
 * this build of the app knows about — that means an older binary opened a database written by a newer
 * one, and blindly continuing could corrupt it.
 */
export function migrate(db: Database.Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );

  const currentVersion =
    (db.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as { v: number | null }).v ?? 0;

  if (currentVersion > APP_SCHEMA_VERSION) {
    throw new Error(
      `INTERNAL: database from a newer app version (schema ${currentVersion}, this build knows up to ${APP_SCHEMA_VERSION})`,
    );
  }

  const insertVersion = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;

    const applyMigration = db.transaction(() => {
      db.exec(migration.sql);
      insertVersion.run(migration.version, new Date().toISOString());
    });
    applyMigration();
  }
}

export { APP_SCHEMA_VERSION };
