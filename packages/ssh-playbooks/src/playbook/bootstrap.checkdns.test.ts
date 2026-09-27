import { describe, it, expect } from 'vitest';
import { checkDnsStep } from './bootstrap.js';
import { FakeDnsResolver } from './dns.js';

describe('checkDnsStep', () => {
  it('accepts a domain whose A record already points at the server', async () => {
    const dns = new FakeDnsResolver({ 'example.com': ['203.0.113.9'] });
    const outcome = await checkDnsStep.run({
      domain: 'example.com',
      serverIp: '203.0.113.9',
      dns,
      useSslipFallback: true,
    });
    expect(outcome).toEqual({ ok: true, data: { domain: 'example.com', usedFallback: false } });
  });

  it('falls back to sslip.io when the domain does not resolve to the server yet and fallback is allowed', async () => {
    const dns = new FakeDnsResolver({ 'example.com': [] });
    const outcome = await checkDnsStep.run({
      domain: 'example.com',
      serverIp: '203.0.113.9',
      dns,
      useSslipFallback: true,
    });
    expect(outcome).toEqual({ ok: true, data: { domain: '203-0-113-9.sslip.io', usedFallback: true } });
  });

  it('fails with DNS_MISMATCH when the domain is wrong and fallback is disabled', async () => {
    const dns = new FakeDnsResolver({ 'example.com': ['198.51.100.1'] });
    const outcome = await checkDnsStep.run({
      domain: 'example.com',
      serverIp: '203.0.113.9',
      dns,
      useSslipFallback: false,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('DNS_MISMATCH');
      expect(outcome.message).toContain('198.51.100.1');
    }
  });

  it('fails with DNS_MISMATCH when the domain has no A record at all and fallback is disabled', async () => {
    const dns = new FakeDnsResolver({});
    const outcome = await checkDnsStep.run({
      domain: 'example.com',
      serverIp: '203.0.113.9',
      dns,
      useSslipFallback: false,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('does not have an A record');
  });

  it('goes straight to the sslip.io fallback when no domain is given and fallback is allowed', async () => {
    const dns = new FakeDnsResolver({});
    const outcome = await checkDnsStep.run({ serverIp: '203.0.113.9', dns, useSslipFallback: true });
    expect(outcome).toEqual({ ok: true, data: { domain: '203-0-113-9.sslip.io', usedFallback: true } });
  });

  it('fails with DNS_MISMATCH when no domain is given and fallback is disabled', async () => {
    const dns = new FakeDnsResolver({});
    const outcome = await checkDnsStep.run({ serverIp: '203.0.113.9', dns, useSslipFallback: false });
    expect(outcome).toMatchObject({ ok: false, code: 'DNS_MISMATCH' });
  });
});
