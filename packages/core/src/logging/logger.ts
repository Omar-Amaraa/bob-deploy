import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Redactor } from '../security/redactor.js';
import type { Clock } from '@bob-deploy/contracts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const MAX_LOG_FILES = 14;
const LOG_FILE_PATTERN = /^core-(\d{4}-\d{2}-\d{2})\.log$/;

function dateStamp(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/** JSON-lines file logger. Every message goes through the Redactor before it touches disk. */
export class Logger {
  private readonly logsDir: string;
  private readonly redactor: Redactor;
  private readonly clock: Pick<Clock, 'now'>;

  constructor(dataDir: string, redactor: Redactor, clock: Pick<Clock, 'now'> = { now: () => new Date() }) {
    // Tests write under BD_ARTIFACTS_DIR so real dataDirs (and the repo) never accumulate test logs.
    const root = process.env.BD_ARTIFACTS_DIR ?? dataDir;
    this.logsDir = join(root, 'logs');
    this.redactor = redactor;
    this.clock = clock;
    mkdirSync(this.logsDir, { recursive: true });
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    const now = this.clock.now();
    const redactedMessage = this.redactor.redact(message);
    const redactedFields = fields ? this.redactor.redactDeep(fields) : undefined;
    const line = JSON.stringify({ ts: now.toISOString(), level, message: redactedMessage, ...redactedFields });
    const path = join(this.logsDir, `core-${dateStamp(now)}.log`);
    appendFileSync(path, line + '\n', 'utf8');
    this.rotate();
  }

  /** Keeps at most MAX_LOG_FILES most-recent core-YYYY-MM-DD.log files, deleting the oldest. */
  private rotate(): void {
    const files = readdirSync(this.logsDir)
      .filter((f) => LOG_FILE_PATTERN.test(f))
      .sort(); // filenames are lexicographically date-ordered
    const excess = files.length - MAX_LOG_FILES;
    for (let i = 0; i < excess; i++) {
      unlinkSync(join(this.logsDir, files[i]!));
    }
  }
}
