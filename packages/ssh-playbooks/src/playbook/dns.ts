/**
 * DNS is an external dependency (per CLAUDE.md: "Every external dependency ... is behind an
 * interface with a fake"). `check_dns` (bootstrap step 2) uses this to look up a domain's A
 * records without depending on Node's `dns` module directly, so tests can substitute
 * `FakeDnsResolver` instead of making real lookups.
 */
export interface DnsResolver {
  /** Resolves a hostname's IPv4 (A record) addresses. Returns [] if there are none (NXDOMAIN or
   * no A records), never throws for an ordinary lookup failure. */
  resolveA(hostname: string): Promise<string[]>;
}

/** The real resolver, backed by Node's `dns/promises`. */
export function nodeDnsResolver(): DnsResolver {
  return {
    async resolveA(hostname: string): Promise<string[]> {
      const { resolve4 } = await import('node:dns/promises');
      try {
        return await resolve4(hostname);
      } catch {
        return [];
      }
    },
  };
}

/** A fake for tests and for BOB_DEPLOY_TESTBED mode, where the "server" is a container on a
 * private IP with no real DNS record pointing at it. */
export class FakeDnsResolver implements DnsResolver {
  constructor(private readonly records: Record<string, string[]>) {}

  resolveA(hostname: string): Promise<string[]> {
    return Promise.resolve(this.records[hostname] ?? []);
  }
}

/**
 * Testbed-mode resolver (DEC-020): every `*.bd.test` hostname (see `testbedTarget()`'s `domain`
 * field) resolves to 127.0.0.1 — the Docker testbed has no real DNS record pointing at it — and
 * anything else falls through to a real lookup (or another fallback resolver, in tests).
 */
export function testbedDnsResolver(fallback: DnsResolver = nodeDnsResolver()): DnsResolver {
  return {
    resolveA(hostname: string): Promise<string[]> {
      if (hostname.endsWith('.bd.test')) return Promise.resolve(['127.0.0.1']);
      return fallback.resolveA(hostname);
    },
  };
}

/**
 * Turns an IPv4 address into its sslip.io wildcard-DNS hostname, e.g. "203.0.113.9" ->
 * "203-0-113-9.sslip.io". sslip.io resolves any such name back to the embedded IP, so it's a
 * usable fallback "domain" when the user has no DNS record of their own (or doesn't want one)
 * pointing at the server yet.
 */
export function sslipDomainFor(ipv4: string): string {
  return `${ipv4.split('.').join('-')}.sslip.io`;
}
