import { describe, expect, it, vi } from 'vitest';
import { createIpcClient } from './client.js';
import type { IpcChannel, IpcTransport, PushEvent } from './ipc.js';
import type { Result } from './common.js';

function fakeTransport(invoke: (channel: IpcChannel, payload: unknown) => Promise<unknown>): IpcTransport {
  return {
    invoke,
    on: vi.fn((_event: PushEvent, _listener: (payload: unknown) => void) => () => {}),
  };
}

describe('createIpcClient', () => {
  it('resolves with the transport result on success', async () => {
    const transport = fakeTransport((channel, payload) => {
      expect(channel).toBe('projects:get');
      expect(payload).toEqual({ projectId: 'p1' });
      const data: Result<unknown> = {
        ok: true,
        data: {
          id: 'p1',
          name: 'My App',
          folderPath: '/x',
          createdAt: new Date().toISOString(),
          status: 'not_deployed',
        },
      };
      return Promise.resolve(data);
    });
    const client = createIpcClient(transport);

    const result = await client['projects:get']({ projectId: 'p1' });
    expect(result.ok).toBe(true);
  });

  it('passes an error result straight through', async () => {
    const transport = fakeTransport(() =>
      Promise.resolve({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } }),
    );
    const client = createIpcClient(transport);

    const result = await client['projects:get']({ projectId: 'missing' });
    expect(result).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
  });

  it('turns a malformed successful payload into an INTERNAL error in dev mode', async () => {
    const transport = fakeTransport(() =>
      Promise.resolve({ ok: true, data: { id: 'p1' /* missing required fields */ } }),
    );
    const client = createIpcClient(transport);

    const result = await client['projects:get']({ projectId: 'p1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
    }
  });

  it('does not validate output for channels without a registered output schema', async () => {
    const transport = fakeTransport(() => Promise.resolve({ ok: true, data: undefined }));
    const client = createIpcClient(transport);

    const result = await client['account:touch'](undefined);
    expect(result).toEqual({ ok: true, data: undefined });
  });

  it('wraps transport.on for push events', () => {
    const onSpy = vi.fn(() => () => {});
    const transport: IpcTransport = { invoke: vi.fn(), on: onSpy };
    const client = createIpcClient(transport);

    const listener = vi.fn();
    const unsubscribe = client.on('job:events', listener);
    expect(onSpy).toHaveBeenCalledWith('job:events', expect.any(Function));
    expect(typeof unsubscribe).toBe('function');
  });
});
