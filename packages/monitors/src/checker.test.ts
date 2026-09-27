import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSite, siteRequestOptions } from './http/checker.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))));

describe('checkSite', () => {
  it('routes HTTPS testbed domains to Docker while preserving Host and TLS server name', () => {
    expect(
      siteRequestOptions(new URL('https://static.bd.test/assets/style.css'), {
        tlsInsecure: true,
        testbedHttpsPort: 8443,
      }),
    ).toMatchObject({
      hostname: '127.0.0.1',
      port: 8443,
      servername: 'static.bd.test',
      path: '/assets/style.css',
      headers: { host: 'static.bd.test' },
      rejectUnauthorized: false,
    });
  });

  it('measures time to HTTP headers', async () => {
    const server = createServer((_request, response) => { response.writeHead(204); response.end(); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const result = await checkSite(`http://127.0.0.1:${port}`, { timeoutMs: 1_000 });
    expect(result.status).toBe(204);
    expect(result.responseMs).toBeGreaterThanOrEqual(0);
    expect(result.certDaysLeft).toBeUndefined();
  });

  it('returns status zero for an invalid or unreachable URL', async () => {
    expect((await checkSite('not a url')).status).toBe(0);
    expect((await checkSite('http://127.0.0.1:1', { timeoutMs: 50 })).status).toBe(0);
  });
});
