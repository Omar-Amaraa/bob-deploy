import { describe, it, expect } from 'vitest';
import type { HostDeployInput, StackInfo } from '@bob-deploy/contracts';
import { FakeHostProvider } from './host-provider.js';

const staticStack: StackInfo = { type: 'static', needsBackend: false };
const backendStack: StackInfo = { type: 'node', needsBackend: true };

describe('FakeHostProvider', () => {
  it('rejects a stack that needsBackend by default', () => {
    const provider = new FakeHostProvider('netlify');
    expect(provider.supports(staticStack)).toEqual({ ok: true });
    expect(provider.supports(backendStack).ok).toBe(false);
  });

  it('validateToken rejects an empty token and accepts a real-looking one', async () => {
    const provider = new FakeHostProvider();
    expect(await provider.validateToken('')).toMatchObject({ ok: false });
    expect(await provider.validateToken('tok_abc')).toMatchObject({ ok: true, accountName: 'fake-account' });
  });

  it('deploy() yields a preparing → uploading → building → ready sequence with a siteUrl', async () => {
    const provider = new FakeHostProvider();
    const input: HostDeployInput = {
      projectDir: '/tmp/staging',
      token: 'tok_abc',
      siteName: 'my-app',
      stack: staticStack,
    };
    const events = [];
    for await (const event of provider.deploy(input)) events.push(event);
    expect(events.map((e) => e.phase)).toEqual(['preparing', 'uploading', 'building', 'ready']);
    const ready = events.at(-1);
    expect(ready?.url).toBe('https://my-app.fake.dev');
    expect(ready?.siteId).toBeDefined();
  });

  it('deploy() stops yielding once the signal is aborted', async () => {
    const provider = new FakeHostProvider('netlify', {
      deployEvents: () => [
        { phase: 'preparing', message: 'a' },
        { phase: 'uploading', message: 'b' },
        { phase: 'ready', message: 'c' },
      ],
    });
    const controller = new AbortController();
    const events = [];
    for await (const event of provider.deploy(
      { projectDir: '/tmp', token: 't', siteName: 's', stack: staticStack },
      controller.signal,
    )) {
      events.push(event);
      if (event.phase === 'preparing') controller.abort();
    }
    expect(events).toHaveLength(1);
  });
});
