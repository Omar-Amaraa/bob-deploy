import { describe, it, expect } from 'vitest';
import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { testbedHttpProbe, FakeHttpProbe } from './http-probe.js';

// The TLS side (SNI + Host against Caddy's `tls internal`) is covered for real by
// release.int.test.ts, which uses this same probe against the Docker testbed.
describe('testbedHttpProbe', () => {
  it('hands URLs that are not https://*.bd.test to the fallback unchanged', async () => {
    const fallback = new FakeHttpProbe({ 'example.com': [{ ok: true, status: 200 }] });
    const probe = testbedHttpProbe(1, fallback);
    await expect(probe.probe('https://example.com/', 1000)).resolves.toEqual({ ok: true, status: 200 });
    expect(fallback.callLog).toEqual(['https://example.com/']);
  });

  it('connects to 127.0.0.1:<httpsPort> for https://<name>.bd.test instead of port 443', async () => {
    let connections = 0;
    const server = createServer((sock: Socket) => {
      connections += 1;
      sock.destroy(); // not a TLS server: the probe just has to have dialled this port
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const fallback = new FakeHttpProbe({});
      const result = await testbedHttpProbe(port, fallback).probe('https://static.bd.test/', 2000);
      expect(result.ok).toBe(false);
      expect(connections).toBe(1);
      expect(fallback.callLog).toEqual([]);
    } finally {
      server.close();
    }
  });
});
