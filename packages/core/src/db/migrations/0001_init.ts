// This file's content must stay byte-identical to 0001_init.sql; a unit test enforces it.
export const MIGRATION_0001_SQL = `-- Bob Deploy — migration 0001: initial schema.
-- This file is the human-readable copy of the SQL actually executed by the migration runner
-- (embedded verbatim in migrations/0001_init.ts as MIGRATION_0001_SQL). A unit test asserts the two
-- stay byte-identical, so edit both together.

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder_path TEXT NOT NULL UNIQUE,
  stack_json TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE targets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('own_server', 'netlify', 'vercel')),
  app_name TEXT,
  domain TEXT,
  ip TEXT,
  admin_user TEXT,
  ssh_port INTEGER,
  secret_ref TEXT,
  site_url TEXT,
  site_id TEXT,
  host_key_fingerprint TEXT,
  port_a INTEGER,
  port_b INTEGER,
  tls_mode TEXT NOT NULL DEFAULT 'auto' CHECK (tls_mode IN ('auto', 'internal')),
  created_at TEXT NOT NULL
);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  target_id TEXT NOT NULL REFERENCES targets(id),
  release_id TEXT NOT NULL,
  folder_hash TEXT NOT NULL,
  remote_path TEXT,
  port INTEGER,
  status TEXT NOT NULL CHECK (status IN ('uploaded', 'live', 'previous', 'failed', 'deleted')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_releases_project ON releases(project_id, created_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  inputs_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary TEXT
);
CREATE INDEX idx_jobs_project ON jobs(project_id, started_at);
CREATE INDEX idx_jobs_status ON jobs(status);

CREATE TABLE job_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  idx INTEGER NOT NULL,
  step_key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('script', 'agent')),
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TEXT,
  finished_at TEXT,
  state_json TEXT
);
CREATE UNIQUE INDEX idx_job_steps_job_idx ON job_steps(job_id, idx);

CREATE TABLE job_events (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  step_id TEXT,
  message TEXT NOT NULL,
  data_json TEXT,
  PRIMARY KEY (job_id, seq)
);

-- S8: job_events is append-only. This gate table is populated for the duration of a single call
-- (see withEventDeletesAllowed() in db.ts) to allow a delete, e.g. by deleteProject(); it is emptied
-- again immediately after and is otherwise always empty. SQLite triggers on a persistent table cannot
-- reference a TEMP table, so this has to be a real (non-temp) table rather than per-connection state.
-- A plain UPDATE on job_events is never allowed, regardless of this gate.
CREATE TABLE _allow_event_delete (id INTEGER PRIMARY KEY);

CREATE TRIGGER trg_job_events_no_update
BEFORE UPDATE ON job_events
BEGIN
  SELECT RAISE(ABORT, 'job_events is append-only: UPDATE is not allowed');
END;

CREATE TRIGGER trg_job_events_no_delete
BEFORE DELETE ON job_events
WHEN NOT EXISTS (SELECT 1 FROM _allow_event_delete)
BEGIN
  SELECT RAISE(ABORT, 'job_events is append-only: DELETE is not allowed outside deleteProject()');
END;

CREATE TABLE job_questions (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  question_id TEXT NOT NULL,
  question_json TEXT NOT NULL,
  asked_at TEXT NOT NULL,
  answered_at TEXT,
  answer_display TEXT,
  PRIMARY KEY (job_id, question_id)
);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  size_bytes INTEGER NOT NULL
);

CREATE TABLE metric_samples (
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  ts TEXT NOT NULL,
  meta_json TEXT
);
CREATE INDEX idx_metric_samples_lookup ON metric_samples(project_id, kind, ts);

CREATE TABLE metric_hourly (
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  hour_ts TEXT NOT NULL,
  avg REAL NOT NULL,
  min REAL NOT NULL,
  max REAL NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (project_id, kind, hour_ts)
);

CREATE TABLE analytics_buckets (
  project_id TEXT NOT NULL REFERENCES projects(id),
  hour_ts TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  count INTEGER NOT NULL,
  visitors INTEGER NOT NULL,
  PRIMARY KEY (project_id, hour_ts, path, status)
);

CREATE TABLE maintenance_items (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  item_json TEXT NOT NULL,
  detected_at TEXT NOT NULL
);

CREATE TABLE health_status (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  status_json TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

CREATE TABLE monitor_cursors (
  project_id TEXT NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (project_id, key)
);

CREATE TABLE problems (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  note TEXT NOT NULL,
  job_id TEXT REFERENCES jobs(id),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
`;
