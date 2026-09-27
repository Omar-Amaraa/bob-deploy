const DEFAULT_TESTBED_HTTPS_PORT = 8443;

export function parseTestbedHttpsPort(value: string | undefined): number {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? port
    : DEFAULT_TESTBED_HTTPS_PORT;
}

export function testbedHostResolverRules(httpsPort: number): string {
  return `MAP *.bd.test 127.0.0.1:${httpsPort}`;
}

export function isTestbedSiteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.toLowerCase().endsWith('.bd.test');
  } catch {
    return false;
  }
}
