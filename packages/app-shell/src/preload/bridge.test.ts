import { describe, expect, it, vi } from 'vitest';
import { createBridge, type IpcRendererLike } from './bridge.js';

function fakeRenderer() {
  const invoke = vi.fn<(channel: string, payload?: unknown) => Promise<unknown>>(() =>
    Promise.resolve({ ok: true, data: undefined }),
  );
  const on = vi.fn<(channel: string, listener: (event: unknown, payload: unknown) => void) => void>();
  const removeListener =
    vi.fn<(channel: string, listener: (event: unknown, payload: unknown) => void) => void>();
  const renderer: IpcRendererLike = {
    invoke: (channel, payload) => invoke(channel, payload),
    on: (channel, listener) => {
      on(channel, listener);
    },
    removeListener: (channel, listener) => {
      removeListener(channel, listener);
    },
  };
  return { renderer, invoke, on, removeListener };
}

describe('preload bridge', () => {
  it('forwards contract channels and removes push listeners', async () => {
    const { renderer, invoke, on, removeListener } = fakeRenderer();
    const bridge = createBridge(renderer, { platform: 'linux', appVersion: '1.0.0', mock: true });
    const listener = vi.fn();

    await bridge.invoke('account:status', undefined);
    const remove = bridge.on('account:locked', listener);
    remove();

    expect(invoke).toHaveBeenCalledWith('account:status', undefined);
    expect(on).toHaveBeenCalledWith('account:locked', expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith('account:locked', expect.any(Function));
  });

  it('rejects unknown IPC channels at runtime', async () => {
    const { renderer } = fakeRenderer();
    const bridge = createBridge(renderer, {
      platform: 'win32',
      appVersion: '1.0.0',
      mock: true,
    });
    await expect(bridge.invoke('unknown:channel' as 'account:status', undefined)).rejects.toThrow(
      'not allowed',
    );
  });

  it.each(['http://example.com', 'file:///tmp/file', 'javascript:alert(1)'])(
    'blocks unsafe openExternal value %s',
    async (url) => {
      const { renderer, invoke } = fakeRenderer();
      const bridge = createBridge(renderer, {
        platform: 'darwin',
        appVersion: '1.0.0',
        mock: true,
      });
      await expect(bridge.openExternal(url)).rejects.toThrow('HTTPS');
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it('uses a private channel for HTTPS links', async () => {
    const { renderer, invoke } = fakeRenderer();
    const bridge = createBridge(renderer, { platform: 'linux', appVersion: '1.0.0', mock: true });
    await bridge.openExternal('https://example.com/help');
    expect(invoke).toHaveBeenCalledWith('shell:openExternal', 'https://example.com/help');
  });

  it('exposes viewer external-link notifications without exposing arbitrary events', () => {
    const { renderer, on, removeListener } = fakeRenderer();
    const bridge = createBridge(renderer, { platform: 'linux', appVersion: '1.0.0', mock: true });
    const remove = bridge.onViewerExternalOpened(vi.fn());
    remove();
    expect(on).toHaveBeenCalledWith('shell:viewerExternalOpened', expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith('shell:viewerExternalOpened', expect.any(Function));
  });

  it('clears viewer data through a private channel', async () => {
    const { renderer, invoke } = fakeRenderer();
    const bridge = createBridge(renderer, { platform: 'linux', appVersion: '1.0.0', mock: true });
    await bridge.clearViewerData();
    expect(invoke).toHaveBeenCalledWith('shell:clearViewerData', undefined);
  });
});
