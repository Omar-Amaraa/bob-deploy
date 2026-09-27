import { describe, it, expect } from 'vitest';
import { testbedDnsResolver, sslipDomainFor, FakeDnsResolver } from './dns.js';

describe('sslipDomainFor', () => {
  it('turns dots into dashes and appends .sslip.io', () => {
    expect(sslipDomainFor('203.0.113.9')).toBe('203-0-113-9.sslip.io');
  });
});

describe('testbedDnsResolver', () => {
  it('resolves any *.bd.test hostname to 127.0.0.1', async () => {
    const resolver = testbedDnsResolver();
    expect(await resolver.resolveA('ubuntu2404.bd.test')).toEqual(['127.0.0.1']);
    expect(await resolver.resolveA('anything.bd.test')).toEqual(['127.0.0.1']);
  });

  it('falls through to the given fallback resolver for other hostnames', async () => {
    const fallback = new FakeDnsResolver({ 'example.com': ['198.51.100.1'] });
    const resolver = testbedDnsResolver(fallback);
    expect(await resolver.resolveA('example.com')).toEqual(['198.51.100.1']);
    expect(await resolver.resolveA('unknown.example.com')).toEqual([]);
  });
});
