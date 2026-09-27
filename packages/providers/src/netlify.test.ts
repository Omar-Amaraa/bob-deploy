import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import type { HostDeployEvent } from '@bob-deploy/contracts';
import { netlifyProvider } from './netlify.js';

const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/hosts/netlify', import.meta.url));
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
  const dir = await mkdtemp(join(tmpdir(), 'bd-netlify-'));
  tempDirs.push(dir);
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'index.html'), '<h1>hi</h1>');
  await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)');
  return dir;
}

describe('netlifyProvider().supports()', () => {
  it('accepts static stacks and rejects everything else', () => {
    const provider = netlifyProvider();
    expect(provider.supports({ type: 'static', needsBackend: false, outputDir: 'dist' }).ok).toBe(true);
    expect(provider.supports({ type: 'node', needsBackend: false, outputDir: 'dist' }).ok).toBe(true);
    const rejected = provider.supports({ type: 'node', needsBackend: true });
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toMatch(/static sites only/);
  });
});

describe('netlifyProvider().validateToken()', () => {
  it('reports the account name on a valid token', async () => {
    const server = await startFakeServer([(_req, res) => json(res, 200, fixture('validate-token-ok.json'))]);
    openServers.push(server.close);
    const provider = netlifyProvider({ baseUrl: server.baseUrl });
    const result = await provider.validateToken('secret-token');
    expect(result).toEqual({ ok: true, accountName: 'Ada Example' });
  });

  it('reports ok:false on a 401, without ever including the token in the message', async () => {
    const server = await startFakeServer([(_req, res) => json(res, 401, fixture('validate-token-401.json'))]);
    openServers.push(server.close);
    const provider = netlifyProvider({ baseUrl: server.baseUrl });
    const result = await provider.validateToken('super-secret-token-value');
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('super-secret-token-value');
  });

  it('retries on 429 and eventually succeeds', async () => {
    const server = await startFakeServer([
      (_req, res) => json(res, 429, fixture('rate-limit-429.json'), { 'retry-after': '0' }),
      (_req, res) => json(res, 200, fixture('validate-token-ok.json')),
    ]);
    openServers.push(server.close);
    const provider = netlifyProvider({ baseUrl: server.baseUrl });
    const result = await provider.validateToken('secret-token');
    expect(result.ok).toBe(true);
  });
});

describe('netlifyProvider().deploy()', () => {
  it('runs the full preparing -> uploading -> building -> ready sequence and never leaks the token', async () => {
    const outputDir = await makeStaticOutput();
    const site = fixture<{ id: string }>('create-site.json');
    let uploadedZip: Buffer | undefined;
    const server = await startFakeServer([
      (_req, res) => json(res, 200, site), // POST /api/v1/sites
      (_req, res, body) => {
        uploadedZip = body;
        json(res, 200, fixture('deploy-uploading.json'));
      }, // POST .../deploys
      (_req, res) => json(res, 200, fixture('deploy-building.json')), // GET poll #1
      (_req, res) => json(res, 200, fixture('deploy-ready.json')), // GET poll #2 (ready)
    ]);
    openServers.push(server.close);
    const provider = netlifyProvider({ baseUrl: server.baseUrl });

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
    expect(events.at(-1)?.url).toBe('https://bob-demo.netlify.app');
    expect(uploadedZip).toBeDefined();
    const archive = await JSZip.loadAsync(uploadedZip as Buffer);
    expect(Object.keys(archive.files)).toEqual(expect.arrayContaining(['index.html', 'assets/app.js']));
    for (const event of events) expect(event.message).not.toContain('super-secret-token-value');
  });

  it('yields an error event when the deploy ends in Netlify-reported error', async () => {
    const outputDir = await makeStaticOutput();
    const server = await startFakeServer([
      (_req, res) => json(res, 200, fixture('create-site.json')),
      (_req, res) => json(res, 200, fixture('deploy-uploading.json')),
      (_req, res) => json(res, 200, fixture('deploy-error.json')),
    ]);
    openServers.push(server.close);
    const provider = netlifyProvider({ baseUrl: server.baseUrl });

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
    expect(events.at(-1)).toMatchObject({ phase: 'error', message: 'Deploy processing failed' });
  });

  it('stops cleanly and yields no further events when aborted mid-upload', async () => {
    const outputDir = await makeStaticOutput();
    const server = await startFakeServer([
      (_req, res) => json(res, 200, fixture('create-site.json')),
      (_req, res) => {
        // Never respond — the deploy call should be aborted before this resolves.
        void res;
      },
    ]);
    openServers.push(server.close);
    const provider = netlifyProvider({ baseUrl: server.baseUrl });
    const controller = new AbortController();

    const events: HostDeployEvent[] = [];
    const iterator = provider.deploy(
      { projectDir: outputDir, outputDir, token: 'tok', siteName: 'bob-demo', stack: { type: 'static', needsBackend: false, outputDir: '.' } },
      controller.signal,
    );
    for await (const event of iterator) {
      events.push(event);
      if (event.phase === 'uploading') controller.abort();
    }
    expect(events.some((e) => e.phase === 'error')).toBe(false);
  });
});
