import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { certificateDaysLeft } from './http/checker.js';
import { parseAccessLog } from './parsers/caddy.js';
import { ParseError } from './parsers/errors.js';
import { certificateMaintenance, diskMaintenance, parseRebootRequired } from './parsers/maintenance.js';
import { parseReleases, releasesMaintenance } from './parsers/releases.js';
import { parseResources } from './parsers/resources.js';
import { parseServices } from './parsers/services.js';
import { parseUpgradable, securityMaintenance } from './parsers/upgradable.js';

const fixtures = join(import.meta.dirname, '..', '..', '..', 'fixtures');
const read = (...parts: string[]) => readFileSync(join(fixtures, ...parts), 'utf8');
const now = '2026-09-25T18:00:00.000Z';

for (const ubuntu of ['ubuntu-22.04', 'ubuntu-24.04']) {
  describe(ubuntu, () => {
    for (const name of ['normal', 'high-memory', 'disk-nearly-full', 'high-load', 'tiny-vps-512mb', 'swap-heavy']) {
      it(`parses resources/${name}.txt`, () => {
        const samples = parseResources(read('remote', ubuntu, 'resources', `${name}.txt`), now, 'p1');
        expect(samples).toHaveLength(3);
        expect(samples.every((sample) => Number.isFinite(sample.value))).toBe(true);
        if (name === 'high-memory') expect(samples.find((sample) => sample.kind === 'memory')?.value).toBeGreaterThan(91.9);
        if (name === 'disk-nearly-full') expect(samples.find((sample) => sample.kind === 'disk')?.value).toBe(93);
        if (name === 'high-load') expect(samples.find((sample) => sample.kind === 'cpu')?.value).toBe(100);
      });
    }

    it('parses every services fixture', () => {
      expect(parseServices(read('remote', ubuntu, 'services', 'all-running.txt'))).toEqual([]);
      expect(parseServices(read('remote', ubuntu, 'services', 'none.txt'))).toEqual([]);
      expect(parseServices(read('remote', ubuntu, 'services', 'one-failed.txt'))).toEqual(['bd-demo@worker.service', 'bd-demo@scheduler.service']);
    });

    it('parses every upgrade fixture', () => {
      expect(parseUpgradable(read('remote', ubuntu, 'upgradable', 'none.txt'))).toEqual({ total: 0, security: 0, packages: [] });
      const security = parseUpgradable(read('remote', ubuntu, 'upgradable', 'security-3.txt'));
      expect(security).toMatchObject({ total: 5, security: 3 });
      expect(security.packages).toContain('libssl3t64');
      expect(parseUpgradable(read('remote', ubuntu, 'upgradable', 'many-120.txt')).total).toBe(120);
    });

    it('parses every reboot and release fixture', () => {
      expect(parseRebootRequired(read('remote', ubuntu, 'reboot-required', 'yes.txt'), 'p1', now)?.actionId).toBe('reboot_server');
      expect(parseRebootRequired(read('remote', ubuntu, 'reboot-required', 'no.txt'), 'p1', now)).toBeUndefined();
      expect(parseReleases(read('remote', ubuntu, 'releases', 'empty.txt'))).toEqual([]);
      expect(parseReleases(read('remote', ubuntu, 'releases', 'three.txt'))).toHaveLength(3);
      const seven = parseReleases(read('remote', ubuntu, 'releases', 'seven.txt'));
      expect(seven).toHaveLength(7);
      expect(releasesMaintenance('p1', seven, now)?.actionId).toBe('clean_old_releases');
    });
  });
}

describe('maintenance rules', () => {
  it('applies count and threshold severities', () => {
    expect(securityMaintenance('p', { total: 1, security: 0, packages: [] }, now)).toBeUndefined();
    expect(securityMaintenance('p', { total: 1, security: 1, packages: ['a'] }, now)?.severity).toBe('warning');
    expect(securityMaintenance('p', { total: 20, security: 20, packages: [] }, now)?.severity).toBe('critical');
    expect(releasesMaintenance('p', ['1', '2', '3', '4'], now)).toBeUndefined();
    expect(releasesMaintenance('p', ['1', '2', '3', '4', '5'], now)?.detail).toContain('1 old version is');
    const disk = (value: number) => [{ projectId: 'p', kind: 'disk' as const, value, unit: '%', ts: now }];
    expect(diskMaintenance('p', disk(84), now)).toBeUndefined();
    expect(diskMaintenance('p', disk(85), now)?.severity).toBe('warning');
    expect(diskMaintenance('p', disk(95), now)?.severity).toBe('critical');
    expect(certificateMaintenance('p', undefined, now)).toBeUndefined();
    expect(certificateMaintenance('p', 14, now)).toBeUndefined();
    expect(certificateMaintenance('p', 6, now)?.severity).toBe('warning');
    expect(certificateMaintenance('p', 1, now)?.detail).toContain('1 day');
    expect(certificateMaintenance('p', 2, now)?.severity).toBe('critical');
    expect(certificateMaintenance('p', -1, now)?.detail).toContain('expired');
  });
});

describe('Caddy access logs', () => {
  it('covers every fixture, ignores malformed lines, filters bots/assets and advances the newest cursor', () => {
    const empty = parseAccessLog(read('caddy', 'access-empty.jsonl'), undefined, 'p');
    expect(empty).toEqual({ buckets: [], nextCursor: undefined });
    const malformed = parseAccessLog(read('caddy', 'access-malformed-lines.jsonl'), undefined, 'p');
    expect(malformed.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(2);
    const normal = parseAccessLog(read('caddy', 'access-normal-500.jsonl'), undefined, 'p');
    expect(normal.buckets.length).toBeGreaterThan(0);
    expect(normal.buckets.every((bucket) => !/\.(?:js|css|png|svg)$/.test(bucket.path))).toBe(true);
    const rotated = parseAccessLog(read('caddy', 'access-rotated-boundary.jsonl'), undefined, 'p');
    expect(rotated.nextCursor).toBe('1790215546');
    expect(parseAccessLog(read('caddy', 'access-rotated-boundary.jsonl'), rotated.nextCursor, 'p').buckets).toEqual([]);
  });

  it('strips queries, hashes visitors and collapses paths after 200 per hour', () => {
    const lines = Array.from({ length: 202 }, (_, index) => JSON.stringify({ logger: 'http.log.access.x', msg: 'handled request', ts: 1_790_208_000 + index, request: { client_ip: `192.0.2.${index}`, uri: `/page-${index}?secret=no`, headers: { 'User-Agent': ['Browser'] } }, status: 200 })).join('\n');
    const parsed = parseAccessLog(lines, undefined, 'p');
    expect(parsed.buckets.some((bucket) => bucket.path === '(other)')).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain('192.0.2.');
    expect(parsed.buckets[0]?.path).not.toContain('?');
  });

  it('uses safe defaults for optional Caddy fields and ignores unrelated records', () => {
    const lines = [
      JSON.stringify({ logger: 'other', msg: 'handled request', ts: 1 }),
      JSON.stringify({ logger: 'http.log.access.x', msg: 'other', ts: 2 }),
      JSON.stringify({ logger: 'http.log.access.x', msg: 'handled request' }),
      JSON.stringify({ logger: 'http.log.access.x', msg: 'handled request', ts: 3, request: {} }),
      JSON.stringify({ logger: 'http.log.access.x', msg: 'handled request', ts: 4, request: { remote_ip: '192.0.2.1', uri: '/from-remote', headers: {} }, status: 201 }),
      JSON.stringify({ logger: 'http.log.access.x', msg: 'handled request', ts: 5, request: { uri: '/bot', headers: { 'User-Agent': ['fixture-bot'] } }, status: 200 }),
    ].join('\n');
    const parsed = parseAccessLog(lines, 'not-a-number');
    expect(parsed.buckets).toHaveLength(2);
    expect(parsed.buckets[0]).toMatchObject({ projectId: '', path: '/', status: 0, visitors: 1 });
    expect(parsed.nextCursor).toBe('5');
  });
});

describe('bad resource input', () => {
  it.each([
    ['boundaries', 'bad'],
    ['memory', ['bad', 'x', '1', 'x', 'x', 'x', '0', '---BD---', '1', '---BD---', '1', '---BD---', '1', '---BD---', '/dev/x 1 1 0 1% /'].join('\n')],
    ['load', ['Mem: 1 0 0 0 0 1', '---BD---', 'x', '---BD---', '1', '---BD---', '1', '---BD---', '/dev/x 1 1 0 1% /'].join('\n')],
    ['processors', ['Mem: 1 0 0 0 0 1', '---BD---', '1', '---BD---', '0', '---BD---', '1', '---BD---', '/dev/x 1 1 0 1% /'].join('\n')],
    ['uptime', ['Mem: 1 0 0 0 0 1', '---BD---', '1', '---BD---', '1', '---BD---', 'x', '---BD---', '/dev/x 1 1 0 1% /'].join('\n')],
    ['disk', ['Mem: 1 0 0 0 0 1', '---BD---', '1', '---BD---', '1', '---BD---', '1', '---BD---', 'bad'].join('\n')],
    ['memory', ['Mem: 0 0 0 0 0 0', '---BD---', '1', '---BD---', '1', '---BD---', '1', '---BD---', '/dev/x 1 1 0 1% /'].join('\n')],
    ['memory', ['Mem: 1 0 0 0 0 -1', '---BD---', '1', '---BD---', '1', '---BD---', '1', '---BD---', '/dev/x 1 1 0 1% /'].join('\n')],
    ['memory', ['Mem: 1 0 0 0 0 2', '---BD---', '1', '---BD---', '1', '---BD---', '1', '---BD---', '/dev/x 1 1 0 1% /'].join('\n')],
    ['disk', ['Mem: 1 0 0 0 0 1', '---BD---', '1', '---BD---', '1', '---BD---', '1', '---BD---', '/dev/x 1'].join('\n')],
  ])('throws ParseError for %s', (section, output) => {
    expect(() => parseResources(output, now, 'p')).toThrowError(ParseError);
    try { parseResources(output, now, 'p'); } catch (error) { expect((error as ParseError).section).toBe(section); }
  });
});

describe('TLS fixtures', () => {
  it.each([
    ['cert-valid-80d.json', 80],
    ['cert-expiring-6d.json', 6],
    ['cert-expired.json', -5],
  ])('reads %s', (file, days) => {
    const fixture = JSON.parse(read('tls', file)) as { valid_to: string };
    expect(certificateDaysLeft(fixture.valid_to, new Date('2026-09-25T12:00:00Z'))).toBe(days);
  });
  it('ignores an invalid certificate date', () => expect(certificateDaysLeft('bad')).toBeUndefined());
});
