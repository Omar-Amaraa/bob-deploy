import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostDeployEvent } from '@bob-deploy/contracts';
import { vercelProvider } from './vercel.js';

const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/hosts/vercel', import.meta.url));
function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8')) as T;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;

async function startFakeServer(handlers: Handler[]): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  let call = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const handler = handlers[Math.min(call, handlers.length - 1)];
      call += 1;
      if (!handler) {
        res.writeHead(500);
        res.end('no fake handler configured');
        return;
      }
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const openServers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(openServers.map((close) => close()));
  openServers.length = 0;
});

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function makeStaticOutput(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bd-vercel-'));
  tempDirs.push(dir);
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'index.html'), '<h1>hi</h1>');
  await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)');
  return dir; // exactly 2 files
}

describe('vercelProvider().supports()', () => {
  it('accepts static output and Vercel-buildable frameworks, rejects the rest', () => {
    const provider = vercelProvider();
    expect(provider.supports({ type: 'static', needsBackend: false, outputDir: 'dist' }).ok).toBe(true);
    expect(provider.supports({ type: 'node', framework: 'nextjs', needsBackend: false }).ok).toBe(true);
    expect(provider.supports({ type: 'node', framework: 'django', needsBackend: false }).ok).toBe(false);
    expect(provider.supports({ type: 'node', framework: 'nextjs', needsBackend: true }).ok).toBe(false);
  });
});

describe('vercelProvider().validateToken()', () => {
  it('reports the account name on a valid token', async () => {
    const server = await startFakeServer([(_req, res) => json(res, 200, fixture('validate-token-ok.json'))]);
    openServers.push(server.close);
    const provider = vercelProvider({ baseUrl: server.baseUrl });
    const result = await provider.validateToken('secret-token');
    expect(result).toEqual({ ok: true, accountName: 'ada-example' });
  });

  it('reports ok:false on a 401/403, without ever including the token in the message', async () => {
    const server = await startFakeServer([(_req, res) => json(res, 403, fixture('validate-token-401.json'))]);
    openServers.push(server.close);
    const provider = vercelProvider({ baseUrl: server.baseUrl });
    const result = await provider.validateToken('super-secret-token-value');
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('super-secret-token-value');
  });

  it('retries on 429 using X-RateLimit-Reset and eventually succeeds', async () => {
    const resetAt = Math.floor(Date.now() / 1000);
    const server = await startFakeServer([
      (_req, res) => json(res, 429, fixture('rate-limit-429.json'), { 'x-ratelimit-reset': String(resetAt) }),
      (_req, res) => json(res, 200, fixture('validate-token-ok.json')),
    ]);
    openServers.push(server.close);
    const provider = vercelProvider({ baseUrl: server.baseUrl });
    const result = await provider.validateToken('secret-token');
    expect(result.ok).toBe(true);
  });
});

describe('vercelProvider().deploy()', () => {
  it('runs preparing -> uploading -> building -> ready for a static site and never leaks the token', async () => {
    const outputDir = await makeStaticOutput();
    const server = await startFakeServer([
      (_req, res) => json(res, 200, {}), // upload file 1
      (_req, res) => json(res, 200, {}), // upload file 2
      (_req, res) => json(res, 200, fixture('create-deploy.json')), // POST /v13/deployments
      (_req, res) => json(res, 200, fixture('deploy-building.json')), // poll #1
      (_req, res) => json(res, 200, fixture('deploy-ready.json')), // poll #2 (ready)
    ]);
    openServers.push(server.close);
    const provider = vercelProvider({ baseUrl: server.baseUrl });

    const events: HostDeployEvent[] = [];
    for await (const event of provider.deploy({
      projectDir: outputDir,
      outputDir,
      token: 'super-secret-token-value',
      siteName: 'bob-demo',
      stack: { type: 'static', needsBackend: false, outputDir: '.' },
    })) {
      events.push(event);
    }

    expect(events.map((e) => e.phase)).toEqual(['preparing', 'uploading', 'building', 'ready']);
    expect(events.at(-1)?.url).toBe('https://bob-demo.vercel.app');
    for (const event of events) expect(event.message).not.toContain('super-secret-token-value');
  });

  it('yields an error event when the deployment ends in Vercel-reported error', async () => {
    const outputDir = await makeStaticOutput();
    const server = await startFakeServer([
      (_req, res) => json(res, 200, {}),
      (_req, res) => json(res, 200, {}),
      (_req, res) => json(res, 200, fixture('create-deploy.json')),
      (_req, res) => json(res, 200, fixture('deploy-error.json')),
    ]);
    openServers.push(server.close);
    const provider = vercelProvider({ baseUrl: server.baseUrl });

    const events: HostDeployEvent[] = [];
    for await (const event of provider.deploy({
      projectDir: outputDir,
      outputDir,
      token: 'tok',
      siteName: 'bob-demo',
      stack: { type: 'static', needsBackend: false, outputDir: '.' },
    })) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ phase: 'error', message: 'The build step failed' });
  });

  it('stops cleanly and yields no further events when aborted mid-upload', async () => {
    const outputDir = await makeStaticOutput();
    const server = await startFakeServer([
      (_req, res) => {
        void res; // never respond — the deploy call should be aborted before this resolves.
      },
    ]);
    openServers.push(server.close);
    const provider = vercelProvider({ baseUrl: server.baseUrl });
    const controller = new AbortController();
    controller.abort();

    const events: HostDeployEvent[] = [];
    for await (const event of provider.deploy(
      { projectDir: outputDir, outputDir, token: 'tok', siteName: 'bob-demo', stack: { type: 'static', needsBackend: false, outputDir: '.' } },
      controller.signal,
    )) {
      events.push(event);
    }
    expect(events.some((e) => e.phase === 'error')).toBe(false);
  });
});
