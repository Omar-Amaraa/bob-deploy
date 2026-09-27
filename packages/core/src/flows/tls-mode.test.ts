import { describe, it, expect } from 'vitest';
import { tlsModeForDomain } from './deploy-own-server.js';

describe('tlsModeForDomain', () => {
  it('uses Caddy internal certificates for testbed *.bd.test domains (no public CA can issue one)', () => {
    expect(tlsModeForDomain('static.bd.test')).toBe('internal');
  });
  it('uses real (ACME) certificates for every other domain, including the sslip.io fallback', () => {
    expect(tlsModeForDomain('example.com')).toBe('auto');
    expect(tlsModeForDomain('203-0-113-9.sslip.io')).toBe('auto');
    expect(tlsModeForDomain('bd.test.example.com')).toBe('auto');
  });
});
