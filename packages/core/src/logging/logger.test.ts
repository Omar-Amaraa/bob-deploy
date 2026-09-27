import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from './logger.js';
import { Redactor } from '../security/redactor.js';
import { FakeClock } from '../testing/fake-clock.js';

let dataDir: string;
let artifactsDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'bd-logger-data-'));
  artifactsDir = mkdtempSync(join(tmpdir(), 'bd-logger-artifacts-'));
  process.env.BD_ARTIFACTS_DIR = artifactsDir;
});

afterEach(() => {
  delete process.env.BD_ARTIFACTS_DIR;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(artifactsDir, { recursive: true, force: true });
});

describe('Logger', () => {
  it('writes JSON-lines to logs/core-YYYY-MM-DD.log under BD_ARTIFACTS_DIR, not dataDir', () => {
    const clock = new FakeClock('2026-03-14T00:00:00.000Z');
    const logger = new Logger(dataDir, new Redactor(), clock);
    logger.info('hello world', { foo: 'bar' });

    const logPath = join(artifactsDir, 'logs', 'core-2026-03-14.log');
    const line = JSON.parse(readFileSync(logPath, 'utf8').trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'info', message: 'hello world', foo: 'bar' });
    expect(existsSync(join(dataDir, 'logs'))).toBe(false); // wrote under BD_ARTIFACTS_DIR, not dataDir
  });

  it('supports debug/info/warn/error levels', () => {
    const clock = new FakeClock('2026-03-14T00:00:00.000Z');
    const logger = new Logger(dataDir, new Redactor(), clock);
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    const lines = readFileSync(join(artifactsDir, 'logs', 'core-2026-03-14.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { level: string });
    expect(lines.map((l) => l.level)).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('passes every message and field through the Redactor before writing', () => {
    const clock = new FakeClock('2026-03-14T00:00:00.000Z');
    const redactor = new Redactor();
    redactor.add('super-secret-token-value');
    const logger = new Logger(dataDir, redactor, clock);

    logger.info('token is super-secret-token-value', { detail: 'also super-secret-token-value here' });

    const raw = readFileSync(join(artifactsDir, 'logs', 'core-2026-03-14.log'), 'utf8');
    expect(raw).not.toContain('super-secret-token-value');
    expect(raw).toContain('[hidden]');
  });

  it('rotates: keeps at most 14 core-YYYY-MM-DD.log files, deleting the oldest', () => {
    const logsDir = join(artifactsDir, 'logs');
    const clock = new FakeClock('2026-03-14T00:00:00.000Z');
    const logger = new Logger(dataDir, new Redactor(), clock);
    // Pre-seed 20 older log files directly (rotation only inspects filenames, not mtimes).
    for (let i = 1; i <= 20; i++) {
      const day = String(i).padStart(2, '0');
      writeFileSync(join(logsDir, `core-2026-01-${day}.log`), '{}\n', 'utf8');
    }
    logger.info('trigger rotation check');

    const files = readdirSync(logsDir).filter((f) => /^core-\d{4}-\d{2}-\d{2}\.log$/.test(f));
    expect(files.length).toBe(14);
    // The most recent file (today's) must survive.
    expect(files).toContain('core-2026-03-14.log');
    // The oldest pre-seeded files must have been deleted.
    expect(files).not.toContain('core-2026-01-01.log');
  });
});
