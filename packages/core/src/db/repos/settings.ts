import type Database from 'better-sqlite3';
import type { AppSettings } from '@bob-deploy/contracts';
import { DEFAULT_POLL_INTERVALS } from '@bob-deploy/contracts';

const SETTINGS_KEY = 'app_settings';

const DEFAULT_SETTINGS: AppSettings = {
  autoLockMinutes: 15,
  theme: 'system',
  pollIntervals: DEFAULT_POLL_INTERVALS,
};

interface SettingsRow {
  key: string;
  value_json: string;
}

export class SettingsRepo {
  constructor(private readonly db: Database.Database) {}

  get(): AppSettings {
    const row = this.db.prepare('SELECT * FROM settings WHERE key = ?').get(SETTINGS_KEY) as
      SettingsRow | undefined;
    if (!row) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.value_json) as Partial<AppSettings>) };
  }

  /** Merges `patch` into the stored settings (shallow merge; nested objects like pollIntervals are replaced whole). */
  update(patch: Partial<AppSettings>): AppSettings {
    const next: AppSettings = { ...this.get(), ...patch };
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json) VALUES (@key, @value_json)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run({ key: SETTINGS_KEY, value_json: JSON.stringify(next) });
    return next;
  }

  /** Generic key/value accessors for internal, non-AppSettings values (e.g. monitor cursors namespaced elsewhere). */
  getRaw(key: string): string | undefined {
    const row = this.db.prepare('SELECT * FROM settings WHERE key = ?').get(key) as SettingsRow | undefined;
    return row?.value_json;
  }

  setRaw(key: string, valueJson: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json) VALUES (@key, @value_json)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run({ key, value_json: valueJson });
  }
}
