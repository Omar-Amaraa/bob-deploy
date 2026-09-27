import { describe, it, expect } from 'vitest';
import { Redactor } from './redactor.js';

describe('Redactor — registered secrets and their encoded forms', () => {
  it('redacts the literal secret', () => {
    const r = new Redactor();
    r.add('correct-horse-battery-Staple-42');
    expect(r.redact('password is correct-horse-battery-Staple-42 today')).toBe('password is [hidden] today');
  });

  it('redacts base64, base64url, URL-encoded and JSON-escaped forms', () => {
    const r = new Redactor();
    const secret = 'super secret/value+here';
    r.add(secret);

    const b64 = Buffer.from(secret, 'utf8').toString('base64');
    const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const urlEncoded = encodeURIComponent(secret);
    const jsonEscaped = JSON.stringify(secret).slice(1, -1);

    expect(r.redact(`b64=${b64}`)).toBe('b64=[hidden]');
    expect(r.redact(`b64url=${b64url}`)).toBe('b64url=[hidden]');
    expect(r.redact(`url=${urlEncoded}`)).toBe('url=[hidden]');
    expect(r.redact(`json="${jsonEscaped}"`)).toBe('json="[hidden]"');
  });

  it('does not register encoded forms for very short secrets (< 6 chars) but still redacts the literal', () => {
    const r = new Redactor();
    r.add('ab1');
    expect(r.redact('token: ab1')).toBe('token: [hidden]');
  });

  it('prefers the longest match when one secret is a substring of another', () => {
    const r = new Redactor();
    r.add('short-secret');
    r.add('a-much-longer-short-secret-wrapper');
    const text = 'value=a-much-longer-short-secret-wrapper';
    expect(r.redact(text)).toBe('value=[hidden]');
  });

  it('redactDeep redacts strings nested in objects and arrays without mutating the input', () => {
    const r = new Redactor();
    r.add('sekrit-value-123456');
    const input = { a: 'contains sekrit-value-123456 here', b: [1, 'sekrit-value-123456', { c: 'clean' }] };
    const out = r.redactDeep(input);
    expect(out).toEqual({ a: 'contains [hidden] here', b: [1, '[hidden]', { c: 'clean' }] });
    expect(input.a).toContain('sekrit-value-123456'); // original untouched
  });
});

describe('Redactor — built-in patterns', () => {
  const r = new Redactor();

  it('redacts an OpenSSH private key block', () => {
    const block = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\ndef456\n-----END OPENSSH PRIVATE KEY-----';
    expect(r.redact(`key:\n${block}\ndone`)).toBe('key:\n[hidden]\ndone');
  });

  it('redacts Authorization: Bearer tokens', () => {
    expect(r.redact('Authorization: Bearer abc.def-ghi_123')).toBe('[hidden]');
  });

  it('redacts BOBSHELL_API_KEY and BOB_API_KEY assignments', () => {
    expect(r.redact('BOBSHELL_API_KEY=abcd1234')).toBe('[hidden]');
    expect(r.redact('BOB_API_KEY=abcd1234')).toBe('[hidden]');
  });

  it('redacts password=<x> and "password":"<x>"', () => {
    expect(r.redact('password=hunter2')).toBe('[hidden]');
    expect(r.redact('{"password":"hunter2"}')).toBe('{[hidden]}');
  });

  it('redacts netlify tokens', () => {
    expect(r.redact('token nfp_abc123XYZ')).toBe('token [hidden]');
  });

  it('redacts AWS-style access key IDs', () => {
    expect(r.redact('id=AKIAABCDEFGHIJKLMNOP')).toBe('id=[hidden]');
  });

  it('redacts generic long tokens following "token" or "key"', () => {
    expect(r.redact('api key: 0123456789abcdef0123456789abcdef01234567')).toBe('api [hidden]');
  });

  it('has no false positives on normal log lines', () => {
    const samples = [
      'Job 3f2 started for project my-app',
      'Deploying to Netlify (target: prod)',
      'SSH connection to 203.0.113.5 established',
      'Build finished in 4.2s',
      'Health check passed: HTTP 200',
      'User completed onboarding',
      'Vault loaded with 3 secrets',
      'Skipping step: already applied',
      'Retrying step 2 of 5',
      'Snapshot created: rel_2026_09_25',
    ];
    for (const s of samples) {
      expect(r.redact(s)).toBe(s);
    }
  });
});

describe('Redactor.assertNoSecrets', () => {
  it('throws an INTERNAL-coded error if a registered secret is present', () => {
    const r = new Redactor();
    r.add('leaked-secret-value');
    expect(() => r.assertNoSecrets('contains leaked-secret-value')).toThrowError();
    try {
      r.assertNoSecrets('contains leaked-secret-value');
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: string }).code).toBe('INTERNAL');
    }
  });

  it('does not throw when no secret is present', () => {
    const r = new Redactor();
    r.add('leaked-secret-value');
    expect(() => r.assertNoSecrets('nothing to see here')).not.toThrow();
  });
});
