import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

export interface HttpProbeResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Every network dependency needs an interface + fake (CLAUDE.md). This is the one used for the
 * public HTTPS checks in proxy_and_https and release.ts's steps k. */
export interface HttpProbe {
  probe(url: string, timeoutMs: number): Promise<HttpProbeResult>;
}

/** 2xx/3xx counts as healthy everywhere this is used (per the brief's health-check steps). */
function isHealthyStatus(status: number): boolean {
  return status >= 200 && status < 400;
}

/** Real implementation: a single GET, no redirects followed (a redirect response is itself a
 * healthy 3xx per the brief's rule), self-signed/internal-CA certs accepted so testbed mode (which
 * uses `tls internal`) can be probed without installing Caddy's local root CA into this process. */
export const nodeHttpProbe: HttpProbe = {
  probe(url: string, timeoutMs: number): Promise<HttpProbeResult> {
    return new Promise((resolve) => {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        resolve({ ok: false, error: `Invalid URL: ${url}` });
        return;
      }
      const requester = target.protocol === 'http:' ? httpRequest : httpsRequest;
      const req = requester(
        target,
        { method: 'GET', timeout: timeoutMs, rejectUnauthorized: false },
        (res) => {
          res.resume(); // drain, we don't need the body
          const status = res.statusCode ?? 0;
          resolve({ ok: isHealthyStatus(status), status });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.end();
    });
  },
};

/**
 * BOB_DEPLOY_TESTBED mode (DEC-020): `*.bd.test` domains resolve to 127.0.0.1, but the Docker
 * testbed publishes Caddy's HTTPS on a mapped port (8443 for ubuntu2404), not 443. This probe sends
 * `https://<name>.bd.test/...` to 127.0.0.1:<httpsPort> with the real name as TLS server name and
 * Host header (what a browser with a hosts-file entry would do), and hands every other URL to
 * `fallback` unchanged, so it is safe to use for any flow in testbed mode.
 */
export function testbedHttpProbe(httpsPort: number, fallback: HttpProbe = nodeHttpProbe): HttpProbe {
  return {
    probe(url: string, timeoutMs: number): Promise<HttpProbeResult> {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return Promise.resolve({ ok: false, error: `Invalid URL: ${url}` });
      }
      if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.bd.test')) {
        return fallback.probe(url, timeoutMs);
      }
      return new Promise((resolve) => {
        const req = httpsRequest(
          {
            hostname: '127.0.0.1',
            port: httpsPort,
            path: `${parsed.pathname}${parsed.search}`,
            method: 'GET',
            servername: parsed.hostname,
            headers: { host: parsed.hostname },
            timeout: timeoutMs,
            rejectUnauthorized: false, // Caddy `tls internal`
          },
          (res) => {
            res.resume();
            const status = res.statusCode ?? 0;
            resolve({ ok: isHealthyStatus(status), status });
          },
        );
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', (err) => resolve({ ok: false, error: err.message }));
        req.end();
      });
    },
  };
}

export interface FakeHttpProbeScript {
  [urlOrPattern: string]: HttpProbeResult[];
}

/** A scripted fake for tests: queues one result per matching URL substring, consumed in order.
 * Falls back to `ok: false` if nothing was queued for a URL, rather than throwing, so an
 * unanticipated probe fails the assertion loudly instead of crashing the test. */
export class FakeHttpProbe implements HttpProbe {
  private readonly calls: string[] = [];
  private readonly queues: Map<string, HttpProbeResult[]>;

  constructor(script: FakeHttpProbeScript = {}) {
    this.queues = new Map(Object.entries(script));
  }

  get callLog(): readonly string[] {
    return this.calls;
  }

  probe(url: string): Promise<HttpProbeResult> {
    this.calls.push(url);
    for (const [pattern, queue] of this.queues) {
      if (url.includes(pattern) && queue.length > 0) {
        return Promise.resolve(queue.shift() as HttpProbeResult);
      }
    }
    return Promise.resolve({ ok: false, error: `FakeHttpProbe: no response queued for ${url}` });
  }
}
