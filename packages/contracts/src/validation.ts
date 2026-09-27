import { z } from 'zod';

/**
 * True when running inside the integration testbed, where the "server" is actually a container on a
 * private IP range. Read through `globalThis.process` (rather than importing `node:process`) so this
 * file also works when bundled for the renderer, where `process` may not exist at all.
 */
export function isTestbedMode(): boolean {
  return globalThis.process?.env?.['BOB_DEPLOY_TESTBED'] === '1';
}

const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const domainSchema = z
  .string()
  .max(253)
  .refine((value) => value === value.toLowerCase(), { message: 'Domain must be lowercase' })
  .refine((value) => value.includes('.'), { message: 'Domain must contain at least one dot' })
  .refine(
    (value) => {
      const labels = value.split('.');
      if (labels.length < 2) return false;
      if (!labels.every((label) => DOMAIN_LABEL.test(label))) return false;
      const tld = labels[labels.length - 1] ?? '';
      return /^[a-z]{2,}$/.test(tld);
    },
    { message: 'Domain is not a valid hostname' },
  );

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 10) return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 127) return true; // 127/8
  if (a === 0) return true; // 0/8
  return false;
}

function isValidOctet(part: string): boolean {
  if (part.length > 1 && part.startsWith('0')) return false; // no leading zeros, e.g. "01"
  const n = Number(part);
  return Number.isInteger(n) && n >= 0 && n <= 255;
}

export const ipv4Schema = z
  .string()
  .regex(IPV4_RE, 'Must be an IPv4 address')
  .refine(
    (value) => {
      const match = IPV4_RE.exec(value);
      if (!match) return false;
      return [match[1], match[2], match[3], match[4]].every((part) => isValidOctet(part as string));
    },
    { message: 'Each octet must be 0-255 with no leading zeros' },
  )
  .refine(
    (value) => {
      if (isTestbedMode()) return true;
      const match = IPV4_RE.exec(value);
      if (!match) return false;
      const octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])] as [
        number,
        number,
        number,
        number,
      ];
      return !isPrivateIpv4(octets);
    },
    { message: 'Private and loopback IP ranges are not allowed' },
  );

export const portSchema = z.number().int().min(1).max(65535);

export const RESERVED_USERS = [
  'root',
  'daemon',
  'bin',
  'sys',
  'sync',
  'games',
  'man',
  'lp',
  'mail',
  'news',
  'uucp',
  'proxy',
  'www-data',
  'backup',
  'list',
  'irc',
  'nobody',
  'syslog',
  'sshd',
  'caddy',
  'ubuntu',
  'admin',
  'debian',
  'messagebus',
  'systemd-network',
  'systemd-resolve',
  'systemd-timesync',
  '_apt',
  'uuidd',
  'tcpdump',
  'landscape',
  'pollinate',
  'fwupd-refresh',
  'usbmux',
  'lxd',
] as const;

export const adminUserSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{2,31}$/, 'Must start with a lowercase letter and be 3-32 characters')
  .refine((value) => !(RESERVED_USERS as readonly string[]).includes(value), {
    message: 'That user name is reserved by the system',
  })
  .refine((value) => !value.startsWith('bd-'), { message: 'User names starting with "bd-" are reserved' });

export const appSlugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,30}$/, 'Must start with a lowercase letter, 2-31 characters');

export const siteNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
    'Must be 3-63 characters, lowercase letters, digits and dashes',
  );

export const envKeySchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,127}$/, 'Must be an uppercase environment variable name');

export const envValueSchema = z
  .string()
  .max(32 * 1024, 'Value must be 32 KB or smaller')
  .refine((value) => !value.includes('\0'), { message: 'Value must not contain a NUL byte' })
  .refine((value) => !value.includes('\n') && !value.includes('\r'), {
    message: 'Value must not contain a newline',
  });

export const envRecordSchema = z.record(envKeySchema, envValueSchema);

export const START_CMD_PATTERN =
  /^(npm run start|npm start|node [A-Za-z0-9_./-]+|\.venv\/bin\/gunicorn [A-Za-z0-9_.:$ =-]+|\.venv\/bin\/uvicorn [A-Za-z0-9_.:$ =-]+)$/;

export const startCmdSchema = z.string().regex(START_CMD_PATTERN, 'Not a recognized start command');

/**
 * Turns a free-form project name into a valid `appSlugSchema` value:
 * lowercase, non [a-z0-9] runs collapse to a single '-', leading/trailing dashes trimmed, a 'app-'
 * prefix is added when the result would not start with a letter, and the result is cut to 31 chars.
 */
export function slugifyAppName(projectName: string): string {
  let slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length === 0 || !/^[a-z]/.test(slug)) {
    slug = `app-${slug}`.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  }
  if (slug.length === 0 || !/^[a-z]/.test(slug)) {
    slug = 'app';
  }
  return slug.slice(0, 31).replace(/-+$/g, '') || 'app';
}
