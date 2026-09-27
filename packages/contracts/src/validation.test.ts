import { describe, expect, it } from 'vitest';
import {
  RESERVED_USERS,
  START_CMD_PATTERN,
  adminUserSchema,
  appSlugSchema,
  domainSchema,
  envKeySchema,
  isTestbedMode,
  ipv4Schema,
  portSchema,
  siteNameSchema,
  slugifyAppName,
  startCmdSchema,
} from './validation.js';

describe('domainSchema', () => {
  const valid = ['example.com', 'my-app.example.co', 'a.io', 'sub.domain.example.com', 'xn--fsq.com'];
  const invalid = [
    'EXAMPLE.COM', // must be lowercase
    'nodothere', // no dot
    '-example.com', // label cannot start with a dash
    'example-.com', // label cannot end with a dash
    'example.c', // TLD too short
    'example.1om', // TLD must be alphabetic
    '', // empty
    'a'.repeat(64) + '.com', // label too long
  ];

  it.each(valid)('accepts %s', (value) => {
    expect(domainSchema.safeParse(value).success).toBe(true);
  });

  it.each(invalid)('rejects %s', (value) => {
    expect(domainSchema.safeParse(value).success).toBe(false);
  });
});

describe('ipv4Schema', () => {
  const valid = ['1.2.3.4', '203.0.113.10', '198.51.100.1', '8.8.8.8'];
  const invalid = [
    '10.0.0.1', // 10/8 private
    '172.16.0.1', // 172.16/12 private
    '192.168.1.1', // 192.168/16 private
    '127.0.0.1', // loopback
    '0.0.0.0', // 0/8
    '256.1.1.1', // out of range
    '1.2.3', // too few octets
    '01.2.3.4', // leading zero
  ];

  it.each(valid)('accepts %s', (value) => {
    expect(ipv4Schema.safeParse(value).success).toBe(true);
  });

  it.each(invalid)('rejects %s', (value) => {
    expect(ipv4Schema.safeParse(value).success).toBe(false);
  });

  it('allows private ranges only in testbed mode', () => {
    expect(isTestbedMode()).toBe(false);
    process.env['BOB_DEPLOY_TESTBED'] = '1';
    try {
      expect(isTestbedMode()).toBe(true);
      expect(ipv4Schema.safeParse('10.0.0.5').success).toBe(true);
    } finally {
      delete process.env['BOB_DEPLOY_TESTBED'];
    }
  });
});

describe('portSchema', () => {
  it.each([1, 22, 80, 443, 65535])('accepts %d', (value) => {
    expect(portSchema.safeParse(value).success).toBe(true);
  });

  it.each([0, -1, 65536, 1.5, 100000])('rejects %d', (value) => {
    expect(portSchema.safeParse(value).success).toBe(false);
  });
});

describe('adminUserSchema', () => {
  const valid = ['deploy', 'app-user', 'bob2', 'my-admin', 'zzz'];
  const invalid = [
    'Deploy', // uppercase
    '1deploy', // starts with digit
    'ab', // too short
    'a'.repeat(33), // too long
    'root', // reserved
    'www-data', // reserved
    'bd-app', // reserved prefix
    'ubuntu', // reserved
  ];

  it.each(valid)('accepts %s', (value) => {
    expect(adminUserSchema.safeParse(value).success).toBe(true);
  });

  it.each(invalid)('rejects %s', (value) => {
    expect(adminUserSchema.safeParse(value).success).toBe(false);
  });

  it('lists every reserved user documented in the brief', () => {
    expect(RESERVED_USERS).toContain('root');
    expect(RESERVED_USERS).toContain('lxd');
    expect(RESERVED_USERS.length).toBe(35);
  });
});

describe('appSlugSchema', () => {
  it.each(['app', 'my-app-1', 'a1'])('accepts %s', (value) => {
    expect(appSlugSchema.safeParse(value).success).toBe(true);
  });
  it.each(['App', '1app', 'a', ''])('rejects %s', (value) => {
    expect(appSlugSchema.safeParse(value).success).toBe(false);
  });
});

describe('siteNameSchema', () => {
  it.each(['my-site', 'app123', 'a1b'])('accepts %s', (value) => {
    expect(siteNameSchema.safeParse(value).success).toBe(true);
  });
  it.each(['My-Site', '-leading', 'trailing-', 'ab'])('rejects %s', (value) => {
    expect(siteNameSchema.safeParse(value).success).toBe(false);
  });
});

describe('envKeySchema', () => {
  const valid = ['PORT', 'DATABASE_URL', '_PRIVATE', 'A', 'API_KEY_2'];
  const invalid = [
    'port', // lowercase
    '1KEY', // starts with digit
    'KEY-NAME', // dash not allowed
    'KEY NAME', // space not allowed
    '', // empty
    'A'.repeat(129), // too long
    'KEY.NAME', // dot not allowed
    'ké', // non-ascii
  ];

  it.each(valid)('accepts %s', (value) => {
    expect(envKeySchema.safeParse(value).success).toBe(true);
  });

  it.each(invalid)('rejects %s', (value) => {
    expect(envKeySchema.safeParse(value).success).toBe(false);
  });
});

describe('START_CMD_PATTERN / startCmdSchema', () => {
  const valid = [
    'npm run start',
    'npm start',
    'node server.js',
    'node ./dist/index.js',
    '.venv/bin/gunicorn app:app',
    '.venv/bin/uvicorn app:app --host 0.0.0.0 --port $PORT',
  ];
  const invalid = [
    'python app.py',
    'npm run start:prod',
    'node',
    '; rm -rf /',
    'node server.js && echo done',
    'npm run start; ls',
    '',
    'sh -c "node server.js"',
  ];

  it.each(valid)('accepts %s', (value) => {
    expect(START_CMD_PATTERN.test(value)).toBe(true);
    expect(startCmdSchema.safeParse(value).success).toBe(true);
  });

  it.each(invalid)('rejects %s', (value) => {
    expect(START_CMD_PATTERN.test(value)).toBe(false);
  });
});

describe('slugifyAppName', () => {
  it.each([
    ['My Cool App', 'my-cool-app'],
    ['  spaced out  ', 'spaced-out'],
    ['Already-Slug', 'already-slug'],
    ['123 Numbers First', 'app-123-numbers-first'],
    ['!!!', 'app'],
    ['Ünïcödé Name', 'n-c-d-name'],
  ])('slugifies %s -> %s', (input, expected) => {
    const result = slugifyAppName(input);
    expect(result).toBe(expected);
  });

  it('collapses repeated separators and trims to 31 characters', () => {
    const long = 'a'.repeat(50);
    const slug = slugifyAppName(long);
    expect(slug.length).toBeLessThanOrEqual(31);
    expect(slug.startsWith('a')).toBe(true);
  });

  it('never returns an empty string', () => {
    expect(slugifyAppName('')).toBe('app');
    expect(slugifyAppName('---')).toBe('app');
  });
});
