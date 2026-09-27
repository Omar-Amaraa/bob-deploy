import { describe, expect, it } from 'vitest';
import {
  isTestbedSiteUrl,
  parseTestbedHttpsPort,
  testbedHostResolverRules,
} from './testbed-network.js';

describe('testbed viewer networking', () => {
  it('maps the reserved test domain to the Docker HTTPS port', () => {
    expect(testbedHostResolverRules(8443)).toBe('MAP *.bd.test 127.0.0.1:8443');
  });

  it.each([
    ['https://static.bd.test/', true],
    ['https://child.static.bd.test/path', true],
    ['http://static.bd.test/', false],
    ['https://static.bd.test.evil.example/', false],
    ['https://example.com/', false],
    ['not a URL', false],
  ])('recognises only HTTPS testbed site URLs: %s', (url, expected) => {
    expect(isTestbedSiteUrl(url)).toBe(expected);
  });

  it('validates the optional mapped HTTPS port', () => {
    expect(parseTestbedHttpsPort(undefined)).toBe(8443);
    expect(parseTestbedHttpsPort('8444')).toBe(8444);
    expect(parseTestbedHttpsPort('0')).toBe(8443);
    expect(parseTestbedHttpsPort('not-a-port')).toBe(8443);
  });
});
