import { describe, it, expect } from 'vitest';
import { filterAptPackages, APT_PACKAGE_ALLOWLIST } from './apt-allowlist.js';

describe('filterAptPackages', () => {
  it('keeps only allowlisted packages and reports the rest as dropped', () => {
    const result = filterAptPackages(['build-essential', 'nmap', 'libssl-dev', 'curl']);
    expect(result.allowed).toEqual(['build-essential', 'libssl-dev']);
    expect(result.dropped).toEqual(['nmap', 'curl']);
  });

  it('de-duplicates repeated package names', () => {
    const result = filterAptPackages(['build-essential', 'build-essential']);
    expect(result.allowed).toEqual(['build-essential']);
    expect(result.dropped).toEqual([]);
  });

  it('returns everything as dropped when nothing is on the allowlist', () => {
    const result = filterAptPackages(['nmap', 'wireshark']);
    expect(result.allowed).toEqual([]);
    expect(result.dropped).toEqual(['nmap', 'wireshark']);
  });

  it('handles an empty request', () => {
    expect(filterAptPackages([])).toEqual({ allowed: [], dropped: [] });
  });

  it('the allowlist is non-empty and every entry is a plausible apt package name', () => {
    expect(APT_PACKAGE_ALLOWLIST.length).toBeGreaterThan(0);
    for (const pkg of APT_PACKAGE_ALLOWLIST) {
      expect(pkg).toMatch(/^[a-z0-9][a-z0-9+.-]*$/);
    }
  });
});
