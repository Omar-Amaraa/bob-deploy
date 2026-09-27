import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { migrate } from './migrate.js';

function configure(db: Database.Database): Database.Database {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  migrate(db);
  return db;
}

/** Opens (creating if needed) the SQLite file at `file`, with pragmas set and migrations applied. */
export function openDatabase(file: string): Database.Database {
  const db = new DatabaseConstructor(file);
  return configure(db);
}

/** An in-memory database for tests: same schema and pragmas, nothing touches disk. */
export function openInMemory(): Database.Database {
  const db = new DatabaseConstructor(':memory:');
  return configure(db);
}

/**
 * Runs `fn` with row-delete allowed on job_events for its duration, then revokes it again. Used only
 * by deleteProject() — see S8 in docs/security/README.md.
 */
export function withEventDeletesAllowed<T>(db: Database.Database, fn: () => T): T {
  db.exec('INSERT INTO _allow_event_delete (id) VALUES (1)');
  try {
    return fn();
  } finally {
    db.exec('DELETE FROM _allow_event_delete');
  }
}
